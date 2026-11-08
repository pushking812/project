"""OpenAI-совместимый вход поверх Ask (шаг 12): Base URL для Cline, Continue и OpenAI SDK.

Прокси не второй клиент Ask, а другой вход в то же ядро: запрос, ретраи, разбор SSE и
дочитывание обрыва делает server._ask_stream, здесь события только переводятся в формат OpenAI.

Переменные: PROXY_TOKEN (обязателен, не равен ASK_API_KEY), PROXY_HOST (127.0.0.1),
PROXY_PORT (8789), PROXY_MODEL (claude-sonnet-5-5), PROXY_TOOLS_BLOCK (знаков в каталоге
инструментов, 60000; при 25000 отбрасывались инструменты ask__*), PROXY_TOOL_RESULT (знаков
в одном результате инструмента, 20000). Ключ Ask берётся как в server.py
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
from ask_mcp.api_client import error_text as _api_error_text
from ask_mcp.config import local_api_url as _local_api_url
from ask_mcp.sse import sse_frames as _api_frames

MODELS = ("claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5")
DEFAULT_MODEL = "claude-sonnet-5-5"

LIMIT_SYSTEM = 20_000
LIMIT_HISTORY = 400
LIMIT_PROMPT = 100_000
LIMIT_TOOL_RESULT = int(os.environ.get("PROXY_TOOL_RESULT", "").strip() or 20_000)
LIMIT_TOOLS_BLOCK = int(os.environ.get("PROXY_TOOLS_BLOCK", "").strip() or 60_000)
# Крупнейшая живая схема родного инструмента — read_files, 1 475 знаков; плюс имя, разделители
# и 400 знаков описания ≈ 1 900. 2 200 берёт её целиком с запасом.
LIMIT_TOOL_LINE = 2_200
LIMIT_OLD_TOOL = 400    # старый результат инструмента (не из двух последних) в истории: начало и длина
LIMIT_OLD_ARG = 300     # старый вызов инструмента: каждая длинная строка в args (код, текст файла)
FOLDED_MARK = "[Earlier in this conversation, folded into notes]"  # слово в слово, как у сайта
_FOLDED_KEEP = 32
# Запрос резюме (как COMPACT_PROMPT оригинального клиента, /compact): без инструментов, до ~700 слов.
COMPACT_PROMPT = (
    "Write a summary of this task so far, to carry on from instead of the whole conversation, under these "
    "headings: Goal (what the person asked for, in their own words where it matters, and every later change "
    "of mind); Project (stack, structure, how to build, run and test it); Files (each file read, created or "
    "changed, and what changed in it); Commands and results (errors met and how they were fixed); Decisions "
    "(and why); Done so far; Still open (and the very next step). Keep exact file paths, names, commands, "
    "error messages and numbers. Use no tools. Write it in the language of the conversation, compact, at "
    "most about 700 words, and nothing else.")
COMPACT_PAUSE = 300.0   # после неудачного сжатия секунд не пробуем снова: каждая попытка тратит вопрос лимита
LIMIT_PIN = 4_000       # первое сообщение пользователя (задача), всегда в начале истории
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
    _write_line(json.dumps(log, ensure_ascii=False))


def _write_line(text: str) -> None:
    """Строка в stderr и, если задан PROXY_LOG_FILE, дописывается в файл (main() задаёт его по умолчанию)."""
    sys.stderr.write(text + "\n")
    sys.stderr.flush()
    path = os.environ.get("PROXY_LOG_FILE", "").strip()
    if path:
        try:
            with open(path, "a", encoding="utf-8") as f:
                f.write(text + "\n")
        except OSError as e:
            sys.stderr.write(f"не удалось записать в {path}: {e}\n")


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
    "В этом сеансе у вас ЕСТЬ инструменты: их каталог стоит в начале последнего сообщения пользователя. "
    "Вы работаете как агент. Чтобы вызвать инструмент, ответьте ТОЛЬКО одним "
    'JSON-объектом без пояснений: {"tool": "<имя>", "args": {...}}. За один ответ один вызов. '
    "Результат придёт следующим сообщением («Результат инструмента …»); тогда сразу делайте следующий вызов. "
    "Не пишите, что инструментов или доступа нет, и не предлагайте пользователю выполнить шаг самому. "
    "Когда задача решена или инструмент не нужен, ответьте обычным текстом."
    + _POLICY_TEXT[TOOL_POLICY]
)
TOOLS_HEADER = "Доступные инструменты:"

# Отказ модели вместо вызова («у меня нет инструментов / доступа»): признак для одного повтора запроса.
_REFUSAL = re.compile(
    r"нет (?:у меня )?(?:доступа|инструмент)|не могу (?:открыть|прочитать|вызвать|запустить|выполнить)|"
    r"инструментов (?:в этом чате )?(?:у меня )?нет|без доступа к (?:файл|команд)|"
    r"не могу (?:дочитать|продолжить)|вызвать инструменты .{0,30}не могу|дочитать .{0,30}не получится|"
    r"файл (?:обрывается|оборван)|не видел (?:разбор|остальн|продолжени)|"
    r"no (?:access|tools)|(?:can't|cannot|unable to) (?:access|call|run|open)", re.I)
_RETRY_NOTE = (
    "Ваш предыдущий ответ был ошибкой: инструменты из каталога РАБОТАЮТ, "
    "доступ к файлам и командам есть. Не отказывайтесь и не пишите, что инструментов нет. "
    'Ответьте ТОЛЬКО одним JSON-объектом {"tool": "<имя>", "args": {...}} для следующего шага задачи (например, прочитать недостающую часть файла).'
)

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


def _slim(schema, _props: bool = False):
    """Схема параметров без служебного: «title», «default: null», вариант null в anyOf/oneOf.

    Смысл схемы тот же: необязательность задаёт «required», а не null. PROXY_SLIM_SCHEMA=off отключает.
    """
    if isinstance(schema, list):
        return [_slim(x) for x in schema]
    if not isinstance(schema, dict):
        return schema
    if _props:  # словарь «имя свойства -> схема»: имена, даже «title», не трогаем
        return {k: _slim(v) for k, v in schema.items()}
    out = {}
    for k, v in schema.items():
        if k == "title" and isinstance(v, str):
            continue
        if k == "default" and v is None:
            continue
        out[k] = _slim(v, _props=(k in ("properties", "$defs", "definitions") and isinstance(v, dict)))
    for key in ("anyOf", "oneOf"):
        variants = out.get(key)
        if isinstance(variants, list):
            rest = [x for x in variants if not (isinstance(x, dict) and x.get("type") == "null")]
            if len(rest) == 1 and isinstance(rest[0], dict) and len(rest) < len(variants):
                del out[key]
                out = {**rest[0], **out}
            elif rest and len(rest) < len(variants):
                out[key] = rest
    return out


def _excluded(name: str, skip: tuple[str, ...]) -> bool:
    """MCP-имя («сервер__инструмент»): подстрока в имени сервера. Родное имя без «__»: только
    запись с «=» в начале, как префикс имени (=composio_ убирает composio_search_tools и т. п.)."""
    if "__" in name:
        server = name.split("__", 1)[0].lower()
        return any(s in server for s in skip if not s.startswith("="))
    return any(name.lower().startswith(s[1:]) for s in skip if s.startswith("=") and len(s) > 1)


def _dump_names(defs: list[tuple[str, str, object]], excluded: list[str]) -> None:
    """Имена и размеры инструментов, которые прислал клиент, — в файл (PROXY_TOOLS_DUMP, по умолчанию
    tools-seen.txt рядом с прокси; off отключает). Пишется только при смене набора имён."""
    path = os.environ.get("PROXY_TOOLS_DUMP", "").strip() or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "tools-seen.txt")
    if path.lower() == "off":
        return
    names = tuple(sorted(d[0] for d in defs))
    if _dump_names.last == names:
        return
    _dump_names.last = names
    rows = []
    for name, desc, params in sorted(defs, key=lambda d: d[0]):
        size = len(name) + len(desc[:400]) + len(json.dumps(params, ensure_ascii=False, separators=(",", ":")))
        rows.append(f"{size:6d}  {name}" + ("   [исключён]" if name in excluded else ""))
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"# {datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}: {len(defs)} инструментов от клиента, "
                    "размер = имя + описание + схема (знаков)\n" + "\n".join(rows) + "\n")
    except OSError:
        pass


_dump_names.last = None


def _tools_catalog(tools: list[dict]) -> tuple[str, int, list[str]]:
    """Каталог инструментов для начала prompt -> (текст, сколько вошло, имена отброшенных).

    Сначала родные инструменты клиента (имя без «__»), затем MCP. Строка: имя, параметры
    целиком, затем описание (до 400 знаков). Схема не режется: не влезший в
    LIMIT_TOOL_LINE инструмент пропускается целиком; так же инструмент, не влезший в остаток LIMIT_TOOLS_BLOCK, пропускается целиком.
    """
    defs = _tool_defs(tools)
    # Серверы, чьи инструменты в каталог не попадают: подстрока в части имени до «__» (cadcraft, wordcraft…).
    skip = tuple(p.strip().lower() for p in os.environ.get("PROXY_TOOL_EXCLUDE", "craft,=composio_,=team_").split(",") if p.strip())
    all_defs = defs
    if skip:
        defs = [d for d in defs if not _excluded(d[0], skip)]
    _dump_names(all_defs, [d[0] for d in all_defs if d not in defs])
    if os.environ.get("PROXY_SLIM_SCHEMA", "on").strip().lower() != "off":
        defs = [(n, d, _slim(p)) for n, d, p in defs]
    first = tuple(p.strip() for p in os.environ.get("PROXY_TOOL_FIRST", "ask__,ask-extra__,ask-office__").split(",") if p.strip())
    mcp = [d for d in defs if "__" in d[0]]
    defs = ([d for d in defs if "__" not in d[0]]
            + sorted((d for d in mcp if d[0].startswith(first)),   # MCP-сервер ask — перед остальными MCP
                     key=lambda d: next(i for i, p in enumerate(first) if d[0].startswith(p)))
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


def _old_result(text: str) -> str:
    """Старый результат инструмента: начало и длина. Файл модель при нужде прочтёт заново
    (как оригинальный клиент, который хранит в истории строку шагов, а не содержимое)."""
    if len(text) <= LIMIT_OLD_TOOL:
        return text
    return text[:LIMIT_OLD_TOOL] + f"{CUT} (всего {len(text)} знаков; нужно — прочитайте заново)"


def _shrink_args(args, limit: int = LIMIT_OLD_ARG):
    if isinstance(args, str):
        return _cut(args, limit)
    if isinstance(args, dict):
        return {k: _shrink_args(v, limit) for k, v in args.items()}
    if isinstance(args, list):
        return [_shrink_args(v, limit) for v in args]
    return args


def _call_text(lead: str, calls: list[tuple], short: bool) -> str:
    lines = [lead] if lead else []
    for name, args in calls:
        lines.append(json.dumps({"tool": name, "args": _shrink_args(args) if short else args},
                                ensure_ascii=False))
    return "\n".join(lines)


# Резюме, которым сервер свернул начало истории (событие folded): хеш первых n реплик -> (n, резюме).
# Следующий запрос с тем же началом получает короткую пару вместо n реплик, сервер не сворачивает заново.
_FOLDED: dict[str, tuple[int, str]] = {}


def _prefix_hash(history: list[dict], n: int) -> str:
    h = hashlib.sha256()
    for item in history[:n]:
        h.update(f"{item['role']}\0{item['text']}\0".encode())
    return h.hexdigest()


def _apply_folded(history: list[dict]) -> tuple[list[dict], int]:
    """-> (history, сколько реплик заменено резюме; 0 — ничего)."""
    for key, (n, summary) in reversed(list(_FOLDED.items())):
        if len(history) >= n and _prefix_hash(history, n) == key:
            pair = [{"role": "user", "text": FOLDED_MARK}, {"role": "assistant", "text": summary}]
            return pair + history[n:], n
    return history, 0


def _remember_folded(raw: list[dict], applied: int, folded) -> int | None:
    """Запоминает резюме сервера. count считается по отправленной истории; applied — сколько
    исходных реплик уже стояло за парой резюме в ней. -> число свёрнутых исходных реплик."""
    try:
        count, summary = int(folded["count"]), folded["summary"]
    except (KeyError, TypeError, ValueError):
        return None
    if not isinstance(summary, str) or not summary or count < 1:
        return None
    if applied:
        if count < 2:
            return None
        count = applied + count - 2
    if count > len(raw):
        return None
    _store_folded(raw, count, summary)
    return count


def _store_folded(raw: list[dict], count: int, summary: str) -> None:
    key = _prefix_hash(raw, count)
    _FOLDED.pop(key, None)
    _FOLDED[key] = (count, summary)
    while len(_FOLDED) > _FOLDED_KEEP:
        _FOLDED.pop(next(iter(_FOLDED)))


# ---------------------------------------------------------------- сжатие истории (как /compact)

_compact_block_until = 0.0


def _compact_threshold() -> int | None:
    """PROXY_COMPACT_AT: доля LIMIT_PROMPT (0.7 по умолчанию), с которой история сжимается; off — выключено."""
    raw = os.environ.get("PROXY_COMPACT_AT", "").strip().lower()
    if raw in ("off", "no", "false", "0"):
        return None
    try:
        share = float(raw) if raw else 0.7
    except ValueError:
        share = 0.7
    if not 0.1 <= share <= 0.95:
        share = 0.7
    return int(LIMIT_PROMPT * share)


def _compact_cut(raw: list[dict], stable_n: int) -> int:
    """Сколько первых реплик заменить резюме: не больше stable_n, дальше стоит реплика пользователя."""
    for n in range(min(stable_n, len(raw) - 2), 1, -1):
        if raw[n]["role"] == "user":
            return n
    return 0


async def _maybe_compact(ask_body: dict, tinfo: dict, model: str, key: str) -> int | None:
    """История перешла порог: один тихий запрос за резюме начала разговора (без инструментов).
    Две-три последние реплики остаются как есть. -> число замененных реплик или None.
    Неудача не страшна: история режется, как прежде; новую попытку делаем не раньше COMPACT_PAUSE."""
    global _compact_block_until
    limit = _compact_threshold()
    if not limit or time.monotonic() < _compact_block_until:
        return None
    size = len(ask_body["prompt"]) + sum(len(h["text"]) for h in ask_body.get("history") or [])
    if size < limit:
        return None
    raw = tinfo["raw_history"]
    n = _compact_cut(raw, tinfo["stable_n"])
    if not n or _prefix_hash(raw, n) in _FOLDED:
        return None
    st = _State()
    try:
        async for _ in _ask_stream({"prompt": COMPACT_PROMPT, "model": model, "history": raw[:n]},
                                   key + "-compact", st):
            pass
    except Exception:
        st = None
    summary = "".join(st.parts).strip() if st is not None else ""
    if not summary or not st.saw_done or _finish_reason(st) != "stop":
        _compact_block_until = time.monotonic() + COMPACT_PAUSE
        return None
    _store_folded(raw, n, summary)
    return n


def _build(messages: list, tools: list[dict] | None, model: str) -> tuple[dict, bool, dict]:
    """messages/tools -> (тело POST /v1/ask, флаг «что-то обрезано», сведения о каталоге инструментов)."""
    truncated = False
    tool_cut = False
    catalog, sent, dropped = (_tools_catalog(tools) if tools else ("", 0, []))
    if dropped:
        truncated = True
    systems: list[str] = []
    # Разговор идёт в поле history с настоящими ролями (user/assistant); в prompt — только новейшее
    # сообщение. Элемент: [роль, текст, это_результат_инструмента].
    entries: list[list] = []
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
            entries.append(["user", f"Результат инструмента {name}:\n{text}", True])
        elif role == "assistant":
            calls: list[tuple] = []
            for tc in m.get("tool_calls") or []:
                fn = (tc or {}).get("function") or {}
                call_names[(tc or {}).get("id")] = fn.get("name")
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = fn.get("arguments")
                calls.append((fn.get("name"), args))
            if text or calls:
                entries.append(["assistant", _call_text(text, calls, False), False, (text, calls)])
        else:
            entries.append(["user", text, False])

    # Старые шаги (кроме двух последних) ужимаются: результат — до начала и длины, вызов — без длинных
    # строк в args. Большие чтения и записи иначе вытесняют из истории задачу и прежние шаги.
    tool_idx = [i for i, e in enumerate(entries) if e[2]]
    for i in tool_idx[:-2]:
        entries[i][1] = _old_result(entries[i][1])
    call_idx = [i for i, e in enumerate(entries) if len(e) > 3 and e[3][1]]
    for i in call_idx[:-2]:
        entries[i][1] = _call_text(entries[i][3][0], entries[i][3][1], True)
    # Реплики до first_live уже в окончательном виде (позже они не меняются): их можно заменить резюме.
    live = tool_idx[-2:] + call_idx[-2:]
    first_live = min(live) if live else len(entries)
    # Новейшее сообщение уходит в prompt; если последним стоит ответ модели — просим продолжить.
    if entries and entries[-1][0] == "user":
        last_text = entries.pop()[1]
    else:
        last_text = "Продолжайте."
    # Первое сообщение пользователя (сама задача) всегда остаётся в начале истории.
    pin = _cut(entries[0][1], LIMIT_PIN) if entries and entries[0][0] == "user" and not entries[0][2] else ""
    if pin:
        entries = entries[1:]
    omitted = len(entries) > LIMIT_HISTORY - 4  # место под задачу, пометку и пару повтора
    if omitted:
        entries, truncated = entries[-(LIMIT_HISTORY - 4):], True

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

    # prompt = каталог инструментов (и спилл system) + новейшее сообщение; роли и правила в нём не метим.
    head = "".join(p + "\n\n" for p in (spill, catalog) if p)
    if len(head) + len(last_text) > LIMIT_PROMPT:
        last_text, truncated, omitted = _cut(last_text, max(LIMIT_PROMPT - len(head), 0)), True, True
    prompt = head + last_text
    budget = LIMIT_PROMPT - len(prompt) - len(OMIT) - 2 - (len(pin) + 2 if pin else 0)
    kept: list[list] = []
    total = 0
    for e in reversed(entries):
        if total + len(e[1]) + 2 > budget:
            if not kept and budget > 0:
                kept.append([e[0], _cut(e[1], budget), e[2]])
            omitted = True
            truncated = True
            break
        kept.append(e)
        total += len(e[1]) + 2
    kept.reverse()

    history = ([{"role": "user", "text": pin}] if pin else []) \
        + ([{"role": "user", "text": OMIT}] if omitted else []) \
        + [{"role": e[0], "text": e[1]} for e in kept]
    raw_history = history
    # Индексы реплик в raw_history совпадают с индексами в entries (задача и так стоит первой);
    # при обрезке истории (omitted) сдвиг неизвестен, сжатие не предлагаем.
    stable_n = 0 if omitted else max(0, min(first_live, len(raw_history) - 2))
    history, folded_applied = _apply_folded(history)
    body: dict = {"prompt": prompt or " ", "model": model}
    if history:
        body["history"] = history
    if system:
        body["system"] = system
    info = {"sent": sent, "dropped": len(dropped), "dropped_names": dropped[:5],
            "system_chars": len(system), "system_cut": bool(spill),
            "spill_chars": len(spill), "prompt_cut": omitted or tool_cut,
            "catalog_chars": len(catalog), "history_chars": total,
            "raw_history": raw_history, "folded_applied": folded_applied, "stable_n": stable_n}
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
    # «Читаю файл… {"tool": ...}»: вызов внутри текста — первый объект с ключом tool
    dec, pos = json.JSONDecoder(), s.find("{")
    while pos != -1:
        try:
            obj, end = dec.raw_decode(s, pos)
        except ValueError:
            pos = s.find("{", pos + 1)
            continue
        if isinstance(obj, dict) and isinstance(obj.get("tool"), str):
            return obj
        pos = s.find("{", end)
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
    # ~3 знака на токен: LIMIT_PROMPT знаков -> окно в токенах (клиенты читают context_length)
    ctx = LIMIT_PROMPT // 3
    data = [{"id": n, "object": "model", "created": 0, "owned_by": "ask-api",
             "context_length": ctx, "max_context": ctx} for n in MODELS]
    data.append({"id": "ask", "object": "model", "created": 0, "owned_by": "ask",
                 "context_length": ctx, "max_context": ctx})
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


# ---------------------------------------------------------------- режим code (опыт)
# PROXY_BACKEND=code: прокси не просит модель писать JSON-вызовы, а отдаёт задачу нашему серверу (/execute),
# который ведёт настоящий цикл /v1/code (инструменты модели выполняются в ASK_ROOT). Инструменты Cline
# в этом режиме не используются: он видит только текст. По умолчанию режим выключен (PROXY_BACKEND=ask).

def _backend() -> str:
    return "code" if os.environ.get("PROXY_BACKEND", "").strip().lower() == "code" else "ask"


_ENV_BLOCK = re.compile(r"<environment_details>.*?</environment_details>", re.S)
_TASK_TAG = re.compile(r"<task>\s*(.*?)\s*</task>", re.S)


def _task_text(content) -> str:
    """Текст сообщения пользователя без служебной обвязки Cline (<environment_details>, <task>)."""
    text = _ENV_BLOCK.sub("", _text(content)).strip()
    m = _TASK_TAG.search(text)
    return (m.group(1) if m else text).strip()


def _user_texts(messages: list) -> list[str]:
    return [t for m in messages if isinstance(m, dict) and m.get("role") == "user"
            for t in [_task_text(m.get("content"))] if t]


_SESSION_SEEN: dict[str, tuple[float, float]] = {}  # хеш первого текста -> (начало, последний запрос)
_SESSION_GAP = 3600.0  # пауза, после которой тот же первый текст считается новой задачей


def _code_session(texts: list[str]) -> str | None:
    """Одна задача Cline = одна сессия нашего сервера: id берётся от первого сообщения пользователя."""
    if not texts:
        return None
    key = hashlib.sha256(texts[0].encode("utf-8", "replace")).hexdigest()[:16]
    now = time.time()
    started, last = _SESSION_SEEN.get(key, (now, now))
    # тот же первый текст после долгой паузы и без продолжения диалога — новая задача
    if len(texts) == 1 and now - last > _SESSION_GAP:
        started = now
    _SESSION_SEEN[key] = (started, now)
    return f"cline-{key}-{time.strftime('%Y%m%d%H%M%S', time.gmtime(started))}"


_SESSION_USED: dict[str, dict] = {}  # id сессии -> {"week": потрачено единиц, "requests": число запросов}


async def _used_now() -> dict | None:
    """Сколько единиц лимита потрачено сейчас (GET /me нашего сервера): {"week", "window"}; при сбое None."""
    try:
        base = _local_api_url()
        async with httpx.AsyncClient(base_url=base, timeout=httpx.Timeout(3.0)) as client:
            r = await client.get("/me")
        if r.status_code != 200:
            return None
        lim = (r.json() or {}).get("limits") or {}
        week = (lim.get("week") or {}).get("used")
        window = (lim.get("session") or {}).get("used")
        out = {k: float(v) for k, v in (("week", week), ("window", window)) if isinstance(v, (int, float))}
        return out or None
    except (ValueError, httpx.HTTPError):
        return None


async def _note_used(log: dict, session: str | None, before: dict | None) -> None:
    """Пишет в лог расход запроса и итог по сессии Cline. Расход другого окна/задач в это же время попадёт сюда же."""
    if not before:
        return
    after = await _used_now()
    if not after:
        return
    delta = {k: round(after[k] - before[k], 4) for k in after if k in before and after[k] >= before[k]}
    if not delta:  # окно лимита сбросилось между замерами
        return
    log["used_delta"] = delta
    if session and "week" in delta:
        total = _SESSION_USED.setdefault(session, {"week": 0.0, "requests": 0})
        total["week"] = round(total["week"] + delta["week"], 4)
        total["requests"] += 1
        log["session_used"] = dict(total)


def _code_body(messages: list) -> dict | None:
    texts = _user_texts(messages)
    if not texts:
        return None
    body: dict = {"prompt": _cut(texts[-1], LIMIT_PROMPT)}
    session = _code_session(texts)
    # неизвестный id наш сервер превращает в новую сессию; дальше она сама помнит прошлые ходы
    if session:
        body["session_id"] = session
    mode = os.environ.get("PROXY_CODE_MODE", "").strip().lower()
    if mode in ("all", "edits", "plan"):
        body["mode"] = mode
    return body


async def _code_events(body: dict):
    """События POST /execute нашего сервера. Ошибки — AskError (до первого события — честный 502/429)."""
    try:
        base = _local_api_url()
    except ValueError as e:
        raise AskError(str(e)) from e
    timeout = httpx.Timeout(connect=10.0, read=120.0, write=60.0, pool=10.0)
    try:
        async with httpx.AsyncClient(base_url=base, timeout=timeout) as client:
            async with client.stream("POST", "/execute", json=body) as r:
                if r.status_code >= 400:
                    raise AskError(_api_error_text(r.status_code, await r.aread()))
                async for event, data, _ in _api_frames(r):
                    yield event, data
    except httpx.ConnectError as e:
        raise AskError(f"Наш сервер API не отвечает на {base}: запустите его (npm start) или смените "
                       f"PROXY_BACKEND на ask. ({type(e).__name__})") from e
    except httpx.HTTPError as e:
        raise AskError(f"Сетевая ошибка при обращении к нашему серверу API: {type(e).__name__}: {e}") from e


_TOOL_ARG_KEYS = {
    "read_file": ("path",), "write_file": ("path",), "edit_file": ("path",),
    "run_command": ("command",), "search": ("pattern",), "list_files": ("path",),
    "browser": ("url",),
}


def _tool_arg(name: str, args) -> str:
    """Главный аргумент вызова для строки в чате: путь, команда, шаблон. Содержимое файлов не показываем."""
    if not isinstance(args, dict):
        return ""
    for key in _TOOL_ARG_KEYS.get(name, ()):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            one = " ".join(value.split())
            return one if len(one) <= 80 else one[:77] + "..."
    return ""


def _done_summary(data: dict) -> str:
    """Итог по факту из done.steps: что сервер реально сделал на компьютере (не со слов модели)."""
    steps = [" ".join(str(s).split()) for s in (data.get("steps") or []) if str(s).strip()]
    if not steps:
        return ""
    shown = [s if len(s) <= 120 else s[:117] + "..." for s in steps[:20]]
    more = f"\n- … и ещё {len(steps) - 20}" if len(steps) > 20 else ""
    return "\n\nСделано на компьютере:\n" + "\n".join(f"- {s}" for s in shown) + more + "\n"


def _code_piece(event: str, data: dict, state: _State) -> str:
    """Что показать в чате по событию задачи ('' — ничего). Заодно копит ответ и расход в state."""
    if event == "delta":
        text = str(data.get("text") or "")
        state.parts.append(text)
        return text
    if event == "tool":
        ok = "" if data.get("ok", True) else " (отказ/сбой)"
        # наш сервер шлёт в событии только path; input есть у прямого потока сайта
        arg = _tool_arg(str(data.get("name") or ""), data.get("input") or {"path": data.get("path")})
        line = f"\n▸ {data.get('name')}{' ' + arg if arg else ''}{ok}\n"
        return line
    if event == "usage":
        state.usage = data
    elif event == "done":
        state.done = data
        return _done_summary(data)
    elif event == "error":
        msg = str(data.get("message") or data)
        state.parts.append(f"\n[ошибка задачи: {msg}]")
        return f"\n[ошибка задачи: {msg}]"
    return ""


async def _chat_code(request: Request, messages: list, stream: bool, model: str, key: str,
                     tools_n: int, t0: float):
    log = _new_log(request.url.path, stream, tools_n, key)
    log["backend"] = "code"
    state = _State()
    ids = _Ids(model)
    body = _code_body(messages)
    if body is None:
        _emit(log, None, t0, "http_400")
        return _error(400, "В сообщениях нет текста пользователя.")
    log["prompt_chars"] = len(body["prompt"])
    log["session"] = body.get("session_id")
    # Сообщение без <task> — вероятно служебное (напоминание Cline): пишем начало, чтобы узнать точные фразы.
    last_raw = next((_ENV_BLOCK.sub("", _text(m.get("content"))).strip() for m in reversed(messages)
                     if isinstance(m, dict) and m.get("role") == "user"), "")
    if last_raw and not _TASK_TAG.search(last_raw):
        log["no_task_tag"] = True
        log["prompt_head"] = " ".join(last_raw.split())[:200]
    await _slots.acquire()
    handed_over = False
    try:
        before = await _used_now()
        gen = _code_events(body)
        if not stream:
            chunks: list[str] = []
            async for event, data in gen:
                chunks.append(_code_piece(event, data, state))
            text = "".join(chunks).strip()
            await _note_used(log, body.get("session_id"), before)
            _emit(log, state, t0, "ok")
            return JSONResponse(ids.completion({"role": "assistant", "content": text}, "stop", state))
        # stream: первое событие читаем до ответа, чтобы ошибка соединения стала честным 502
        first = await gen.__anext__()

        async def pump():
            try:
                yield ids.chunk({"role": "assistant"})
                piece = _code_piece(*first, state)
                if piece:
                    yield ids.chunk({"content": piece})
                async for event, data in gen:
                    piece = _code_piece(event, data, state)
                    if piece:
                        yield ids.chunk({"content": piece})
                yield ids.chunk({}, "stop", {"usage": _usage(state), "x_ask": _x_ask(state)})
                yield _sse("[DONE]")
                await _note_used(log, body.get("session_id"), before)
                _emit(log, state, t0, "ok")
            except AskError as e:
                yield ids.chunk({"content": f"\n[ошибка: {e}]"}, "stop")
                yield _sse("[DONE]")
                _emit(log, state, t0, "ask_error")
            finally:
                await gen.aclose()
                _slots.release()

        handed_over = True
        return StreamingResponse(pump(), media_type="text/event-stream")
    except StopAsyncIteration:
        _emit(log, state, t0, "ask_error")
        return _error(502, "Наш сервер API закрыл поток без событий.", "ask_error", "api_error")
    except AskError as e:
        resp = _ask_error_response(e)
        _emit(log, state, t0, "http_429" if resp.status_code == 429 else "ask_error")
        return resp
    finally:
        if not handed_over:
            _slots.release()


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
    if _backend() == "code":
        return await _chat_code(request, messages, stream, model, key, len(tools), t0)
    ask_body, truncated, tinfo = _build(messages, tools or None, model)
    log = _new_log(request.url.path, stream, len(tools), key)
    _fill_log(log, ask_body, truncated, tinfo)
    log["folded"], log["compacted"] = None, None
    state = _State()
    ids = _Ids(model)

    await _slots.acquire()
    handed_over = False
    try:
        compacted = await _maybe_compact(ask_body, tinfo, model, key)
        if compacted:
            ask_body, truncated, tinfo = _build(messages, tools or None, model)
            _fill_log(log, ask_body, truncated, tinfo)
            log["compacted"] = compacted
        if stream and not tools:
            response = await _stream_plain(ask_body, key, state, ids, log, t0, tinfo)
            handed_over = True
            return response

        async for _ in _ask_stream(ask_body, key, state):
            pass
        text = "".join(state.parts)
        if tools:
            message, finish, tool, fallback = _classify(text, [d[0] for d in _tool_defs(tools)])
            log["tool"], log["fallback"] = tool, fallback
            log["fallback_reason"] = "no_call" if fallback else None
            if fallback and _REFUSAL.search(text):
                # модель отказалась («нет инструментов»): один раз повторяем с жёстким напоминанием
                # отказ входит в историю как ответ модели, замечание — новое сообщение пользователя
                retry_body = dict(ask_body)
                retry_body["history"] = list(ask_body.get("history") or []) + [
                    {"role": "user", "text": ask_body["prompt"]},
                    {"role": "assistant", "text": text or "…"}]
                retry_body["prompt"] = _RETRY_NOTE
                state = _State()
                async for _ in _ask_stream(retry_body, key + "-retry", state):
                    pass
                text = "".join(state.parts)
                message, finish, tool, fallback = _classify(text, [d[0] for d in _tool_defs(tools)])
                log["tool"], log["fallback"] = tool, fallback
                log["fallback_reason"] = ("retry_no_call" if fallback else "retry_ok")
            if finish == "stop":
                finish = _finish_reason(state)
        else:
            message, finish = {"role": "assistant", "content": text}, _finish_reason(state)
        _note_folded(log, state, tinfo)
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


def _fill_log(log: dict, ask_body: dict, truncated: bool, tinfo: dict) -> None:
    log["prompt_chars"] = len(ask_body["prompt"]) + sum(len(h["text"]) for h in ask_body.get("history") or [])
    log["truncated"] = truncated
    log["tools_sent"], log["tools_dropped"] = tinfo["sent"], tinfo["dropped"]
    log["tools_dropped_names"] = tinfo["dropped_names"]
    log["system_chars"], log["system_cut"] = tinfo["system_chars"], tinfo["system_cut"]
    log["spill_chars"], log["prompt_cut"] = tinfo["spill_chars"], tinfo["prompt_cut"]
    log["catalog_chars"], log["history_chars"] = tinfo["catalog_chars"], tinfo["history_chars"]
    log["folded_applied"] = tinfo["folded_applied"]


def _note_folded(log: dict, state: _State, tinfo: dict) -> None:
    """Сервер сжал историю (folded): запоминаем резюме и пишем число свёрнутых реплик в лог."""
    if state.folded:
        log["folded"] = _remember_folded(tinfo["raw_history"], tinfo["folded_applied"], state.folded)


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


async def _stream_plain(ask_body: dict, key: str, state: _State, ids: _Ids, log: dict, t0: float,
                        tinfo: dict | None = None):
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
            if tinfo is not None:
                _note_folded(log, state, tinfo)
            _emit(log, state, t0, status)

    return StreamingResponse(body(), media_type="text/event-stream")


async def _server_error(request: Request, exc: Exception):
    traceback.print_exception(exc)
    return _error(500, "Внутренняя ошибка прокси.", "internal_error", "api_error")


class _AccessLog:
    """Строка JSON на каждый входящий запрос (в том числе 401/404), до обработчиков.
    Токен и тело не пишутся. Отключается PROXY_ACCESS_LOG=off."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or os.environ.get("PROXY_ACCESS_LOG", "").strip().lower() == "off":
            await self.inner(scope, receive, send)
            return
        t0 = time.monotonic()
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        seen = {"status": None}

        async def wrapped_send(message):
            if message.get("type") == "http.response.start":
                seen["status"] = message.get("status")
            await send(message)

        def line(note: str) -> None:
            auth = headers.get("authorization", "")
            rec = {
                "access": True,
                "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "method": scope.get("method"), "path": scope.get("path"),
                "client": (scope.get("client") or ["?"])[0],
                "status": seen["status"], "auth_header": bool(auth),
                "token_ok": _authorized(Request(scope)) if auth else False,
                "content_length": headers.get("content-length"),
                "user_agent": headers.get("user-agent", "")[:60],
                "ms": int((time.monotonic() - t0) * 1000), "note": note,
            }
            _write_line(json.dumps(rec, ensure_ascii=False))

        try:
            await self.inner(scope, receive, wrapped_send)
        except BaseException as e:
            line(f"exception:{type(e).__name__}")
            raise
        line("")


app = Starlette(
    routes=[
        Route("/v1/chat/completions", chat, methods=["POST"]),
        Route("/v1/models", models, methods=["GET"]),
        Route("/v1/usage", usage, methods=["GET"]),
        Route("/healthz", healthz, methods=["GET"]),
    ],
    exception_handlers={Exception: _server_error},
)
app.add_middleware(_AccessLog)


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
    if "PROXY_LOG_FILE" not in os.environ:  # по умолчанию project/proxy.log; пустое значение отключает файл
        os.environ["PROXY_LOG_FILE"] = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                                    "proxy.log")
    print(f"ask OpenAI proxy http://{host}:{port}/v1, base url: {BASE_URL}, log: "
          f"{os.environ['PROXY_LOG_FILE'] or 'только stderr'}", file=sys.stderr)
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
