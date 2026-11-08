"""Режим PROXY_BACKEND=code: задачу ведёт наш сервер (/execute), модель — через /v1/code. Сеть подменена."""
import json

import httpx
import pytest
from starlette.testclient import TestClient

import openai_proxy

_ORIG_CLIENT = httpx.AsyncClient

TOKEN = "proxy-secret-token-0002"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

CLINE_FIRST = ("<task>\nпочини add.js\n</task>\n\n<environment_details>\n# Current Time\n2026-11-08\n"
               "</environment_details>")
CLINE_SECOND = "<task>\nа теперь тесты\n</task>\n\n<environment_details>\nother\n</environment_details>"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("ASK_API_KEY", "sk-ask-test-key-0001")
    monkeypatch.setenv("PROXY_TOKEN", TOKEN)
    monkeypatch.setenv("PROXY_ACCESS_LOG", "off")
    monkeypatch.setenv("PROXY_COMPACT_AT", "off")
    monkeypatch.delenv("PROXY_BACKEND", raising=False)
    monkeypatch.delenv("PROXY_CODE_MODE", raising=False)
    monkeypatch.delenv("ASK_LOCAL_URL", raising=False)


def sse(*events) -> bytes:
    return b"".join(f"event: {e}\ndata: {json.dumps(d)}\n\n".encode() for e, d in events)


TASK = sse(("status", {"state": "thinking"}), ("delta", {"text": "Читаю "}), ("tool", {"name": "read_file", "ok": True}),
           ("delta", {"text": "Готово."}), ("usage", {"input": 100, "output": 7}),
           ("done", {"steps": ["read add.js"], "answer": "Читаю Готово."}))


def install(monkeypatch, execute=None):
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request):
        if req.url.path != "/me":  # замер расхода (/me) тесты задачи не считают
            seen.append(req)
        if req.url.path == "/execute":
            return execute(req) if execute else httpx.Response(200, content=TASK)
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: _ORIG_CLIENT(transport=transport, **k))
    return seen


def post(body):
    with TestClient(openai_proxy.app) as c:
        return c.post("/v1/chat/completions", json=body, headers=AUTH)


def user(text):
    return {"role": "user", "content": text}


def test_session_id_has_time_and_restarts_after_gap(monkeypatch):
    import openai_proxy as p
    clock = [1_000_000.0]
    monkeypatch.setattr(p.time, "time", lambda: clock[0])
    monkeypatch.setattr(p, "_SESSION_SEEN", {})
    a = p._code_session(["задача"])
    clock[0] += 60
    assert p._code_session(["задача"]) == a  # повтор того же запроса — та же сессия
    assert p._code_session(["задача", "ещё"]) == a
    clock[0] += p._SESSION_GAP + 1
    assert p._code_session(["задача", "ещё"]) == a  # диалог продолжается
    clock[0] += p._SESSION_GAP + 1
    b = p._code_session(["задача"])  # пауза и новый диалог с тем же текстом
    assert b != a and b.startswith("cline-") and len(b) <= 64


def test_code_request_logs_used_delta_and_session_total(monkeypatch, capsys):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    monkeypatch.setattr(openai_proxy, "_SESSION_USED", {})
    used = iter([10.0, 10.5, 10.5, 11.0])  # до и после первого запроса, до и после второго

    def handler(req: httpx.Request):
        if req.url.path == "/execute":
            return httpx.Response(200, content=TASK)
        if req.url.path == "/me":
            week = next(used)
            return httpx.Response(200, json={"limits": {"kind": "windows", "windows": {"week": {"used": week}, "session": {"used": week / 10}}}})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: _ORIG_CLIENT(transport=transport, **k))
    monkeypatch.setattr(openai_proxy.time, "time", lambda: 1_000_000.0)
    monkeypatch.setattr(openai_proxy, "_SESSION_SEEN", {})
    body = {"messages": [user(CLINE_FIRST)]}
    assert post(body).status_code == 200
    assert post(body).status_code == 200
    logs = [json.loads(l) for l in capsys.readouterr().err.splitlines() if l.startswith("{") and '"backend"' in l]
    assert logs[0]["used_delta"] == {"week": 0.5, "window": 0.05}
    assert logs[0]["session_used"] == {"week": 0.5, "requests": 1}
    assert logs[1]["session_used"] == {"week": 1.0, "requests": 2}


def test_used_is_skipped_when_me_fails(monkeypatch, capsys):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    install(monkeypatch)  # /me даёт 404
    assert post({"messages": [user(CLINE_FIRST)]}).status_code == 200
    logs = [json.loads(l) for l in capsys.readouterr().err.splitlines() if l.startswith("{") and '"backend"' in l]
    assert "used_delta" not in logs[0] and "session_used" not in logs[0]


def test_default_backend_never_calls_execute(monkeypatch):
    seen = install(monkeypatch)
    post({"messages": [user("привет")]})
    assert not [r for r in seen if r.url.path == "/execute"]


def test_code_backend_sends_clean_task_and_session(monkeypatch):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    monkeypatch.setenv("PROXY_CODE_MODE", "edits")
    seen = install(monkeypatch)
    r = post({"messages": [user(CLINE_FIRST)], "tools": [{"type": "function", "function": {"name": "x"}}]})
    assert r.status_code == 200
    body = json.loads(seen[0].content)
    assert body["prompt"] == "почини add.js"
    assert body["mode"] == "edits"
    assert body["session_id"].startswith("cline-") and len(body["session_id"]) <= 64
    text = r.json()["choices"][0]["message"]["content"]
    assert "Читаю " in text and "Готово." in text and "read_file" in text
    assert r.json()["usage"]["prompt_tokens"] == 100
    assert [x.url.path for x in seen] == ["/execute"]  # к /v1/ask прокси не ходил


def test_code_backend_keeps_session_across_turns(monkeypatch):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    seen = install(monkeypatch)
    post({"messages": [user(CLINE_FIRST)]})
    post({"messages": [user(CLINE_FIRST), {"role": "assistant", "content": "ok"}, user(CLINE_SECOND)]})
    a, b = (json.loads(r.content) for r in seen)
    assert a["session_id"] == b["session_id"]
    assert b["prompt"] == "а теперь тесты"  # прошлые ходы помнит сессия сервера, а не промпт


def test_code_backend_stream(monkeypatch):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    install(monkeypatch)
    r = post({"messages": [user("сделай")], "stream": True})
    assert r.status_code == 200
    data = [ln[6:] for ln in r.text.splitlines() if ln.startswith("data: ")]
    assert data[-1] == "[DONE]"
    chunks = [json.loads(d) for d in data[:-1]]
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks)
    assert "Читаю " in text and "Готово." in text
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"


def test_code_backend_error_before_stream_is_502(monkeypatch):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    install(monkeypatch, execute=lambda req: httpx.Response(
        409, json={"error": "session is busy", "code": "session_busy"}))
    for stream in (False, True):
        r = post({"messages": [user("сделай")], "stream": stream})
        assert r.status_code == 502
        assert "session_busy" in r.json()["error"]["message"]


def test_code_backend_task_error_event_is_shown(monkeypatch):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    install(monkeypatch, execute=lambda req: httpx.Response(
        200, content=sse(("delta", {"text": "Начал."}), ("error", {"message": "the connection to ask dropped"}))))
    text = post({"messages": [user("сделай")]}).json()["choices"][0]["message"]["content"]
    assert "Начал." in text and "the connection to ask dropped" in text


def test_code_backend_without_user_text_is_400(monkeypatch):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    install(monkeypatch)
    r = post({"messages": [{"role": "system", "content": "правила"}]})
    assert r.status_code == 400


def test_tool_line_shows_main_argument():
    s = openai_proxy._State()
    piece = openai_proxy._code_piece(
        "tool", {"name": "write_file", "input": {"path": "helloworld.txt", "content": "secret body"}}, s)
    assert "write_file helloworld.txt" in piece and "secret body" not in piece
    cmd = openai_proxy._code_piece("tool", {"name": "run_command", "input": {"command": "a\n" + "b" * 200}}, s)
    assert "a b" in cmd and len(cmd) < 120
    assert openai_proxy._code_piece("tool", {"name": "other", "input": {"x": 1}}, s).strip() == "▸ other"


def test_tool_line_uses_path_from_our_server_event():
    # наш /execute шлёт {name, ok, callId, path} без input
    s = openai_proxy._State()
    piece = openai_proxy._code_piece("tool", {"name": "read_file", "ok": True, "callId": "1", "path": "a/b.md"}, s)
    assert piece.strip() == "▸ read_file a/b.md"
    bad = openai_proxy._code_piece("tool", {"name": "edit_file", "ok": False, "callId": "2", "path": "x.py"}, s)
    assert "edit_file x.py (отказ/сбой)" in bad
    assert openai_proxy._code_piece("tool", {"name": "run_command", "ok": True, "callId": "3"}, s).strip() == "▸ run_command"


def test_done_event_shows_steps_summary():
    s = openai_proxy._State()
    piece = openai_proxy._code_piece("done", {"steps": ["wrote hello.txt", "ran pytest"], "answer": "x"}, s)
    assert "Сделано на компьютере" in piece and "- wrote hello.txt" in piece and "- ran pytest" in piece
    assert s.done["answer"] == "x"
    assert openai_proxy._code_piece("done", {"steps": []}, openai_proxy._State()) == ""
    many = openai_proxy._code_piece("done", {"steps": [f"s{i}" for i in range(25)]}, openai_proxy._State())
    assert "и ещё 5" in many


def log_lines(capsys) -> list[dict]:
    return [json.loads(ln) for ln in capsys.readouterr().err.splitlines() if ln.startswith("{")]


def test_message_without_task_tag_is_logged_with_head(monkeypatch, capsys):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    monkeypatch.setenv("PROXY_LOG_FILE", "")
    install(monkeypatch)
    post({"messages": [user("[ERROR] Вы не использовали инструмент. " + "x" * 400)]})
    entry = log_lines(capsys)[-1]
    assert entry["no_task_tag"] is True
    assert entry["prompt_head"].startswith("[ERROR] Вы не использовали") and len(entry["prompt_head"]) <= 200


def test_normal_task_has_no_prompt_head(monkeypatch, capsys):
    monkeypatch.setenv("PROXY_BACKEND", "code")
    monkeypatch.setenv("PROXY_LOG_FILE", "")
    install(monkeypatch)
    post({"messages": [user(CLINE_FIRST)]})
    entry = log_lines(capsys)[-1]
    assert "prompt_head" not in entry and "no_task_tag" not in entry
