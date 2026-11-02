"""Офлайн-проверка шага 1 (замечания 1.1 и 1.2). Ключ и сеть не нужны."""
import asyncio

import httpx
import pytest

import server


def _events(raw: bytes):
    async def run():
        async def stream():
            yield raw

        r = httpx.Response(200, content=stream())
        return [e async for e in server._sse_events(r)]

    return asyncio.run(run())


def test_with_blank_line():
    raw = b'event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {"messageId":"x"}\n\n'
    assert _events(raw) == [("delta", {"text": "hi"}), ("done", {"messageId": "x"})]


def test_without_final_blank_line():
    raw = b'event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {"messageId":"x"}'
    assert _events(raw) == [("delta", {"text": "hi"}), ("done", {"messageId": "x"})]


def test_without_final_blank_line_crlf():
    raw = b'event: delta\r\ndata: {"text":"hi"}\r\n\r\nevent: done\r\ndata: {"messageId":"x"}'
    assert _events(raw) == [("delta", {"text": "hi"}), ("done", {"messageId": "x"})]


def test_heartbeat_and_bad_json():
    raw = b': hb\n\nevent: delta\ndata: {bad\n\nevent: delta\ndata: {"text":"a"}\n\n'
    assert _events(raw) == [("delta", {"text": "a"})]


def test_non_object_payload_is_ignored():
    raw = b'event: delta\ndata: 5\n\nevent: done\ndata: null\n\nevent: delta\ndata: {"text":"a"}'
    assert _events(raw) == [("delta", {"text": "a"})]


def _ask(monkeypatch, transport) -> str:
    monkeypatch.setenv("ASK_API_KEY", "sk-ask-test")
    orig = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: orig(transport=transport, **kw))
    return asyncio.run(server.ask("q"))


def test_ask_truncated_stream_keeps_partial(monkeypatch):
    raw = b'event: delta\ndata: {"text":"PARTIAL"}\n\n'
    t = httpx.MockTransport(lambda req: httpx.Response(200, content=raw))
    with pytest.raises(server.AskError) as exc:
        _ask(monkeypatch, t)
    assert "Поток оборвался до завершения ответа." in str(exc.value)
    assert "Частичный ответ:\nPARTIAL" in str(exc.value)


def test_ask_trailing_error_keeps_partial(monkeypatch):
    raw = (b'event: delta\ndata: {"text":"PARTIAL"}\n\n'
           b'event: error\ndata: {"code":"rate_limited","message":"slow","retryable":true}')
    t = httpx.MockTransport(lambda req: httpx.Response(200, content=raw))
    with pytest.raises(server.AskError) as exc:
        _ask(monkeypatch, t)
    assert "rate_limited: slow (можно повторить)" in str(exc.value)
    assert "PARTIAL" in str(exc.value)


def test_ask_done_without_blank_line_is_success(monkeypatch):
    raw = b'event: delta\ndata: {"text":"full"}\n\nevent: done\ndata: {}'
    t = httpx.MockTransport(lambda req: httpx.Response(200, content=raw))
    assert _ask(monkeypatch, t) == "full"


def test_ask_network_error_keeps_partial(monkeypatch):
    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'event: delta\ndata: {"text":"PARTIAL"}\n\n'
            raise httpx.ReadError("boom")

    t = httpx.MockTransport(lambda req: httpx.Response(200, stream=Broken()))
    with pytest.raises(server.AskError) as exc:
        _ask(monkeypatch, t)
    assert "PARTIAL" in str(exc.value)
