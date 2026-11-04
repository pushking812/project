"""OpenAI-совместимый вход поверх Ask (шаг 12): Base URL для Cline, Continue и OpenAI SDK.

Прокси не второй клиент Ask, а другой вход в то же ядро: запрос, ретраи, разбор SSE и
дочитывание обрыва делает server._ask_stream, здесь события только переводятся в формат OpenAI.

Переменные: PROXY_TOKEN (обязателен, не равен ASK_API_KEY), PROXY_HOST (127.0.0.1),
PROXY_PORT (8789), PROXY_MODEL (claude-sonnet-5-5), PROXY_TOOLS_BLOCK (знаков в каталоге
инструментов, 60000; при 25000 отбрасывались инструменты ask__*). Ключ Ask берётся как в server.py
(ASK_API_KEY или .env).
"""

import asyncio
import hashlib
import hmac
import json
import os
import re
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone

import anyio
import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from server import BASE_URL, TIMEOUT, AskError, _ask_stream, _headers, _State, get_usage

MODELS = ("claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5")
DEFAULT_MODEL = "claude-sonnet-5-5"

LIMIT_SYSTEM = 20_000
LIMIT_HISTORY = 400
LIMIT_PROMPT = 100_000
LIMIT_TOOL_RESULT = 8_000
LIMIT_TOOLS_BLOCK = int(os.environ.get("PROXY_TOOLS_BLOCK", "").strip() or 60_000)
# Крупнейшая живая схема родного инструмента — read_files, 1 475 знаков; плюс имя, разделители
# и 400 знаков описания ≈ 1 900. 2 200 берёт её целиком с запасом.
LIMIT_TOOL_LINE = 2_200
CUT = "[…обрезано]"
OMIT = "[…ранние сообщения опущены]"
STOP_WAIT = 2.0
_LOCAL_HOSTS = ("127.0.0.1", "::1", "localhost")

# Не больше двух ответов одновременно: третий ждёт здесь, а не в очереди сервера.
_slots = asyncio.Semaphore(2)


# ---------------------------------------------------------------- ответы и ошибки

def _error(status: int, message: str, code: str | None = None,
           etype: str = "invalid_request_error", headers: dict | None = None) -> JSONResponse:
    body = {"error": {"message": message, "type": etype, "code": code}}
    return JSONResponse(body, status_code=status, headers=headers)


def _sse(obj) -> str:
    payload = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return f"data: {payload}\n\n"


_RETRY_RE = re.compile(r"повторите через (\d+) с")
_QUOTA_RE = re.compile(r"(quota_exceeded|too_many_requests|rate_limited)\b")


def _ask_error_parts(e: Exception) -> tuple[int, str, dict]:
    """AskError -> (HTTP-статус для клиента, текст, заголовки)."""
    msg = str(e)
    if _QUOTA_RE.match(msg) or msg.startswith("HTTP 429"):
        headers = {}
        m = _RETRY_RE.search(msg)
        if m:
            headers["Retry-After"] = m.group(1)
        return 429, msg, headers
    return 502, msg, {}


def _ask_error_response(e: Exception) -> JSONResponse:
    status, msg, headers = _ask_error_parts(e)
    if status == 429:
        return _error(429, msg, "rate_limit_exceeded", "rate_limit_error", headers)
    return _error(502, msg, "ask_error", "api_error")


# ---------------------------------------------------------------- авторизация

def _authorized(request: Request) -> bool:
    token = os.environ.get("PROXY_TOKEN", "").strip()
    if not token or token == os.environ.get("ASK_API_KEY", "").strip():
        return False  # прокси без отдельного пароля никого не пускает
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        header = header[7:]
    return hmac.compare_digest(header.strip().encode(), token.encode())


def _denied() -> JSONResponse:
    return _error(401, "Неверный или отсутствующий токен прокси (PROXY_TOKEN).", "invalid_api_key")


# ---------------------------------------------------------------- лог

def _new_log(path: str, stream: bool, tools: int, key: str) -> dict:
    return {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "path": path, "stream": stream, "tools": tools,
        "idempotency_key_hash": hashlib.sha256(key.encode()).hexdigest()[:8],
        "run_id": None, "message_id": None, "fallback": False, "tool": None,
        "prompt_chars": 0, "answer_chars": 0, "truncated": False,
        "tools_sent": 0, "tools_dropped": 0, "tools_dropped_names": [],
        "system_chars": 0, "system_cut": False, "spill_chars": 0, "prompt_cut": False,
        "fallback_reason": None,
        "usage": None, "limits": None, "status": "ok", "ms": 0,
    }


def _emit(log: dict, state: _State | None, t0: float, status: str) -> None:
    """Одна строка JSON в stderr: только длины и имена, ни ключей, ни текста промпта."""
    if state is not None:
        u = state.usage or {}
        log["run_id"] = state.run_id
        log["message_id"] = (state.done or {}).get("messageId")
        log["answer_chars"] = len("".join(state.parts))
        log["usage"] = {"input": u.get("input"), "output": u.get("output"), "costUsd": u.get("costUsd")} \
            if state.usage else None
        log["limits"] = state.limits
    log["status"] = status
    log["ms"] = int((time.monotonic() - t0) * 1000)
    sys.stderr.write(json.dumps(log, ensure_ascii=False) + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- вход: сообщения -> запрос к Ask

def _cut(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(limit - len(CUT), 0)] + CUT


def _text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [p.get("text", "") if isinstance(p, dict) else str(p) for p in content]
        return "\n".join(p for p in parts if p)
    return str(content)


def _tool_defs(tools: list[dict]) -> list[tuple[str, str, object]]:
    out = []
    for t in tools:
        fn = t.get("function") if isinstance(t.get("function"), dict) else t
        name = fn.get("name")
        if isinstance(name, str) and name:
            out.append((name, str(fn.get("description") or ""), fn.get("parameters") or {}))
    return out


# Политика выбора инструмента (PROXY_TOOL_POLICY): родные инструменты клиента (Cline: execute_command,
# write_to_file, replace_in_file…) и MCP (имя с «__», например ask__…) делают разное.
#   ask    — для действия (запуск команды, правка файлов) при наличии обоих видов сначала спросить
#            пользователя, каким пользоваться (по умолчанию);
#   native — всегда родные инструменты клиента, MCP только если родного аналога нет;
#   mcp    — всегда MCP, где есть подходящий;
#   off    — без указаний.
_POLICY_TEXT = {
    "ask": (
        " Если нужно действие (запуск команды, создание или правка файлов) и доступны и инструменты "
        "клиента (имя без «__»), и MCP-инструменты (имя с «__»), не вызывайте инструмент сразу: "
        "коротко спросите пользователя обычным текстом, каким воспользоваться — инструментами клиента "
        "или MCP — и дождитесь ответа. Чтение и поиск не требуют вопроса. Если пользователь уже "
        "выбрал, больше не спрашивайте."
    ),
    "native": " Для действий используйте инструменты клиента (имя без «__»); MCP — только если аналога нет.",
    "mcp": " Для действий предпочитайте MCP-инструменты (имя с «__»), если среди них есть подходящий.",
    "off": "",
}
TOOL_POLICY = os.environ.get("PROXY_TOOL_POLICY", "ask").strip().lower()
if TOOL_POLICY not in _POLICY_TEXT:
    TOOL_POLICY = "ask"

TOOLS_PROTOCOL = (
    "Вы работаете как агент с инструментами. Чтобы вызвать инструмент, ответьте ТОЛЬКО одним "
    'JSON-объектом без пояснений: {"tool": "<имя>", "args": {...}}. За один ответ один вызов. '
    "Когда задача решена или инструмент не нужен, ответьте обычным текстом."
    + _POLICY_TEXT[TOOL_POLICY]
)
TOOLS_REMINDER = (
    "Напоминание: инструменты из каталога выше тебе доступны. Если для ответа нужно действие, "
    'ответь ТОЛЬКО одним JSON-объектом {"tool": "<имя>", "args": {...}}; не говори, что инструментов нет.'
    + (" Выбор инструмента — по правилам из system." if TOOL_POLICY != "off" else "")
)
TOOLS_HEADER = "Доступные инструменты:"

# Заметки проекта (ASK.md) для модели: читаются при каждом запросе, перезапуск после правки не нужен.
# PROXY_NOTES_FILE — путь к файлу (по умолчанию ASK.md в корне проекта, рядом с папкой mcp);
# PROXY_NOTES_CHARS — лимит знаков (по умолчанию 4000); PROXY_NOTES_FILE=off отключает.
_NOTES_DEFAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ASK.md")


def _notes_text() -> str:
    path = os.environ.get("PROXY_NOTES_FILE", "").strip() or _NOTES_DEFAULT
    if path.lower() == "off":
        return ""
    try:
        limit = int(os.environ.get("PROXY_NOTES_CHARS", "").strip() or 4000)
        with open(path, encoding="utf-8-sig") as f:
            text = f.read().strip()
    except (OSError, ValueError):
        return ""
    if not text:
        return ""
    if len(text) > limit:
        text = text[:limit] + "\n…(заметки обрезаны)"
    return "Заметки проекта (ASK.md):\n" + text


def _tools_catalog(tools: list[dict]) -> tuple[str, int, list[str]]:
    """Каталог инструментов для начала prompt -> (текст, сколько вошло, имена отброшенных).

    Сначала родные инструменты клиента (имя без «__»), затем MCP. Строка: имя, параметры
    целиком, затем описание (до 400 знаков). Схема не режется: не влезший в
    LIMIT_TOOL_LINE инструмент пропускается целиком; так же инструмент, не влезший в остаток LIMIT_TOOLS_BLOCK, пропускается целиком.
    """
    defs = _tool_defs(tools)
    # Серверы, чьи инструменты в каталог не попадают: подстрока в части имени до «__» (cadcraft, wordcraft…).
    skip = tuple(p.strip().lower() for p in os.environ.get("PROXY_TOOL_EXCLUDE", "craft").split(",") if p.strip())
    if skip:
        defs = [d for d in defs if "__" not in d[0] or not any(s in d[0].split("__", 1)[0].lower() for s in skip)]
    first = tuple(p.strip() for p in os.environ.get("PROXY_TOOL_FIRST", "ask__").split(",") if p.strip())
    mcp = [d for d in defs if "__" in d[0]]
    defs = ([d for d in defs if "__" not in d[0]]
            + [d for d in mcp if d[0].startswith(first)]   # MCP-сервер ask — перед остальными MCP
            + [d for d in mcp if not d[0].startswith(first)])
    lines = [TOOLS_HEADER]
    used = len(TOOLS_HEADER)
    dropped: list[str] = []
    for name, desc, params in defs:
        line = f"- {name} Параметры: {json.dumps(params, ensure_ascii=False, separators=(',', ':'))}"
        if len(line) > LIMIT_TOOL_LINE:  # схема не режется никогда: инструмент пропускается целиком
            dropped.append(name)
            continue
        desc = desc[:400]
        if desc:
            desc = desc[:max(LIMIT_TOOL_LINE - len(line) - 3, 0)]  # описание урезается первым
            if desc:
                line += f" — {desc}"
        if used + 1 + len(line) > LIMIT_TOOLS_BLOCK:
            dropped.append(name)
            continue
        lines.append(line)
        used += 1 + len(line)
    return "\n".join(lines), len(lines) - 1, dropped


def _build(messages: list, tools: list[dict] | None, model: str) -> tuple[dict, bool, dict]:
    """messages/tools -> (тело POST /v1/ask, флаг «что-то обрезано», сведения о каталоге инструментов)."""
    truncated = False
    tool_cut = False
    catalog, sent, dropped = (_tools_catalog(tools) if tools else ("", 0, []))
    if dropped:
        truncated = True
    systems: list[str] = []
    entries: list[str] = []
    call_names: dict = {}
    for m in messages:
        if not isinstance(m, dict):
            continue
        role, text = m.get("role"), _text(m.get("content"))
        if role in ("system", "developer"):
            systems.append(text)
        elif role == "tool":
            name = m.get("name") or call_names.get(m.get("tool_call_id")) or "tool"
            if len(text) > LIMIT_TOOL_RESULT:
                text, truncated, tool_cut = _cut(text, LIMIT_TOOL_RESULT), True, True
            entries.append(f"tool {name}: {text}")
        elif role == "assistant":
            lines = [text] if text else []
            for tc in m.get("tool_calls") or []:
                fn = (tc or {}).get("function") or {}
                call_names[(tc or {}).get("id")] = fn.get("name")
                lines.append(f"called {fn.get('name')} {fn.get('arguments') or '{}'}")
            entries.append("assistant: " + "\n".join(lines))
        else:
            entries.append(f"user: {text}")

    omitted = len(entries) > LIMIT_HISTORY
    if omitted:
        entries, truncated = entries[-LIMIT_HISTORY:], True

    # system: что не влезло в room, не теряется, а уходит в голову prompt (стабильное — первым).
    notes = _notes_text() if tools else ""
    protocol = (notes + "\n\n" + TOOLS_PROTOCOL if notes else TOOLS_PROTOCOL) if tools else ""
    sys_text = "\n\n".join(s for s in systems if s)
    room = LIMIT_SYSTEM - len(protocol) - (2 if protocol and sys_text else 0)
    spill = ""
    if len(sys_text) > room:
        spill = sys_text[max(room, 0) - len(CUT):] if room >= len(CUT) else sys_text
        # страховка: спилл не должен съесть всю историю; каталог инструментов тоже занимает
        # место в промпте, поэтому на историю всегда остаётся не меньше LIMIT_PROMPT // 5
        spill = spill[: max(0, min(LIMIT_PROMPT // 2, LIMIT_PROMPT - len(catalog) - LIMIT_PROMPT // 5))]
        sys_text, truncated = _cut(sys_text, max(room, 0)), True
    system = "\n\n".join(s for s in (sys_text, protocol) if s)

    # С инструментами напоминание стоит прямо перед местом ответа: протокол в system остаётся
    # далеко от конца длинной стенограммы, и модель продолжает её текстом прежних реплик.
    cue = ("\n\n" + TOOLS_REMINDER if tools else "") + "\n\nassistant:"
    head = "".join(p + "\n\n" for p in (spill, catalog) if p)
    budget = LIMIT_PROMPT - len(head) - len(OMIT) - 2 - len(cue)
    kept: list[str] = []
    total = 0
    for e in reversed(entries):
        if total + len(e) + 2 > budget:
            if not kept:
                kept.append(_cut(e, budget))
            omitted = True
            truncated = True
            break
        kept.append(e)
        total += len(e) + 2
    kept.reverse()

    if len(kept) == 1 and kept[0].startswith("user: ") and not omitted:
        prompt = kept[0][6:]
    else:
        prompt = ("\n\n".join([OMIT] if omitted else []) + ("\n\n" if omitted else "")
                  + "\n\n".join(kept) + cue)
    prompt = head + prompt

    body: dict = {"prompt": prompt or " ", "model": model}
    if system:
        body["system"] = system
    info = {"sent": sent, "dropped": len(dropped), "dropped_names": dropped[:5],
            "system_chars": len(system), "system_cut": bool(spill),
            "spill_chars": len(spill), "prompt_cut": omitted or tool_cut}
    return body, truncated, info


def _resolve_model(requested) -> str:
    if isinstance(requested, str):
        for name in MODELS:
            if name == requested.strip().lower():
                return name
    return os.environ.get("PROXY_MODEL", "").strip() or DEFAULT_MODEL


def _idempotency_key(request: Request) -> str:
    raw = request.headers.get("idempotency-key") or request.headers.get("x-request-id") or ""
    key = "".join(c for c in raw if c.isprintable())[:200].strip()
    return key or uuid.uuid4().hex


# ---------------------------------------------------------------- выход: ответ Ask -> OpenAI

_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S | re.I)


def _parse_call(text: str) -> dict | None:
    s = text.strip()
    candidates = [s]
    m = _FENCE.search(s)
    if m:
        candidates.insert(0, m.group(1))
    for c in candidates:
        try:
            obj = json.loads(c)
        except ValueError:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("tool"), str):
            return obj
    return None


def _classify(text: str, names: list[str]) -> tuple[dict, str, str | None, bool]:
    """Ответ модели при tools -> (message, finish_reason, имя инструмента, fallback)."""
    call = _parse_call(text)
    if call is None:
        return {"role": "assistant", "content": text}, "stop", None, True
    name = call["tool"]
    if name not in names:
        note = (f"Модель запросила неизвестный инструмент «{name}». "
                f"Доступные инструменты: {', '.join(names) or 'нет'}.")
        return {"role": "assistant", "content": note}, "stop", None, False
    args = call.get("args")
    tc = {"id": "call_" + uuid.uuid4().hex[:24], "type": "function",
          "function": {"name": name, "arguments": json.dumps(args if isinstance(args, dict) else {},
                                                              ensure_ascii=False)}}
    return {"role": "assistant", "content": None, "tool_calls": [tc]}, "tool_calls", name, False


def _usage(state: _State) -> dict:
    u = state.usage or {}
    i, o = int(u.get("input") or 0), int(u.get("output") or 0)
    return {"prompt_tokens": i, "completion_tokens": o, "total_tokens": i + o}


def _x_ask(state: _State) -> dict:
    return {"costUsd": (state.usage or {}).get("costUsd"), "limits": state.limits}


def _finish_reason(state: _State) -> str:
    return "length" if (state.done or {}).get("truncated") else "stop"


class _Ids:
    def __init__(self, model: str):
        self.id = "chatcmpl-" + uuid.uuid4().hex[:24]
        self.created = int(time.time())
        self.model = model

    def chunk(self, delta: dict, finish: str | None = None, extra: dict | None = None) -> str:
        d = {"id": self.id, "object": "chat.completion.chunk", "created": self.created,
             "model": self.model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        if extra:
            d.update(extra)
        return _sse(d)

    def completion(self, message: dict, finish: str, state: _State) -> dict:
        return {"id": self.id, "object": "chat.completion", "created": self.created,
                "model": self.model,
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": _usage(state), "x_ask": _x_ask(state)}


async def _stop_run(run_id: str | None) -> None:
    """Клиент ушёл: просим сервер остановить run, иначе он считает ответ ещё две минуты."""
    if not run_id:
        return
    try:
        async with httpx.AsyncClient(base_url=BASE_URL, timeout=TIMEOUT) as client:
            await client.post(f"/v1/runs/{run_id}/stop", headers=_headers())  # 204 и 404 — не ошибки
    except Exception:
        pass


# ---------------------------------------------------------------- обработчики

async def models(request: Request):
    if not _authorized(request):
        return _denied()
    data = [{"id": n, "object": "model", "created": 0, "owned_by": "ask-api"} for n in MODELS]
    data.append({"id": "ask", "object": "model", "created": 0, "owned_by": "ask"})
    return JSONResponse({"object": "list", "data": data})


async def usage(request: Request):
    if not _authorized(request):
        return _denied()
    try:
        return JSONResponse(json.loads(await get_usage()))
    except AskError as e:
        return _ask_error_response(e)


async def healthz(request: Request):
    return JSONResponse({
        "status": "ok", "base_url": BASE_URL,
        "ask_key_set": bool(os.environ.get("ASK_API_KEY", "").strip()),
        "proxy_token_set": bool(os.environ.get("PROXY_TOKEN", "").strip()),
    })


def _note_missing_key() -> None:
    if not os.environ.get("ASK_API_KEY", "").strip():
        print("ASK_API_KEY не задан: прокси не может обратиться к Ask. Задайте его в .env "
              "или в окружении и перезапустите прокси.", file=sys.stderr)


async def chat(request: Request):
    if not _authorized(request):
        return _denied()
    t0 = time.monotonic()
    try:
        body = await request.json()
    except Exception:
        body = None
    messages = body.get("messages") if isinstance(body, dict) else None
    if not isinstance(messages, list) or not messages:
        log = _new_log(request.url.path, False, 0, "")
        _emit(log, None, t0, "http_400")
        return _error(400, "Поле messages обязательно и должно быть непустым списком.")

    tools = [t for t in body.get("tools") or [] if isinstance(t, dict)] if isinstance(body.get("tools"), list) else []
    tools = tools if _tool_defs(tools) else []
    stream = bool(body.get("stream"))
    model = _resolve_model(body.get("model"))
    key = _idempotency_key(request)
    ask_body, truncated, tinfo = _build(messages, tools or None, model)
    log = _new_log(request.url.path, stream, len(tools), key)
    log["prompt_chars"] = len(ask_body["prompt"])
    log["truncated"] = truncated
    log["tools_sent"], log["tools_dropped"] = tinfo["sent"], tinfo["dropped"]
    log["tools_dropped_names"] = tinfo["dropped_names"]
    log["system_chars"], log["system_cut"] = tinfo["system_chars"], tinfo["system_cut"]
    log["spill_chars"], log["prompt_cut"] = tinfo["spill_chars"], tinfo["prompt_cut"]
    state = _State()
    ids = _Ids(model)

    await _slots.acquire()
    handed_over = False
    try:
        if stream and not tools:
            response = await _stream_plain(ask_body, key, state, ids, log, t0)
            handed_over = True
            return response

        async for _ in _ask_stream(ask_body, key, state):
            pass
        text = "".join(state.parts)
        if tools:
            message, finish, tool, fallback = _classify(text, [d[0] for d in _tool_defs(tools)])
            log["tool"], log["fallback"] = tool, fallback
            log["fallback_reason"] = "no_call" if fallback else None
            if finish == "stop":
                finish = _finish_reason(state)
        else:
            message, finish = {"role": "assistant", "content": text}, _finish_reason(state)
        status = "tool_calls" if log["tool"] else "ok"
        _emit(log, state, t0, status)
        if not stream:
            return JSONResponse(ids.completion(message, finish, state))
        return StreamingResponse(_canned_stream(ids, message, finish, state), media_type="text/event-stream")
    except AskError as e:
        _note_missing_key()
        resp = _ask_error_response(e)
        _emit(log, state, t0, "http_429" if resp.status_code == 429 else "ask_error")
        return resp
    except Exception:
        traceback.print_exc()
        _emit(log, state, t0, "http_500")
        return _error(500, "Внутренняя ошибка прокси.", "internal_error", "api_error")
    finally:
        if not handed_over:
            _slots.release()


async def _canned_stream(ids: _Ids, message: dict, finish: str, state: _State):
    """Ответ с tools уже получен целиком: отдаём его тремя чанками и [DONE]."""
    yield ids.chunk({"role": "assistant"})
    if message.get("tool_calls"):
        calls = [{"index": i, **tc} for i, tc in enumerate(message["tool_calls"])]
        yield ids.chunk({"tool_calls": calls})
    else:
        yield ids.chunk({"content": message.get("content") or ""})
    yield ids.chunk({}, finish, {"usage": _usage(state), "x_ask": _x_ask(state)})
    yield _sse("[DONE]")


async def _stream_plain(ask_body: dict, key: str, state: _State, ids: _Ids, log: dict, t0: float):
    """stream:true без tools: события _ask_stream переводятся в чанки OpenAI.

    До первого delta ошибка ещё может стать честным 502/429 (AskError уходит наверх),
    после — только чанком с error. Слот отпускается, когда закончится тело ответа.
    """
    agen = _ask_stream(ask_body, key, state)
    pending: list[tuple[str, dict]] = []
    try:
        async for event, data in agen:
            pending.append((event, data))
            if event in ("delta", "done"):
                break
    except BaseException:
        await agen.aclose()
        raise

    async def body():
        status, finished = "ok", False
        try:
            yield ids.chunk({"role": "assistant"})

            def translate(event: str, data: dict):
                if event == "delta":
                    return ids.chunk({"content": data.get("text", "")})
                return None

            for event, data in pending:
                out = translate(event, data)
                if out:
                    yield out
            if not state.saw_done:
                async for event, data in agen:
                    out = translate(event, data)
                    if out:
                        yield out
            finished = True
            yield ids.chunk({}, _finish_reason(state), {"usage": _usage(state), "x_ask": _x_ask(state)})
            yield _sse("[DONE]")
        except AskError as e:
            status = "http_429" if _ask_error_parts(e)[0] == 429 else "ask_error"
            finished = True
            yield _sse({"error": {"message": str(e), "type": "api_error", "code": "ask_error"}})
            yield _sse("[DONE]")
        except BaseException:
            status = "client_gone"
            raise
        finally:
            with anyio.move_on_after(STOP_WAIT, shield=True):
                if not finished:
                    await _stop_run(state.run_id)
                await agen.aclose()
            _slots.release()
            _emit(log, state, t0, status)

    return StreamingResponse(body(), media_type="text/event-stream")


async def _server_error(request: Request, exc: Exception):
    traceback.print_exception(exc)
    return _error(500, "Внутренняя ошибка прокси.", "internal_error", "api_error")


app = Starlette(
    routes=[
        Route("/v1/chat/completions", chat, methods=["POST"]),
        Route("/v1/models", models, methods=["GET"]),
        Route("/v1/usage", usage, methods=["GET"]),
        Route("/healthz", healthz, methods=["GET"]),
    ],
    exception_handlers={Exception: _server_error},
)


def main() -> None:
    import uvicorn

    token = os.environ.get("PROXY_TOKEN", "").strip()
    if not token or token == os.environ.get("ASK_API_KEY", "").strip():
        print("Задайте PROXY_TOKEN, отличный от ASK_API_KEY: это разные секреты — ключ Ask и пароль прокси.",
              file=sys.stderr)
        raise SystemExit(2)
    host = os.environ.get("PROXY_HOST", "").strip() or "127.0.0.1"
    if host not in _LOCAL_HOSTS:
        print(f"PROXY_HOST={host} открыл бы прокси всей сети: допустим только 127.0.0.1.", file=sys.stderr)
        raise SystemExit(2)
    raw_port = os.environ.get("PROXY_PORT", "").strip() or "8789"
    try:
        port = int(raw_port)
    except ValueError:
        print(f"PROXY_PORT должен быть числом, получено: {raw_port!r}", file=sys.stderr)
        raise SystemExit(2)
    print(f"ask OpenAI proxy http://{host}:{port}/v1, base url: {BASE_URL}", file=sys.stderr)
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
