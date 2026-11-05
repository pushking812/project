"""MCP по Streamable HTTP: одна долгоживущая сессия, очередь запросов, переподключение.

Соединение живёт в отдельной задаче-супервизоре: streamablehttp_client держит anyio cancel scope,
поэтому вход и выход из него должны быть в одной задаче, а не в задачах обработчиков Telegram.
Пока сессии нет, вызов ждёт подключения не дольше connect_wait и отвечает понятной ошибкой.
"""

import asyncio
import base64
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import httpx
from mcp import ClientSession

try:  # mcp >= 1.13: таймауты задаются httpx-клиентом
    from mcp.client.streamable_http import streamable_http_client as _new_transport
except ImportError:  # pragma: no cover — старые версии mcp
    _new_transport = None
try:
    from mcp.client.streamable_http import streamablehttp_client as _old_transport
except ImportError:  # pragma: no cover
    _old_transport = None

from .log import debug, info, warn


@asynccontextmanager
async def _connect(url: str, http_timeout: float, sse_read_timeout: float):
    """Потоки (read, write) транспорта Streamable HTTP: новый вход, иначе прежний."""
    if _new_transport is not None:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=http_timeout, read=sse_read_timeout, write=60.0, pool=http_timeout),
            trust_env=False,  # MCP-сервер локальный: HTTPS_PROXY из среды не должен его ломать
        )
        async with client:
            async with _new_transport(url, http_client=client) as (read, write, _get_id):
                yield read, write
        return
    if _old_transport is None:  # pragma: no cover
        raise RuntimeError("в установленном mcp нет Streamable HTTP: обновите пакет mcp")
    async with _old_transport(url, timeout=http_timeout, sse_read_timeout=sse_read_timeout) as (read, write, _get_id):
        yield read, write


class McpError(Exception):
    """Ошибка MCP-слоя бота (понятный текст для пользователя)."""


class McpNotConnected(McpError):
    """Сервер не отвечает или ещё не подключился."""


class McpTimeout(McpError):
    """Инструмент не ответил за отведённое время."""


@dataclass
class ToolImage:
    data: bytes
    mime: str = "image/png"


@dataclass
class ToolResult:
    text: str = ""
    images: list[ToolImage] = field(default_factory=list)
    is_error: bool = False


@dataclass
class ToolInfo:
    name: str
    description: str = ""
    schema: dict = field(default_factory=dict)


@dataclass
class _Job:
    kind: str  # "call" | "list"
    future: asyncio.Future
    name: str = ""
    arguments: dict | None = None
    timeout: float = 120.0


def _content(result) -> ToolResult:
    """CallToolResult -> текст, картинки и признак ошибки (isError)."""
    parts: list[str] = []
    images: list[ToolImage] = []
    for item in getattr(result, "content", None) or []:
        text = getattr(item, "text", None)
        if isinstance(text, str):
            parts.append(text)
            continue
        data = getattr(item, "data", None)
        if isinstance(data, str):
            try:
                raw = base64.b64decode(data)
            except (ValueError, TypeError):
                continue  # битый снимок не должен ронять ответ
            images.append(ToolImage(data=raw, mime=getattr(item, "mimeType", None) or "image/png"))
            continue
        parts.append(str(item))
    return ToolResult(text="\n".join(parts), images=images, is_error=bool(getattr(result, "isError", False)))


def _tools(raw) -> list[ToolInfo]:
    out: list[ToolInfo] = []
    for tool in getattr(raw, "tools", None) or []:
        schema = getattr(tool, "inputSchema", None)
        out.append(
            ToolInfo(
                name=str(getattr(tool, "name", "")),
                description=str(getattr(tool, "description", "") or ""),
                schema=schema if isinstance(schema, dict) else {},
            )
        )
    return out


class McpWorker:
    """Очередь запросов к одной сессии MCP. Соединение поднимается само и восстанавливается."""

    def __init__(
        self,
        url: str,
        *,
        session_factory=None,
        connect_wait: float = 8.0,
        initial_backoff: float = 0.5,
        max_backoff: float = 15.0,
        http_timeout: float = 30.0,
        sse_read_timeout: float = 300.0,
    ):
        self.url = url
        self._factory = session_factory or self._default_session
        self._connect_wait = connect_wait
        self._initial_backoff = initial_backoff
        self._max_backoff = max_backoff
        self._http_timeout = http_timeout
        self._sse_read_timeout = sse_read_timeout
        self._queue: asyncio.Queue[_Job | None] = asyncio.Queue()
        self._ready = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._closed = False
        self._last_error: str | None = None

    # --- состояние -----------------------------------------------------------------------------

    @property
    def ready(self) -> bool:
        return self._ready.is_set()

    @property
    def last_error(self) -> str | None:
        return self._last_error

    def describe(self) -> str:
        if self.ready:
            return f"подключён к {self.url}"
        if self._last_error:
            return f"нет соединения с {self.url} ({self._last_error})"
        return f"нет соединения с {self.url}"

    # --- запуск и остановка --------------------------------------------------------------------

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._closed = False
            self._task = asyncio.create_task(self._run(), name="mcp-worker")

    async def stop(self) -> None:
        self._closed = True
        await self._queue.put(None)
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        self._ready.clear()

    # --- сессия --------------------------------------------------------------------------------

    @asynccontextmanager
    async def _default_session(self):
        async with _connect(self.url, self._http_timeout, self._sse_read_timeout) as (read, write):
            async with ClientSession(read, write) as session:
                yield session

    async def _run(self) -> None:
        backoff = self._initial_backoff
        logged: str | None = None
        while not self._closed:
            try:
                await self._serve()
                backoff = self._initial_backoff
                logged = None
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — любая ошибка транспорта значит «переподключиться»
                self._ready.clear()
                self._last_error = f"{type(e).__name__}: {e}"
                self._fail_pending(McpNotConnected(self._hint()))
                # одна и та же ошибка при переподключении не должна засорять лог каждые 15 секунд
                if self._last_error != logged:
                    warn("mcp", f"соединение потеряно: {self._last_error}; повтор через {backoff:.1f} c")
                    logged = self._last_error
                else:
                    debug("mcp", f"переподключение: {self._last_error}")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self._max_backoff)

    async def _serve(self) -> None:
        async with self._factory() as session:
            await session.initialize()
            self._last_error = None
            self._ready.set()
            info("mcp", f"подключено к {self.url}")
            try:
                while not self._closed:
                    job = await self._queue.get()
                    if job is None:
                        return
                    if job.future.done():
                        continue  # вызывающий уже отказался ждать
                    await self._run_job(session, job)
            finally:
                self._ready.clear()

    async def _run_job(self, session, job: _Job) -> None:
        try:
            if job.kind == "list":
                raw = await asyncio.wait_for(session.list_tools(), job.timeout)
            else:
                raw = await asyncio.wait_for(session.call_tool(job.name, job.arguments or {}), job.timeout)
        except asyncio.TimeoutError:
            job.future.set_exception(
                McpTimeout(
                    f"Инструмент {job.name or 'list_tools'} не ответил за {job.timeout:.0f} c. "
                    "Долгие задачи запускайте через /exec: их можно смотреть и останавливать."
                )
            )
            raise  # сессия в неясном состоянии: переподключимся, чтобы не тянуть зависший запрос
        except Exception as e:  # noqa: BLE001 — ошибка транспорта или протокола
            job.future.set_exception(McpError(f"{type(e).__name__}: {e}"))
            raise
        if job.future.done():
            return
        job.future.set_result(_tools(raw) if job.kind == "list" else _content(raw))

    def _fail_pending(self, exc: Exception) -> None:
        while True:
            try:
                job = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            if job is None:
                continue
            if not job.future.done():
                job.future.set_exception(exc)

    def _hint(self) -> str:
        return (
            f"MCP-сервер не отвечает на {self.url}. Запустите его: mcp\\run_server.ps1 "
            "(или .venv\\Scripts\\python server.py --http) и проверьте TELEGRAM_MCP_URL."
        )

    # --- запросы -------------------------------------------------------------------------------

    async def _submit(self, job: _Job, wait: float):
        if self._closed:
            raise McpNotConnected("Бот остановлен.")
        if not self._ready.is_set():
            try:
                await asyncio.wait_for(self._ready.wait(), self._connect_wait)
            except asyncio.TimeoutError:
                raise McpNotConnected(self._hint()) from None
        await self._queue.put(job)
        try:
            return await asyncio.wait_for(job.future, wait + 5.0)
        except asyncio.TimeoutError:
            job.future.cancel()
            raise McpTimeout(f"Инструмент {job.name or 'list_tools'} не ответил за {wait:.0f} c.") from None

    async def call(self, name: str, arguments: dict | None = None, timeout: float = 120.0) -> ToolResult:
        """Вызвать инструмент. Ошибка инструмента (isError) — не исключение, а ToolResult.is_error."""
        debug("mcp", f"call {name} timeout={timeout:.0f}")
        job = _Job("call", asyncio.get_running_loop().create_future(), name=name, arguments=arguments, timeout=timeout)
        return await self._submit(job, timeout)

    async def list_tools(self, timeout: float = 15.0) -> list[ToolInfo]:
        job = _Job("list", asyncio.get_running_loop().create_future(), timeout=timeout)
        return await self._submit(job, timeout)
