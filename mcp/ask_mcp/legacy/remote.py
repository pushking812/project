"""Прежние инструменты ask и get_usage: прямые вызовы сайта Ask (/v1/ask, /v1/usage).

Код перенесён из старого server.py без изменения поведения. По умолчанию (MCP_BACKEND=api) не подключается к MCP,
но остаётся рабочим: его используют openai_proxy.py и можно включить `MCP_BACKEND=legacy` или `both`.
"""

import asyncio
import json
import os
import uuid
from dataclasses import dataclass, field
from typing import Annotated

import httpx
from pydantic import BaseModel, Field

from ..config import BASE_URL, TIMEOUT
from ..errors import AskError, StreamError
from ..sse import sse_frames


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
class State:
    parts: list[str] = field(default_factory=list)
    run_id: str | None = None
    done: dict | None = None
    usage: dict | None = None
    limits: dict | None = None
    folded: dict | None = None
    last_id: str | None = None
    saw_done: bool = False


def headers(extra: dict | None = None) -> dict:
    key = os.environ.get("ASK_API_KEY", "").strip()
    if not key:
        raise AskError("Не задана переменная окружения ASK_API_KEY (ключ вида sk-ask-...).")
    h = {"Authorization": f"Bearer {key}"}
    if extra:
        h.update(extra)
    return h


def http_error_text(status: int, body: bytes, hdrs: httpx.Headers) -> str:
    try:
        err = json.loads(body).get("error", {})
        text = f"{err.get('code', status)}: {err.get('message', '')}".strip()
        if err.get("retryAt"):
            text += f" (не раньше {err['retryAt']})"
    except Exception:
        text = f"HTTP {status}: {body[:300].decode('utf-8', 'replace')}"
    retry = hdrs.get("Retry-After")
    if retry:
        text += f" (повторите через {retry} с)"
    return text


async def gone_text(client: httpx.AsyncClient, run_id: str, status: int, body: bytes) -> str:
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
        rr = await client.get(f"/v1/runs/{run_id}", headers=headers())
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


def handle(event: str, data: dict, state: State) -> None:
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
        raise StreamError(msg, retryable=bool(data.get("retryable")))


async def resume(client: httpx.AsyncClient, run_id: str, last_id: str | None, state: State):
    """Дочитывает run: GET /v1/runs/{id}/events с Last-Event-ID; отдаёт (event, data)."""
    hdrs = headers({"Accept": "text/event-stream"})
    keep: list[str] | None = None
    if last_id is not None and str(last_id).isdigit():
        hdrs["Last-Event-ID"] = str(last_id)
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
        async with client.stream("GET", f"/v1/runs/{run_id}/events", headers=hdrs) as r:
            if r.status_code >= 400:
                body = await r.aread()
                if r.status_code in (404, 410):
                    text = await gone_text(client, run_id, r.status_code, body)
                else:
                    text = http_error_text(r.status_code, body, r.headers)
                raise AskError(text + partial())
            async for event, data, event_id in sse_frames(r):
                if event_id is not None:
                    state.last_id = event_id
                handle(event, data, state)
                yield event, data
                if state.saw_done:
                    return
    finally:
        restore()


MAX_ATTEMPTS = 4
RETRY_PAUSES = (1, 2, 4, 8)
MAX_RETRY_AFTER = 10
RETRYABLE_NETWORK = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.RemoteProtocolError,
    httpx.PoolTimeout,
)
RETRYABLE_HTTP = {(503, "restarting"), (500, "internal"), (429, "too_many_requests")}


def http_failure(status: int, body: bytes, hdrs: httpx.Headers) -> tuple[AskError, bool, int | None]:
    """Ответ >= 400 на POST: (ошибка, повторять ли, пауза из Retry-After)."""
    try:
        code = json.loads(body).get("error", {}).get("code")
    except Exception:
        code = None
    retriable = (status, code) in RETRYABLE_HTTP
    pause = None
    retry_after = hdrs.get("Retry-After", "").strip()
    if retriable and status in (503, 429) and retry_after.isdigit():
        if int(retry_after) > MAX_RETRY_AFTER:
            retriable = False
        else:
            pause = int(retry_after)
    return AskError(http_error_text(status, body, hdrs)), retriable, pause


async def ask_stream(body: dict, key: str, state: State | None = None):
    """POST /v1/ask с ретраями до первого delta и дочитыванием; отдаёт (event, data)."""
    state = state if state is not None else State()
    hdrs = headers({"Idempotency-Key": key, "Accept": "text/event-stream"})
    net_error: httpx.HTTPError | None = None
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=TIMEOUT) as client:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            failure: tuple[AskError, bool, int | None] | None = None
            net_error = None
            # новая попытка = новый run: чужой run_id и чужой Last-Event-ID не годятся
            state.run_id = None
            state.last_id = None
            try:
                async with client.stream("POST", "/v1/ask", json=body, headers=hdrs) as r:
                    if r.status_code >= 400:
                        failure = http_failure(r.status_code, await r.aread(), r.headers)
                    else:
                        state.run_id = r.headers.get("x-run-id")
                        async for event, data, event_id in sse_frames(r):
                            if event_id is not None:
                                state.last_id = event_id
                            handle(event, data, state)
                            yield event, data
                            if state.saw_done:
                                return
            except StreamError as e:
                if not (e.retryable and not state.parts):
                    raise
                failure = (e, True, None)
            except httpx.HTTPError as e:
                net_error = e
                if not state.parts:
                    err = AskError(f"Сетевая ошибка: {type(e).__name__}: {e}")
                    failure = (err, isinstance(e, RETRYABLE_NETWORK), None)
            if failure is None:
                break  # поток оборвался: дочитывание или ошибка ниже
            err, retriable, pause = failure
            if not retriable or attempt == MAX_ATTEMPTS:
                raise err
            await asyncio.sleep(pause if pause is not None else RETRY_PAUSES[attempt - 1])

        if state.parts and state.run_id:
            try:
                async for event, data in resume(client, state.run_id, state.last_id, state):
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


HISTORY_MAX = 400


def check_history(history: list | None) -> list | None:
    """Проверка history до сетевого запроса; элементы и их порядок не меняются."""
    if not history:
        return None
    if len(history) > HISTORY_MAX:
        raise AskError(f"history: не больше {HISTORY_MAX} сообщений, передано {len(history)}")
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
    checked = check_history(history)
    body: dict = {"prompt": prompt}
    if model:
        body["model"] = model
    if system:
        body["system"] = system
    if checked:
        body["history"] = checked

    key = idempotency_key or uuid.uuid4().hex
    state = State()
    async for _ in ask_stream(body, key, state):
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


async def get_usage() -> str:
    """Показать текущие лимиты и расход по тарифу (GET /v1/usage), в виде JSON."""
    try:
        async with httpx.AsyncClient(base_url=BASE_URL, timeout=TIMEOUT) as client:
            r = await client.get("/v1/usage", headers=headers())
    except httpx.HTTPError as e:
        raise AskError(f"Сетевая ошибка: {type(e).__name__}: {e}") from e
    if r.status_code >= 400:
        raise AskError(http_error_text(r.status_code, r.content, r.headers))
    data = r.json()
    return json.dumps(data.get("limits", data), ensure_ascii=False, indent=2)
