"""Клиент нашего HTTP API (ask-code-server): один вызов JSON или SSE, понятные ошибки.

Сервер слушает 127.0.0.1:8737 (ASK_LOCAL_URL) и без аутентификации, ключ сайта ему не нужен: он у сервера в ASK_KEY.
Если клиент MCP отменил вызов, соединение закрывается, и сервер останавливает задачу (так он обрабатывает обрыв).
"""

import json
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx

from .config import local_api_url
from .errors import AskError
from .sse import sse_frames

CONNECT_TIMEOUT = 10.0
DEFAULT_READ_TIMEOUT = 120.0  # сервер шлёт `: ping` раз в 15 с, так что тишина дольше означает обрыв


@dataclass
class ApiResult:
    """Ответ API: data — JSON-объект (для JSON-ответа) или {}; events — события, если ответ был потоком SSE."""

    data: dict = field(default_factory=dict)
    events: list[tuple[str, dict]] | None = None

    @property
    def is_stream(self) -> bool:
        return self.events is not None


def error_text(status: int, body: bytes) -> str:
    """Текст ошибки из тела `{"error": "...", "code": "..."}`; запасной вариант — первые 300 байт."""
    try:
        payload = json.loads(body)
        err = payload["error"]
        code = payload.get("code")
        if isinstance(err, dict):  # на случай объекта {"error": {"code", "message"}}
            code, err = err.get("code", code), err.get("message")
        head = f"{status} {code}" if code else str(status)
        return f"{head}: {err}"
    except Exception:
        return f"HTTP {status}: {body[:300].decode('utf-8', 'replace')}"


def seg(value) -> str:
    """Значение для сегмента пути: «../x» или «a/b» не должны менять маршрут запроса."""
    return quote(str(value), safe="")


def clean(body: dict) -> dict:
    """Убирает None: необязательные поля инструментов не должны уходить в запрос."""
    return {k: v for k, v in body.items() if v is not None}


async def call(
    method: str,
    path: str,
    body: dict | None = None,
    params: dict | None = None,
    read_timeout: float = DEFAULT_READ_TIMEOUT,
) -> ApiResult:
    """Один запрос к API. Ответ JSON — в data, поток SSE — в events (целиком, до закрытия соединения).

    Ошибка HTTP (>= 400) и недоступность сервера — AskError. События `error` внутри потока не бросаются:
    разбирает вызывающий (у разных инструментов разное «частичное» состояние).
    """
    try:
        base = local_api_url()
    except ValueError as e:
        raise AskError(str(e)) from e
    timeout = httpx.Timeout(connect=CONNECT_TIMEOUT, read=read_timeout, write=60.0, pool=CONNECT_TIMEOUT)
    kwargs: dict = {"params": clean(params)} if params else {}
    if body is not None:
        kwargs["json"] = clean(body)
    try:
        async with httpx.AsyncClient(base_url=base, timeout=timeout) as client:
            async with client.stream(method, path, **kwargs) as r:
                if r.status_code >= 400:
                    raise AskError(error_text(r.status_code, await r.aread()))
                if "text/event-stream" in r.headers.get("content-type", ""):
                    events = [(event, data) async for event, data, _ in sse_frames(r)]
                    return ApiResult(events=events)
                raw = await r.aread()
    except httpx.ConnectError as e:
        raise AskError(
            f"Сервер API не отвечает на {base}. Запустите его (npm start в папке проекта) "
            f"или поправьте ASK_LOCAL_URL. ({type(e).__name__})"
        ) from e
    except httpx.HTTPError as e:
        raise AskError(f"Сетевая ошибка при обращении к API: {type(e).__name__}: {e}") from e
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        raise AskError(f"API вернул не JSON: {raw[:200].decode('utf-8', 'replace')}") from e
    return ApiResult(data=data if isinstance(data, dict) else {"value": data})


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def fold_stream(events: list[tuple[str, dict]]) -> dict:
    """Сворачивает события задачи в итог: текст из delta, инструменты, usage, session, done.

    Событие `error` превращается в AskError с частичным ответом. Поток без done и error тоже ошибка (обрыв).
    """
    parts: list[str] = []
    tools: list[dict] = []
    out: dict = {}
    done = False
    for event, data in events:
        if event == "delta":
            parts.append(data.get("text", ""))
        elif event == "tool":
            tools.append({"name": data.get("name"), "ok": data.get("ok")})
        elif event == "usage":
            out["usage"] = data
        elif event == "session":
            out["session"] = data
        elif event == "done":
            done = True
            out["done"] = data
            if isinstance(data.get("output_files"), list):
                out["output_files"] = data["output_files"]  # поле есть, только если задача что-то записала
        elif event == "error":
            msg = str(data.get("message") or data)
            if parts:
                msg += "\n\nЧастичный ответ:\n" + "".join(parts)
            raise AskError(msg)
    if not done:
        msg = "Поток оборвался до завершения."
        if parts:
            msg += "\n\nЧастичный ответ:\n" + "".join(parts)
        raise AskError(msg)
    out["text"] = "".join(parts)
    out["tools"] = tools
    return out
