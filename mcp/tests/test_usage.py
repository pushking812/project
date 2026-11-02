"""Офлайн-проверка шага 5 (2.2): usage и limits в результате ask. Ключ и сеть не нужны."""
import asyncio

import httpx

import server

_ORIG_CLIENT = httpx.AsyncClient  # до подмены: _call можно вызывать несколько раз в тесте


def _call(monkeypatch, raw: bytes):
    """Зовёт ask на одном ответе потока; возвращает результат или AskError."""
    monkeypatch.setenv("ASK_API_KEY", "sk-ask-test")

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=raw, headers={"x-run-id": "run1"})

    async def fake_sleep(seconds):
        pass

    orig = _ORIG_CLIENT
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: orig(transport=transport, **k))
    monkeypatch.setattr(server.asyncio, "sleep", fake_sleep)
    try:
        return asyncio.run(server.ask("q"))
    except server.AskError as e:
        return e


STATUS = b'event: status\ndata: {"state":"starting","runId":"run1"}\n\n'
DELTAS = (b'id: 1\nevent: delta\ndata: {"text":"Hel"}\n\n'
          b'id: 2\nevent: delta\ndata: {"text":"lo"}\n\n')
USAGE = b'id: 3\nevent: usage\ndata: {"input":630,"output":41,"costUsd":0.0023}\n\n'
LIMITS = (b'id: 4\nevent: limits\ndata: {"plan":"free","kind":"asks","used":3,"limit":20,'
          b'"resetsAt":"2026-10-18T00:00:00.000Z"}\n\n')
DONE = b'id: 5\nevent: done\ndata: {"messageId":"m1","durationMs":2140}\n\n'


def test_usage_and_limits_in_result(monkeypatch):
    result = _call(monkeypatch, STATUS + DELTAS + USAGE + LIMITS + DONE)
    assert isinstance(result, server.AskResult)
    assert result.usage["input"] == 630
    assert result.usage["output"] == 41
    assert result.usage["costUsd"] == 0.0023
    assert result.limits["used"] == 3
    assert result.limits["limit"] == 20
    assert result.limits["kind"] == "asks"
    assert result.runId == "run1"
    assert result.messageId == "m1"


def test_usage_and_limits_come_before_done(monkeypatch):
    raw = STATUS + DELTAS + USAGE + LIMITS + DONE
    assert raw.rindex(b"event: done") > raw.rindex(b"event: limits") > raw.rindex(b"event: usage")
    result = _call(monkeypatch, raw)
    assert result.usage == {"input": 630, "output": 41, "costUsd": 0.0023}
    assert result.limits is not None and result.limits["plan"] == "free"
    assert result.answer == "Hello"


def test_paid_limits_windows_passed_through(monkeypatch):
    limits = (b'id: 4\nevent: limits\ndata: {"plan":"plus","kind":"windows","used":1.2,"limit":4,'
              b'"resetsAt":null,'
              b'"session":{"plan":"plus","kind":"windows","used":1.2,"limit":4,"resetsAt":null},'
              b'"week":{"plan":"plus","kind":"windows","used":0.5,"limit":20,'
              b'"resetsAt":"2026-11-02T00:00:00.000Z"}}\n\n')
    result = _call(monkeypatch, STATUS + DELTAS + USAGE + limits + DONE)
    assert result.limits == {
        "plan": "plus", "kind": "windows", "used": 1.2, "limit": 4, "resetsAt": None,
        "session": {"plan": "plus", "kind": "windows", "used": 1.2, "limit": 4, "resetsAt": None},
        "week": {"plan": "plus", "kind": "windows", "used": 0.5, "limit": 20,
                 "resetsAt": "2026-11-02T00:00:00.000Z"},
    }


def test_missing_usage_is_none(monkeypatch):
    result = _call(monkeypatch, STATUS + DELTAS + DONE)
    assert result.usage is None
    assert result.limits is None
    assert result.answer == "Hello"


def test_answer_text_unchanged(monkeypatch):
    done = b'id: 5\nevent: done\ndata: {"messageId":"m1","truncated":true}\n\n'
    result = _call(monkeypatch, STATUS + DELTAS + USAGE + LIMITS + done)
    assert result.answer == "Hello\n\n[Ответ обрезан: достигнут лимит длины]"
    plain = _call(monkeypatch, STATUS + DELTAS + USAGE + LIMITS + DONE)
    assert plain.answer == "Hello"


def test_limits_on_error(monkeypatch):
    err = (b'id: 5\nevent: error\n'
           b'data: {"code":"quota_exceeded","message":"limit reached","retryable":false}\n\n')
    result = _call(monkeypatch, STATUS + DELTAS[:DELTAS.index(b"id: 2")] + USAGE + LIMITS + err)
    assert isinstance(result, server.AskError)
    text = str(result)
    assert "quota_exceeded" in text
    assert text.count("использовано 3 из 20") == 1
    assert "Частичный ответ:\nHel" in text
    assert "Retry-After" not in text
    assert "повторите через" not in text
