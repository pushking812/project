"""Офлайн-проверка M2.1: history в ask и событие folded. Ключ и сеть не нужны."""
import asyncio
import json

import httpx
import pytest

import server

_ORIG_CLIENT = httpx.AsyncClient

STATUS = b'event: status\ndata: {"state":"starting","runId":"run1"}\n\n'
DELTAS = (b'id: 1\nevent: delta\ndata: {"text":"Hel"}\n\n'
          b'id: 2\nevent: delta\ndata: {"text":"lo"}\n\n')
DONE = b'id: 5\nevent: done\ndata: {"messageId":"m1"}\n\n'

HIST = [{"role": "user", "text": "Привет"}, {"role": "assistant", "text": "Здравствуйте"}]


def _install(monkeypatch, handler):
    monkeypatch.setenv("ASK_API_KEY", "sk-ask-test")

    async def fake_sleep(seconds):
        pass

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: _ORIG_CLIENT(transport=transport, **k))
    monkeypatch.setattr(server.asyncio, "sleep", fake_sleep)


def _run(monkeypatch, raw: bytes, **kwargs):
    """Зовёт ask; возвращает (результат, список тел POST, число вызовов handler)."""
    bodies: list[dict] = []
    calls = [0]

    def handler(req: httpx.Request) -> httpx.Response:
        calls[0] += 1
        bodies.append(json.loads(req.content))
        return httpx.Response(200, content=raw, headers={"x-run-id": "run1"})

    _install(monkeypatch, handler)
    return asyncio.run(server.ask("q", **kwargs)), bodies, calls[0]


def test_history_in_request_body(monkeypatch):
    _, bodies, _ = _run(monkeypatch, STATUS + DELTAS + DONE, history=HIST)
    assert bodies[0]["history"] == HIST
    assert bodies[0]["prompt"] == "q"


def test_history_absent_when_none(monkeypatch):
    _, bodies, _ = _run(monkeypatch, STATUS + DELTAS + DONE)
    assert "history" not in bodies[0]
    _, bodies, _ = _run(monkeypatch, STATUS + DELTAS + DONE, history=[])
    assert "history" not in bodies[0]


def test_history_too_long_refused(monkeypatch):
    many = [{"role": "user", "text": "x"}] * 401
    with pytest.raises(server.AskError) as e:
        _run(monkeypatch, STATUS + DELTAS + DONE, history=many)
    assert "400" in str(e.value)
    # граница: ровно 400 проходит, и HTTP при отказе не вызывался
    _, bodies, calls = _run(monkeypatch, STATUS + DELTAS + DONE, history=many[:400])
    assert len(bodies[0]["history"]) == 400 and calls == 1
    refused_calls = [0]

    def handler(req):
        refused_calls[0] += 1
        return httpx.Response(200, content=STATUS + DELTAS + DONE)

    _install(monkeypatch, handler)
    with pytest.raises(server.AskError):
        asyncio.run(server.ask("q", history=many))
    assert refused_calls[0] == 0


def test_history_bad_element_refused(monkeypatch):
    bad = [{"role": "user", "text": "ok"}, {"role": "user"}]
    with pytest.raises(server.AskError) as e:
        _run(monkeypatch, STATUS + DELTAS + DONE, history=bad)
    assert "элемента 2" in str(e.value) and "ни text, ни files" in str(e.value)
    for wrong, part in (([5], "элемент 1 — не объект"), ([{"text": "a"}], "элемента 1 нет role"),
                        ([{"role": "", "text": "a"}], "элемента 1 нет role")):
        with pytest.raises(server.AskError) as e2:
            _run(monkeypatch, STATUS + DELTAS + DONE, history=wrong)
        assert part in str(e2.value)


def test_history_order_kept(monkeypatch):
    hist = [{"role": "assistant", "text": "a"}, {"role": "user", "text": "b"},
            {"role": "assistant", "text": "c", "extra": 1}]
    _, bodies, _ = _run(monkeypatch, STATUS + DELTAS + DONE, history=hist)
    assert bodies[0]["history"] == hist
    assert [m["text"] for m in bodies[0]["history"]] == ["a", "b", "c"]


def test_folded_event_kept(monkeypatch):
    folded = b'id: 3\nevent: folded\ndata: {"summary":"recap","count":12}\n\n'
    result, _, _ = _run(monkeypatch, STATUS + DELTAS + folded + DONE, history=HIST)
    assert result.folded == {"summary": "recap", "count": 12}
    assert result.answer == "Hello"
    plain, _, _ = _run(monkeypatch, STATUS + DELTAS + DONE)
    assert plain.folded is None


def test_history_with_resume(monkeypatch):
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "POST":
            bodies.append(json.loads(req.content))
            return httpx.Response(200, content=STATUS + DELTAS[:DELTAS.index(b"id: 2")],
                                  headers={"x-run-id": "run1"})
        assert req.url.path == "/v1/runs/run1/events"
        return httpx.Response(200, content=DELTAS[DELTAS.index(b"id: 2"):] + DONE)

    _install(monkeypatch, handler)
    result = asyncio.run(server.ask("q", history=HIST))
    assert result.answer == "Hello"
    assert len(bodies) >= 1
    assert all(b["history"] == HIST for b in bodies)
