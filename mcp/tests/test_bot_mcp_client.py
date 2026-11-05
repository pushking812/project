"""Офлайн-проверка MCP-клиента бота: подставная сессия, переподключение, таймауты."""

import asyncio
import base64
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from ask_mcp.bot.mcp_client import McpError, McpNotConnected, McpTimeout, McpWorker


class FakeContent:
    def __init__(self, *, text=None, data=None, mime=None):
        if text is not None:
            self.text = text
        if data is not None:
            self.data = data
        if mime is not None:
            self.mimeType = mime


class FakeResult:
    def __init__(self, content=None, isError=False):
        self.content = content if content is not None else [FakeContent(text="ok")]
        self.isError = isError


class FakeSession:
    def __init__(self, *, reply=None, tools=None, delay=0.0, fail=None):
        self.reply = reply if reply is not None else FakeResult()
        self.tools = tools or []
        self.delay = delay
        self.fail = fail
        self.initialized = False
        self.calls = []

    async def initialize(self):
        self.initialized = True

    async def call_tool(self, name, arguments=None, **kwargs):
        self.calls.append((name, arguments or {}))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail is not None:
            raise self.fail
        return self.reply(name, arguments or {}) if callable(self.reply) else self.reply

    async def list_tools(self, **kwargs):
        schema = {"type": "object"}
        return SimpleNamespace(
            tools=[SimpleNamespace(name=n, description=f"{n} описание", inputSchema=schema) for n in self.tools]
        )


def factory(sessions):
    """Фабрика сессий по очереди; когда очередь кончилась, отдаёт последнюю."""
    index = {"i": 0}

    @asynccontextmanager
    async def make():
        i = min(index["i"], len(sessions) - 1)
        index["i"] += 1
        yield sessions[i]

    return make


def worker(sessions, **kw):
    kw.setdefault("connect_wait", 1.0)
    kw.setdefault("initial_backoff", 0.01)
    return McpWorker("http://127.0.0.1:8000/mcp", session_factory=factory(sessions), **kw)


def test_call_returns_text_and_records_arguments():
    session = FakeSession(reply=FakeResult([FakeContent(text="первый"), FakeContent(text="второй")]))

    async def go():
        w = worker([session])
        await w.start()
        try:
            res = await w.call("health", {})
            assert res.text == "первый\nвторой" and not res.is_error
            assert session.calls == [("health", {})]
        finally:
            await w.stop()

    asyncio.run(go())


def test_images_are_decoded():
    image = FakeContent(data=base64.b64encode(b"\x89PNG").decode(), mime="image/png")
    session = FakeSession(reply=FakeResult([FakeContent(text='{"ok": true}'), image]))

    async def go():
        w = worker([session])
        await w.start()
        try:
            res = await w.call("browser_screenshot", {})
            assert res.text == '{"ok": true}'
            assert [(img.data, img.mime) for img in res.images] == [(b"\x89PNG", "image/png")]
        finally:
            await w.stop()

    asyncio.run(go())


def test_is_error_is_kept_as_result():
    session = FakeSession(reply=FakeResult([FakeContent(text="403 plan_mode: нельзя")], isError=True))

    async def go():
        w = worker([session])
        await w.start()
        try:
            res = await w.call("write_file", {"path": "a"})
            assert res.is_error and "plan_mode" in res.text
        finally:
            await w.stop()

    asyncio.run(go())


def test_list_tools_maps_schema():
    session = FakeSession(tools=["ask", "health"])

    async def go():
        w = worker([session])
        await w.start()
        try:
            tools = await w.list_tools()
            assert [t.name for t in tools] == ["ask", "health"]
            assert tools[0].description == "ask описание"
            assert tools[0].schema == {"type": "object"}
        finally:
            await w.stop()

    asyncio.run(go())


def test_not_connected_gives_hint():
    @asynccontextmanager
    async def broken():
        raise ConnectionError("нет соединения")
        yield  # pragma: no cover

    async def go():
        w = McpWorker(
            "http://127.0.0.1:1/mcp",
            session_factory=broken,
            connect_wait=0.2,
            initial_backoff=0.05,
        )
        await w.start()
        try:
            with pytest.raises(McpNotConnected) as e:
                await w.call("health", {}, timeout=1.0)
            assert "run_server.ps1" in str(e.value)
        finally:
            await w.stop()

    asyncio.run(go())


def test_reconnect_after_drop():
    first = FakeSession(fail=ConnectionError("обрыв"))
    second = FakeSession(reply=FakeResult([FakeContent(text="после")]))

    async def go():
        w = worker([first, second], connect_wait=2.0)
        await w.start()
        try:
            with pytest.raises(McpError):
                await w.call("health", {}, timeout=1.0)
            for _ in range(200):
                if w.ready:
                    break
                await asyncio.sleep(0.01)
            res = await w.call("health", {}, timeout=1.0)
            assert res.text == "после"
        finally:
            await w.stop()

    asyncio.run(go())


def test_timeout_closes_session_and_reports():
    slow = FakeSession(delay=5.0)

    async def go():
        w = worker([slow])
        await w.start()
        try:
            with pytest.raises(McpTimeout):
                await w.call("ask", {"prompt": "x"}, timeout=0.05)
        finally:
            await w.stop()

    asyncio.run(go())


def test_stop_is_idempotent_and_marks_not_connected():
    session = FakeSession()

    async def go():
        w = worker([session])
        await w.start()
        await w.stop()
        await w.stop()
        with pytest.raises(McpNotConnected):
            await w.call("health", {})

    asyncio.run(go())
