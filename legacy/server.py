"""MCP-сервер для Ask API (https://ask.oryxml.com). Версия 1: ask и get_usage.

Ключ берётся из переменной окружения ASK_API_KEY (sk-ask-...).
Необязательно: ASK_BASE_URL (по умолчанию https://ask.oryxml.com).
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Annotated

import httpx
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

def _load_dotenv() -> None:
    """Читает .env рядом с server.py (KEY=VALUE). Уже заданные переменные не трогает."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and v and not os.environ.get(k):
                    os.environ[k] = v
    except OSError:
        pass


_load_dotenv()

BASE_URL = os.environ.get("ASK_BASE_URL", "https://ask.oryxml.com").rstrip("/")
TIMEOUT = httpx.Timeout(connect=15.0, read=300.0, write=60.0, pool=15.0)

_LOCAL_HOSTS = ("127.0.0.1", "::1", "localhost")


def _cli(argv: list[str]) -> argparse.Namespace:
    """Разбор флагов запуска: неизвестный аргумент — сообщение и код 2, --help — справка."""
    p = argparse.ArgumentParser(prog="server.py", description="MCP-сервер Ask API (по умолчанию stdio).")
    p.add_argument("--http", action="store_true", help="постоянный HTTP-сервер вместо stdio")
    p.add_argument("--host", help="адрес (по умолчанию ASK_HOST или 127.0.0.1)")
    p.add_argument("--port", type=int, help="порт (по умолчанию ASK_PORT или 8000)")
    args = p.parse_args(argv)
    if not args.http and (args.host or args.port is not None):
        p.error("--host и --port работают только вместе с --http")
    return args


def _bind_settings(host: str | None = None, port: int | None = None) -> tuple[str, int]:
    """ASK_HOST/ASK_PORT (или --host/--port) -> (host, port). Внешний bind без ASK_ALLOW_REMOTE запрещён."""
    host = host or os.environ.get("ASK_HOST") or "127.0.0.1"
    if port is None:
        raw_port = os.environ.get("ASK_PORT") or "8000"
        try:
            port = int(raw_port)
        except ValueError:
            print(f"ASK_PORT должен быть числом, получено: {raw_port!r}", file=sys.stderr)
            raise SystemExit(2)
    if not 1 <= port <= 65535:
        print(f"Порт должен быть в диапазоне 1..65535, получено: {port}", file=sys.stderr)
        raise SystemExit(2)
    allow = os.environ.get("ASK_ALLOW_REMOTE", "").strip().lower() in ("1", "true", "yes")
    if host not in _LOCAL_HOSTS and not allow:
        print(
            f"ASK_HOST={host} открыл бы сервер всей сети: любой в ней потратит ваш лимит.\n"
            "Оставьте 127.0.0.1 или задайте ASK_ALLOW_REMOTE=1 осознанно.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return host, port


# Адрес и порт известны до конструктора: защита от DNS-rebinding строится по ним.
# Разбор нужен только для --http; в stdio и в тестах переменные ASK_HOST/ASK_PORT не читаются.
# Строго разбираем argv только при запуске как скрипта; при импорте (тесты, python -c)
# argv чужой, там распознаётся лишь --http.
_ARGS = _cli(sys.argv[1:]) if __name__ == "__main__" else _cli(["--http"] if "--http" in sys.argv else [])
_HOST, _PORT = _bind_settings(_ARGS.host, _ARGS.port) if _ARGS.http else ("127.0.0.1", 8000)

mcp = FastMCP("ask", host=_HOST, port=_PORT)


class AskError(Exception):
    """Понятная ошибка, которую увидит клиент MCP."""


class _StreamError(AskError):
    """Ошибка из event: error; retryable — флаг сервера."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class AskResult(BaseModel):
    """Результат ask: текст ответа плюс расход и лимиты из потока."""

    answer: str
    usage: dict | None = None
    limits: dict | None = None
    folded: dict | None = None  # история сжата сервером: {summary, count}
    runId: str | None = None
    messageId: str | None = None

    def __eq__(self, other):
        # Совместимость: раньше ask возвращал строку, answer равен ей.
        if isinstance(other, str):
            return self.answer == other
        return super().__eq__(other)

    __hash__ = None


@dataclass
class _State:
    parts: list[str] = field(default_factory=list)
    run_id: str | None = None
    done: dict | None = None
    usage: dict | None = None
    limits: dict | None = None
    folded: dict | None = None
    last_id: str | None = None
    saw_done: bool = False


def _headers(extra: dict | None = None) -> dict:
    key = os.environ.get("ASK_API_KEY", "").strip()
    if not key:
        raise AskError("Не задана переменная окружения ASK_API_KEY (ключ вида sk-ask-...).")
    h = {"Authorization": f"Bearer {key}"}
    if extra:
        h.update(extra)
    return h


def _http_error_text(status: int, body: bytes, headers: httpx.Headers) -> str:
    try:
        err = json.loads(body).get("error", {})
        text = f"{err.get('code', status)}: {err.get('message', '')}".strip()
        if err.get("retryAt"):
            text += f" (не раньше {err['retryAt']})"
    except Exception:
        text = f"HTTP {status}: {body[:300].decode('utf-8', 'replace')}"
    retry = headers.get("Retry-After")
    if retry:
        text += f" (повторите через {retry} с)"
    return text


def _parse_event(event: str, data: list[str]) -> tuple[str, dict] | None:
    if not data:
        return None
    try:
        payload = json.loads("\n".join(data))
    except json.JSONDecodeError:
        return None
    # payload бывает числом, строкой или null — вызывающий читает его через .get().
    return (event, payload) if isinstance(payload, dict) else None


async def _sse_frames(response: httpx.Response):
    """Разбирает SSE: отдаёт тройки (event, data_json, event_id).

    event_id «залипает»: блок без id: наследует предыдущий; не было ни одного — None.
    """
    event, data, event_id = "message", [], None
    async for line in response.aiter_lines():
        if line == "":
            parsed = _parse_event(event, data)
            if parsed:
                yield parsed[0], parsed[1], event_id
            event, data = "message", []
        elif line.startswith(":"):
            continue  # heartbeat
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif line.startswith("id:"):
            event_id = line[3:].strip()
    # Поток мог закрыться без завершающей пустой строки: не теряем последнее событие.
    parsed = _parse_event(event, data)
    if parsed:
        yield parsed[0], parsed[1], event_id


async def _sse_events(response: httpx.Response):
    """Разбирает SSE: отдаёт пары (event, data_json)."""
    async for event, data, _ in _sse_frames(response):
        yield event, data


async def _gone_text(client: httpx.AsyncClient, run_id: str, status: int, body: bytes) -> str:
    """Текст для 404/410 на events: спрашиваем GET /v1/runs/{id}, что стало с run."""
    try:
        code = json.loads(body)["error"]["code"]
    except Exception:
        code = None
    if status == 410:
        head = f"События ответа больше недоступны (410{' ' + code if code else ''})."
    else:
        head = "События ответа убраны (404)."
    info: dict = {}
    try:
        rr = await client.get(f"/v1/runs/{run_id}", headers=_headers())
        if rr.status_code < 400 and isinstance(rr.json(), dict):
            info = rr.json()
    except (httpx.HTTPError, ValueError):
        pass
    bits = []
    if info.get("status"):
        bits.append(f"Статус run: {info['status']}")
    if info.get("endedBy"):
        bits.append(f"endedBy: {info['endedBy']}")
    if info.get("errorCode"):
        bits.append(f"errorCode: {info['errorCode']}")
    if info.get("messageId"):
        bits.append(f"messageId: {info['messageId']}")
    if bits:
        head += " " + ", ".join(bits) + "."
    return head + "\nТекст восстановить нельзя."


async def _resume(client: httpx.AsyncClient, run_id: str, last_id: str | None, state: _State):
    """Дочитывает run: GET /v1/runs/{id}/events с Last-Event-ID; отдаёт (event, data)."""
    headers = _headers({"Accept": "text/event-stream"})
    keep: list[str] | None = None
    if last_id is not None and str(last_id).isdigit():
        headers["Last-Event-ID"] = str(last_id)
    else:
        # Без Last-Event-ID сервер повторит поток с начала: не задваиваем уже полученное.
        keep = list(state.parts)
        state.parts.clear()

    def restore() -> None:
        if keep is not None and not state.saw_done and len("".join(keep)) > len("".join(state.parts)):
            state.parts[:] = keep

    def partial() -> str:
        restore()
        return "\n\nЧастичный ответ:\n" + "".join(state.parts) if state.parts else ""

    try:
        async with client.stream("GET", f"/v1/runs/{run_id}/events", headers=headers) as r:
            if r.status_code >= 400:
                body = await r.aread()
                if r.status_code in (404, 410):
                    text = await _gone_text(client, run_id, r.status_code, body)
                else:
                    text = _http_error_text(r.status_code, body, r.headers)
                raise AskError(text + partial())
            async for event, data, event_id in _sse_frames(r):
                if event_id is not None:
                    state.last_id = event_id
                _handle(event, data, state)
                yield event, data
                if state.saw_done:
                    return
    finally:
        restore()


def _handle(event: str, data: dict, state: _State) -> None:
    """Единая обработка событий потока; error пробрасывается как AskError."""
    if event == "status":
        state.run_id = state.run_id or data.get("runId")
    elif event == "delta":
        state.parts.append(data.get("text", ""))
    elif event == "usage":
        state.usage = data
    elif event == "limits":
        state.limits = data
    elif event == "folded":
        state.folded = data
    elif event == "done":
        state.done = data
        state.saw_done = True
    elif event == "error":
        msg = f"{data.get('code')}: {data.get('message')}"
        if data.get("retryable"):
            msg += " (можно повторить)"
        if data.get("retryAt"):
            msg += f" (не раньше {data['retryAt']})"
        lim = state.limits or {}
        if "used" in lim and "limit" in lim:
            msg += f" (использовано {lim['used']} из {lim['limit']})"
        if state.parts:
            msg += "\n\nЧастичный ответ:\n" + "".join(state.parts)
        raise _StreamError(msg, retryable=bool(data.get("retryable")))


_MAX_ATTEMPTS = 4
_RETRY_PAUSES = (1, 2, 4, 8)
_MAX_RETRY_AFTER = 10
_RETRYABLE_NETWORK = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.RemoteProtocolError,
    httpx.PoolTimeout,
)
_RETRYABLE_HTTP = {(503, "restarting"), (500, "internal"), (429, "too_many_requests")}


def _http_failure(status: int, body: bytes, headers: httpx.Headers) -> tuple[AskError, bool, int | None]:
    """Ответ >= 400 на POST: (ошибка, повторять ли, пауза из Retry-After)."""
    try:
        code = json.loads(body).get("error", {}).get("code")
    except Exception:
        code = None
    retriable = (status, code) in _RETRYABLE_HTTP
    pause = None
    retry_after = headers.get("Retry-After", "").strip()
    if retriable and status in (503, 429) and retry_after.isdigit():
        if int(retry_after) > _MAX_RETRY_AFTER:
            retriable = False
        else:
            pause = int(retry_after)
    return AskError(_http_error_text(status, body, headers)), retriable, pause


async def _ask_stream(body: dict, key: str, state: _State | None = None):
    """POST /v1/ask с ретраями до первого delta и дочитыванием; отдаёт (event, data)."""
    state = state if state is not None else _State()
    headers = _headers({"Idempotency-Key": key, "Accept": "text/event-stream"})
    net_error: httpx.HTTPError | None = None
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=TIMEOUT) as client:
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            failure: tuple[AskError, bool, int | None] | None = None
            net_error = None
            # новая попытка = новый run: чужой run_id и чужой Last-Event-ID не годятся
            state.run_id = None
            state.last_id = None
            try:
                async with client.stream("POST", "/v1/ask", json=body, headers=headers) as r:
                    if r.status_code >= 400:
                        failure = _http_failure(r.status_code, await r.aread(), r.headers)
                    else:
                        state.run_id = r.headers.get("x-run-id")
                        async for event, data, event_id in _sse_frames(r):
                            if event_id is not None:
                                state.last_id = event_id
                            _handle(event, data, state)
                            yield event, data
                            if state.saw_done:
                                return
            except _StreamError as e:
                if not (e.retryable and not state.parts):
                    raise
                failure = (e, True, None)
            except httpx.HTTPError as e:
                net_error = e
                if not state.parts:
                    err = AskError(f"Сетевая ошибка: {type(e).__name__}: {e}")
                    failure = (err, isinstance(e, _RETRYABLE_NETWORK), None)
            if failure is None:
                break  # поток оборвался: дочитывание или ошибка ниже
            err, retriable, pause = failure
            if not retriable or attempt == _MAX_ATTEMPTS:
                raise err
            await asyncio.sleep(pause if pause is not None else _RETRY_PAUSES[attempt - 1])

        if state.parts and state.run_id:
            try:
                async for event, data in _resume(client, state.run_id, state.last_id, state):
                    yield event, data
            except httpx.HTTPError as e:
                net_error = e
            if state.saw_done:
                return

    if net_error is not None:
        msg = f"Сетевая ошибка: {type(net_error).__name__}: {net_error}"
    else:
        msg = "Поток оборвался до завершения ответа."
    if state.parts:
        msg += "\n\nЧастичный ответ:\n" + "".join(state.parts)
    raise AskError(msg) from net_error


_HISTORY_MAX = 400


def _check_history(history: list | None) -> list | None:
    """Проверка history до сетевого запроса; элементы и их порядок не меняются."""
    if not history:
        return None
    if len(history) > _HISTORY_MAX:
        raise AskError(f"history: не больше {_HISTORY_MAX} сообщений, передано {len(history)}")
    for n, item in enumerate(history, 1):
        if not isinstance(item, dict):
            raise AskError(f"history: элемент {n} — не объект")
        role = item.get("role")
        if not isinstance(role, str) or not role:
            raise AskError(f"history: у элемента {n} нет role")
        text = item.get("text")
        if ("text" not in item and "files" not in item) or (text is not None and not isinstance(text, str)):
            raise AskError(f"history: у элемента {n} нет ни text, ни files")
    return history


@mcp.tool(structured_output=True)
async def ask(
    prompt: str,
    model: str | None = None,
    system: str | None = None,
    history: Annotated[list[dict] | None, Field(
        description="Предыдущие сообщения диалога по возрастанию, до 400: "
                    "[{\"role\": \"user\"|\"assistant\", \"text\": \"…\"}].")] = None,
    idempotency_key: Annotated[str | None, Field(
        description="Ключ повтора (до 200 печатных символов). Передайте тот же ключ, "
                    "чтобы повтор не создал второй ответ и не списал лимит дважды.")] = None,
) -> AskResult:
    """Задать вопрос модели через Ask API и получить ответ, расход (usage) и лимиты (limits).

    prompt: вопрос (1–100000 символов).
    model: необязательно, например claude-sonnet-5-5 (по умолчанию), claude-haiku-5-5.
    system: необязательные инструкции для модели (до 20000 символов).
    history: необязательно, предыдущие сообщения диалога (до 400), чтобы не пересказывать контекст.
    В результате поле folded заполнено, если сервер сжал историю: {summary, count}.
    Каждый вызов расходует лимит вашего тарифа.
    """
    checked = _check_history(history)
    body: dict = {"prompt": prompt}
    if model:
        body["model"] = model
    if system:
        body["system"] = system
    if checked:
        body["history"] = checked

    key = idempotency_key or uuid.uuid4().hex
    state = _State()
    async for _ in _ask_stream(body, key, state):
        pass

    done = state.done or {}
    text = "".join(state.parts)
    if done.get("truncated"):
        text += "\n\n[Ответ обрезан: достигнут лимит длины]"
    return AskResult(
        answer=text,
        usage=state.usage,
        limits=state.limits,
        folded=state.folded,
        runId=state.run_id,
        messageId=done.get("messageId"),
    )


@mcp.tool()
async def get_usage() -> str:
    """Показать текущие лимиты и расход по тарифу (GET /v1/usage), в виде JSON."""
    try:
        async with httpx.AsyncClient(base_url=BASE_URL, timeout=TIMEOUT) as client:
            r = await client.get("/v1/usage", headers=_headers())
    except httpx.HTTPError as e:
        raise AskError(f"Сетевая ошибка: {type(e).__name__}: {e}") from e
    if r.status_code >= 400:
        raise AskError(_http_error_text(r.status_code, r.content, r.headers))
    data = r.json()
    return json.dumps(data.get("limits", data), ensure_ascii=False, indent=2)


# --- инструмент code: Ask правит файлы проекта через /v1/code ---------------------------------
# Поведение скопировано с review/checks/ask_code.py (эталон M0.5, маршрут B). Отличие одно:
# границы записи задаются списком запретов CODE_DENY, а не списком разрешённых путей.

CODE_ROOT = os.path.abspath(os.environ.get("ASK_CODE_ROOT") or os.path.dirname(os.path.abspath(__file__)))
CODE_DENY = (".env", ".git", ".venv", "__pycache__", ".pytest_cache", "runs")
CODE_MAX_OUTPUT = 8000


def _code_root() -> str:
    # Читается при вызове, не на импорте: тесты подменяют server.CODE_ROOT.
    return os.path.abspath(CODE_ROOT)


def _code_rel(path: str) -> str:
    """Путь относительно корня; абсолютный путь или выход из корня — RuntimeError."""
    root = _code_root()
    clean = (path or ".").replace("\\", "/").strip()
    if clean.startswith("/") or (len(clean) > 1 and clean[1] == ":"):
        raise RuntimeError(f"абсолютный путь запрещён: {path}")
    full = os.path.abspath(os.path.join(root, clean))
    if full != root and not full.startswith(root + os.sep):
        raise RuntimeError(f"путь вне проекта: {path}")
    return os.path.relpath(full, root).replace("\\", "/")


def _code_denied(name: str) -> bool:
    """Запрет по сегментам пути (не по подстроке): .env закрыт, .env.example открыт."""
    deny = {d.lower() for d in CODE_DENY}
    return any(part.lower() in deny for part in name.split("/"))


def _code_path(path: str) -> str:
    """_code_rel плюс запреты CODE_DENY: один вход для чтения и записи."""
    name = _code_rel(path)
    if _code_denied(name):
        raise RuntimeError(f"доступ запрещён: {name}")
    return name


def _code_clip(text: str) -> str:
    return text if len(text) <= CODE_MAX_OUTPUT else text[:CODE_MAX_OUTPUT] + "\n…обрезано"


def _code_walk(base: str):
    """Файлы под base без запрещённых каталогов и файлов; если base — файл, то он сам."""
    if os.path.isfile(base):
        yield base
        return
    for folder, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d.lower() not in {x.lower() for x in CODE_DENY})
        for name in sorted(files):
            if name.lower() not in {x.lower() for x in CODE_DENY}:
                yield os.path.join(folder, name)


def _tl_list_files(args: dict) -> str:
    root = _code_root()
    target = _code_path(args.get("path", "."))
    depth = int(args.get("depth", 2))
    base = os.path.join(root, target)
    lines = []
    for full in _code_walk(base):
        inside = os.path.relpath(os.path.dirname(full), base)
        if inside != "." and inside.count(os.sep) + 1 >= depth:
            continue
        lines.append(os.path.relpath(full, root).replace("\\", "/"))
    return "\n".join(lines[:500]) or "(пусто)"


def _tl_read_file(args: dict) -> str:
    name = _code_path(args["path"])
    offset = int(args.get("offset") or 1)
    limit = int(args.get("limit") or 400)
    with open(os.path.join(_code_root(), name), encoding="utf-8", newline="") as handle:
        rows = handle.read().splitlines()
    chunk = rows[offset - 1: offset - 1 + limit]
    head = f"# {name}: строки {offset}-{offset + len(chunk) - 1} из {len(rows)}\n"
    return head + "\n".join(chunk)


def _tl_search(args: dict) -> str:
    root = _code_root()
    pattern = args["pattern"]
    target = _code_path(args.get("path", "."))
    matcher = re.compile(pattern if args.get("regex") else re.escape(pattern))
    hits = []
    for full in _code_walk(os.path.join(root, target)):
        try:
            with open(full, encoding="utf-8", newline="") as handle:
                for number, line in enumerate(handle, 1):
                    if matcher.search(line):
                        name = os.path.relpath(full, root).replace("\\", "/")
                        hits.append(f"{name}:{number}: {line.rstrip()}")
                        if len(hits) >= 100:
                            return "\n".join(hits) + "\n…ещё есть"
        except (UnicodeDecodeError, OSError):
            continue
    return "\n".join(hits) or "(не найдено)"


def _tl_write_file(args: dict) -> str:
    root = _code_root()
    name = _code_path(args["path"])
    full = os.path.join(root, name)
    os.makedirs(os.path.dirname(full) or root, exist_ok=True)
    body = args.get("content") or ""
    with open(full, "w", encoding="utf-8", newline="") as handle:
        handle.write(body)
    return f"записано {len(body)} символов в {name}"


def _tl_edit_file(args: dict) -> str:
    name = _code_path(args["path"])
    full = os.path.join(_code_root(), name)
    old, new = args.get("old_text") or "", args.get("new_text") or ""
    with open(full, encoding="utf-8", newline="") as handle:
        body = handle.read()
    found = body.count(old)
    if found != 1:
        raise RuntimeError(f"old_text встречается {found} раз, нужно ровно 1")
    with open(full, "w", encoding="utf-8", newline="") as handle:
        handle.write(body.replace(old, new))
    return f"заменено в {name} ({len(old)} → {len(new)} символов)"


_CODE_TOOLS = {
    "list_files": _tl_list_files,
    "read_file": _tl_read_file,
    "search": _tl_search,
    "write_file": _tl_write_file,
    "edit_file": _tl_edit_file,
}


def _code_run_tool(name: str, args: dict) -> dict:
    """Выполняет инструмент; возвращает {"ok": bool, "output": str} для /v1/code/{runId}/tools/{callId}."""
    handler = _CODE_TOOLS.get(name)
    if handler is None:
        return {"ok": False, "output": f"неизвестный инструмент: {name}"}
    try:
        return {"ok": True, "output": _code_clip(handler(args or {}))}
    except Exception as exc:  # модель должна узнать причину и сменить план
        return {"ok": False, "output": f"{type(exc).__name__}: {exc}"}


@mcp.tool()
async def code(task: str, model: str | None = None, max_steps: int = 35) -> str:
    """Поручить Ask правку кода проекта (POST /v1/code); возвращает JSON с итогом.

    task: что сделать (например «добавь тест для X»). Модель читает и меняет файлы в корне
    проекта через list_files, read_file, search, write_file, edit_file; запускать команды
    она не может. Запись и чтение закрыты для .env, .git, .venv, __pycache__, runs.
    model: необязательно, например claude-haiku-5-5.
    max_steps: сколько вызовов инструментов разрешено (по умолчанию 35), потом задача останавливается.
    Каждый вызов расходует лимит тарифа.
    """
    if not task or not task.strip():
        raise AskError("Пустая задача: опишите, что нужно сделать с кодом.")
    body: dict = {"prompt": task, "folder": os.path.basename(_code_root())}
    if model:
        body["model"] = model
    headers = _headers({"Accept": "text/event-stream"})

    started = time.monotonic()
    state = _State()
    steps: list[dict] = []
    status = "no_done"
    try:
        async with httpx.AsyncClient(base_url=BASE_URL, timeout=httpx.Timeout(300.0, connect=30.0)) as client:
            async with client.stream("POST", "/v1/code", json=body, headers=headers) as r:
                if r.status_code >= 400:
                    raise AskError(_http_error_text(r.status_code, await r.aread(), r.headers))
                state.run_id = r.headers.get("x-run-id")
                async for event, data, _ in _sse_frames(r):
                    if event != "tool":
                        _handle(event, data, state)  # error -> AskError
                        if state.saw_done:
                            status = "done"
                            break
                        continue
                    run_id = data.get("runId") or state.run_id
                    call_id = str(data.get("callId", ""))
                    over = len(steps) >= max_steps
                    if over:
                        result = {"ok": False, "output": "бюджет шагов исчерпан проверяющим"}
                    else:
                        tool_input = data.get("input")
                        result = await asyncio.to_thread(
                            _code_run_tool, str(data.get("name", "")), tool_input if isinstance(tool_input, dict) else {}
                        )
                        steps.append({"name": data.get("name", ""), "ok": result["ok"]})
                    rr = await client.post(f"/v1/code/{run_id}/tools/{call_id}", json=result, headers=headers)
                    if over:
                        try:
                            await client.post(f"/v1/runs/{run_id}/stop", headers=headers)
                        except httpx.HTTPError:
                            pass
                        status = "budget"
                        break
                    if rr.status_code >= 400:
                        raise AskError(_http_error_text(rr.status_code, rr.content, rr.headers))
    except httpx.HTTPError as e:
        status = "error"
        raise AskError(f"Сетевая ошибка: {type(e).__name__}: {e}") from e
    except AskError:
        status = "error"
        raise
    finally:
        if status == "no_done":
            status = "interrupted"
        print(
            json.dumps(
                {"tool": "code", "prompt_chars": len(task), "steps": len(steps), "status": status,
                 "ms": int((time.monotonic() - started) * 1000)},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
    if status == "interrupted":
        raise AskError("Поток оборвался до завершения задачи; у Code-задач возобновления нет.")
    return json.dumps(
        {
            "status": status,
            "answer": "".join(state.parts),
            "steps": steps,
            "usage": state.usage,
            "limits": state.limits,
            "runId": state.run_id,
        },
        ensure_ascii=False,
    )


if __name__ == "__main__":
    # stdout занят протоколом MCP: логи только в stderr.
    # По умолчанию stdio (для Claude Desktop/Code). Аргумент --http запускает
    # постоянный HTTP-сервер: http://127.0.0.1:8000/mcp (ASK_HOST, ASK_PORT).
    if _ARGS.http:
        print(f"ask MCP server (http) http://{mcp.settings.host}:{mcp.settings.port}/mcp, base url: {BASE_URL}", file=sys.stderr)
        mcp.run(transport="streamable-http")
    else:
        print(f"ask MCP server (stdio), base url: {BASE_URL}", file=sys.stderr)
        mcp.run()
