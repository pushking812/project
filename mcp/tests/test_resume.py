"""Офлайн-проверка шага 2 (замечания 2.4 и 2.5). Ключ и сеть не нужны."""
import asyncio

import httpx

import server


def _frames(raw: bytes):
    async def run():
        async def stream():
            yield raw

        r = httpx.Response(200, content=stream())
        return [f async for f in server._sse_frames(r)]

    return asyncio.run(run())


class Broken(httpx.AsyncByteStream):
    """Отдаёт начало потока и обрывает соединение."""

    def __init__(self, head: bytes):
        self.head = head

    async def __aiter__(self):
        yield self.head
        raise httpx.ReadError("boom")


def _call(monkeypatch, handler, **kw):
    """Зовёт ask через MockTransport; возвращает (результат или исключение, запросы, паузы)."""
    monkeypatch.setenv("ASK_API_KEY", "sk-ask-test")
    requests: list[httpx.Request] = []
    pauses: list[float] = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        requests.append(req)
        return handler(req)

    async def fake_sleep(seconds):
        pauses.append(seconds)

    orig = httpx.AsyncClient
    transport = httpx.MockTransport(wrapped)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: orig(transport=transport, **k))
    monkeypatch.setattr(server.asyncio, "sleep", fake_sleep)
    try:
        result = asyncio.run(server.ask("q", **kw))
    except server.AskError as e:
        result = e
    return result, requests, pauses


def _posts(requests):
    return [r for r in requests if r.method == "POST"]


FULL = (b'event: status\ndata: {"state":"starting","runId":"run1"}\n\n'
        b'event: delta\ndata: {"text":"OK"}\n\n'
        b'event: done\ndata: {"messageId":"run1"}\n\n')

HEAD_WITH_IDS = (b'event: status\ndata: {"state":"starting","runId":"run1"}\n\n'
                 b': hb\n\n'
                 b'id: 1\nevent: status\ndata: {"state":"writing"}\n\n'
                 b'id: 2\nevent: delta\ndata: {"text":"A"}\n\n')


def test_sse_frames_yields_ids():
    raw = b'id: 1\nevent: a\ndata: {"x":1}\n\nid:17\nevent: b\ndata: {"x":2}\n\n'
    assert _frames(raw) == [("a", {"x": 1}, "1"), ("b", {"x": 2}, "17")]


def test_sse_frames_id_persists():
    raw = b'id: 1\nevent: a\ndata: {"x":1}\n\nevent: b\ndata: {"x":2}\n\n'
    assert _frames(raw) == [("a", {"x": 1}, "1"), ("b", {"x": 2}, "1")]
    raw = b'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"x":2}\n\n'
    assert _frames(raw) == [("a", {"x": 1}, None), ("b", {"x": 2}, None)]


def test_resume_completes_answer(monkeypatch):
    def handler(req):
        if req.method == "POST":
            return httpx.Response(200, headers={"X-Run-Id": "run1"}, stream=Broken(HEAD_WITH_IDS))
        assert req.url.path == "/v1/runs/run1/events"
        assert req.headers["last-event-id"] == "2"
        return httpx.Response(200, content=(
            b': hb\n\n'
            b'id: 3\nevent: delta\ndata: {"text":"B"}\n\n'
            b'id: 4\nevent: done\ndata: {"messageId":"run1","durationMs":5}\n\n'))

    result, requests, _ = _call(monkeypatch, handler)
    assert result == "AB"
    assert len(requests) == 2


def _gone_handler(status, code):
    def handler(req):
        if req.method == "POST":
            return httpx.Response(200, headers={"X-Run-Id": "run1"}, stream=Broken(HEAD_WITH_IDS))
        if req.url.path == "/v1/runs/run1/events":
            return httpx.Response(status, json={"error": {"code": code, "message": "gone"}})
        assert req.url.path == "/v1/runs/run1"
        return httpx.Response(200, json={"runId": "run1", "kind": "ask", "status": "ok",
                                         "endedBy": "done", "messageId": "m1"})

    return handler


def test_resume_404_reports_run_status(monkeypatch):
    result, _, _ = _call(monkeypatch, _gone_handler(404, "not_found"))
    assert isinstance(result, server.AskError)
    text = str(result)
    assert "ok" in text and "done" in text and "m1" in text
    assert "Частичный ответ:\nA" in text


def test_resume_410_replay_gone(monkeypatch):
    result, _, _ = _call(monkeypatch, _gone_handler(410, "replay_gone"))
    assert isinstance(result, server.AskError)
    text = str(result)
    assert "410" in text and "replay_gone" in text and "m1" in text
    assert "Частичный ответ:\nA" in text


def test_resume_skipped_without_run_id(monkeypatch):
    head = b'event: delta\ndata: {"text":"A"}\n\n'
    result, requests, _ = _call(
        monkeypatch, lambda req: httpx.Response(200, stream=Broken(head)))
    assert isinstance(result, server.AskError)
    assert "Частичный ответ:\nA" in str(result)
    assert len(requests) == 1


def test_explicit_key_is_sent(monkeypatch):
    result, requests, _ = _call(
        monkeypatch, lambda req: httpx.Response(200, content=FULL), idempotency_key="k-1")
    assert result == "OK"
    assert len(requests) == 1
    assert requests[0].headers.get_list("idempotency-key") == ["k-1"]


def test_retry_before_first_delta_reuses_key(monkeypatch):
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("down")
        return httpx.Response(200, content=FULL)

    result, requests, pauses = _call(monkeypatch, handler)
    assert result == "OK"
    posts = _posts(requests)
    assert len(posts) == 2
    keys = {p.headers["idempotency-key"] for p in posts}
    assert len(keys) == 1
    assert pauses == [1]


def test_no_retry_after_first_delta(monkeypatch):
    head = b'event: delta\ndata: {"text":"A"}\n\n'
    result, requests, pauses = _call(
        monkeypatch, lambda req: httpx.Response(200, stream=Broken(head)))
    assert isinstance(result, server.AskError)
    assert "Частичный ответ:\nA" in str(result)
    assert len(_posts(requests)) == 1
    assert pauses == []


def test_retry_after_429_is_honoured(monkeypatch):
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(
                429, headers={"Retry-After": "1"},
                json={"error": {"code": "too_many_requests", "message": "slow"}})
        return httpx.Response(200, content=FULL)

    result, requests, pauses = _call(monkeypatch, handler)
    assert result == "OK"
    assert pauses == [1]
    posts = _posts(requests)
    assert len(posts) == 2
    assert posts[0].headers["idempotency-key"] == posts[1].headers["idempotency-key"]


def test_quota_exceeded_is_not_retried(monkeypatch):
    def handler(req):
        return httpx.Response(
            429, headers={"Retry-After": "3600"},
            json={"error": {"code": "quota_exceeded", "message": "limit",
                            "retryAt": "2026-11-01T00:00:00Z"}})

    result, requests, pauses = _call(monkeypatch, handler)
    assert isinstance(result, server.AskError)
    assert "quota_exceeded" in str(result)
    assert "2026-11-01T00:00:00Z" in str(result)
    assert "3600" in str(result)
    assert len(_posts(requests)) == 1
    assert pauses == []


def test_retry_stops_after_four_attempts(monkeypatch):
    def handler(req):
        raise httpx.ConnectError("down")

    result, requests, pauses = _call(monkeypatch, handler)
    assert isinstance(result, server.AskError)
    posts = _posts(requests)
    assert len(posts) == 4
    assert len({p.headers["idempotency-key"] for p in posts}) == 1
    assert pauses == [1, 2, 4]


def test_retry_on_retryable_error_resets_run_state(monkeypatch):
    post_count = []
    event_gets = []

    first = (b'id: 5\nevent: status\ndata: {"state":"starting","runId":"r1"}\n\n'
             b'event: error\ndata: {"code":"overloaded","message":"busy","retryable":true}\n\n')
    second = (b'event: status\ndata: {"state":"writing","runId":"r2"}\n\n'
              b'event: delta\ndata: {"text":"ok"}\n\n')

    def handler(req):
        if req.method == "POST":
            post_count.append(1)
            if len(post_count) == 1:
                return httpx.Response(200, headers={"X-Run-Id": "r1"}, content=first)
            return httpx.Response(200, headers={"X-Run-Id": "r2"}, stream=Broken(second))
        if req.url.path == "/v1/runs/r2/events":
            event_gets.append(req)
            if "last-event-id" in req.headers:
                return httpx.Response(
                    410, json={"error": {"code": "replay_gone", "message": "too old"}})
            return httpx.Response(200, content=(
                b'event: status\ndata: {"state":"writing","runId":"r2"}\n\n'
                b'event: delta\ndata: {"text":"ok"}\n\n'
                b'event: done\ndata: {"messageId":"m2"}\n\n'))
        assert req.url.path == "/v1/runs/r2"
        return httpx.Response(200, json={"runId": "r2", "status": "ok",
                                         "endedBy": "done", "messageId": "m2"})

    result, requests, _ = _call(monkeypatch, handler)
    assert result == "ok"
    posts = _posts(requests)
    assert len(posts) == 2
    assert posts[0].headers["idempotency-key"] == posts[1].headers["idempotency-key"]
    assert len(event_gets) == 1
    assert "last-event-id" not in event_gets[0].headers
