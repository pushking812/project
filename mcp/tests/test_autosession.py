"""Автосессия MCP: выбор id, файл, переопределения, занятая сессия, инструменты. HTTP подменён MockTransport."""

import asyncio
import json

import httpx
import pytest

from ask_mcp import autosession
from ask_mcp.errors import AskError
from ask_mcp.tools import sessions, tasks

_ORIG_CLIENT = httpx.AsyncClient

DONE = "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in [("delta", {"text": "ok"}), ("done", {"steps": 1})]).encode()


def run(coro):
    return asyncio.run(coro)


def install(monkeypatch, handler):
    seen = []

    def wrapped(req):
        seen.append((req.method, req.url.path, json.loads(req.content) if req.content else None))
        return handler(req)

    transport = httpx.MockTransport(wrapped)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: _ORIG_CLIENT(transport=transport, **k))
    monkeypatch.delenv("ASK_LOCAL_URL", raising=False)
    return seen


def sse_ok(req):
    return httpx.Response(200, content=DONE, headers={"content-type": "text/event-stream"})


@pytest.fixture
def auto(monkeypatch):
    monkeypatch.setenv("ASK_SESSION_AUTO", "true")


def test_generates_and_saves_id_then_survives_restart(auto, tmp_path):
    first = autosession.current()
    assert autosession.SESSION_ID.match(first)
    saved = json.loads((tmp_path / "mcp-session.json").read_text(encoding="utf-8"))
    assert saved == {"session_id": first}
    autosession.reset()  # перезапуск процесса
    assert autosession.current() == first


def test_env_id_overrides_file_but_explicit_choice_overrides_env(auto, monkeypatch):
    stored = autosession.current()
    autosession.reset()
    monkeypatch.setenv("ASK_SESSION_ID", "ci-run-1")
    assert autosession.current() == "ci-run-1"
    autosession.set_current("chosen")
    assert autosession.current() == "chosen"
    autosession.reset()
    monkeypatch.delenv("ASK_SESSION_ID")
    assert autosession.current() == "chosen"  # файл обновлён
    assert stored != "chosen"


def test_auto_false_gives_no_id_and_writes_nothing(monkeypatch, tmp_path):
    assert autosession.current() is None
    autosession.set_current("x")
    assert not (tmp_path / "mcp-session.json").exists()


def test_broken_file_is_replaced(auto, tmp_path):
    (tmp_path / "mcp-session.json").write_text("{не json", encoding="utf-8")
    sid = autosession.current()
    assert json.loads((tmp_path / "mcp-session.json").read_text(encoding="utf-8"))["session_id"] == sid


def test_execute_uses_autosession_but_explicit_id_wins(auto, monkeypatch):
    seen = install(monkeypatch, sse_ok)
    sid = autosession.current()
    run(tasks.execute("a"))
    run(tasks.execute("b", session_id="mine"))
    assert seen[0][2]["session_id"] == sid
    assert seen[1][2]["session_id"] == "mine"


def test_execute_without_auto_sends_no_session(monkeypatch):
    seen = install(monkeypatch, sse_ok)
    run(tasks.execute("a"))
    assert "session_id" not in seen[0][2]


def test_busy_autosession_retries_without_session(auto, monkeypatch):
    calls = []

    def handler(req):
        body = json.loads(req.content)
        calls.append(body.get("session_id"))
        if body.get("session_id"):
            return httpx.Response(409, json={"error": "session x has a task running", "code": "session_busy"})
        return sse_ok(req)

    install(monkeypatch, handler)
    out = json.loads(run(tasks.execute("a")))
    assert out["text"] == "ok"
    assert len(calls) == 2 and calls[0] and calls[1] is None


def test_busy_explicit_session_is_an_error(auto, monkeypatch):
    install(monkeypatch, lambda req: httpx.Response(409, json={"error": "busy", "code": "session_busy"}))
    with pytest.raises(AskError, match="session_busy"):
        run(tasks.execute("a", session_id="mine"))


def test_start_task_does_not_use_autosession(auto, monkeypatch):
    seen = install(monkeypatch, lambda req: httpx.Response(200, json={"ok": True, "taskId": "t"}))
    run(tasks.start_task("a"))
    assert "session_id" not in seen[0][2]


def test_new_and_resume_switch_the_autosession(auto, monkeypatch):
    install(monkeypatch, lambda req: httpx.Response(200, json={"ok": True, "session_id": "N1"}))
    run(sessions.new_session("t"))
    assert autosession.current() == "N1"
    install(monkeypatch, lambda req: httpx.Response(200, json={"ok": True, "session_id": "R2", "history": []}))
    run(sessions.resume_session("R2"))
    assert autosession.current() == "R2"
    autosession.reset()
    assert autosession.current() == "R2"


def test_session_info(auto, monkeypatch):
    sid = autosession.current()
    seen = install(monkeypatch, lambda req: httpx.Response(
        200, json={"ok": True, "history": [{}, {}, {}, {}, {}], "title": "T", "savedAt": "2026-11-04T10:00:00Z"}))
    out = json.loads(run(sessions.session_info()))
    assert seen[0][1] == f"/sessions/{sid}"
    assert out == {"session_id": sid, "title": "T", "requests": 3, "savedAt": "2026-11-04T10:00:00Z", "saved": True}


def test_session_info_for_unsaved_and_disabled(auto, monkeypatch):
    sid = autosession.current()
    install(monkeypatch, lambda req: httpx.Response(404, json={"error": "no session", "code": "not_found"}))
    out = json.loads(run(sessions.session_info()))
    assert out["session_id"] == sid and out["requests"] == 0 and out["saved"] is False
    monkeypatch.setenv("ASK_SESSION_AUTO", "false")
    assert json.loads(run(sessions.session_info())) == {"session_id": None, "auto": False}
