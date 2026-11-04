"""Офлайн-проверка инструментов бэкенда api: наш HTTP API подменён MockTransport, сервер и сеть не нужны."""

import asyncio
import base64
import json

import httpx
import pytest
from mcp.server.fastmcp import FastMCP, Image

import server
from ask_mcp import api_client
from ask_mcp.tools import all_tools, browser, files, memory, service, sessions, tasks, watches

_ORIG_CLIENT = httpx.AsyncClient  # до подмены


def sse(*events: tuple[str, dict]) -> bytes:
    return "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events).encode()


def install(monkeypatch, handler):
    """Подменяет httpx.AsyncClient; возвращает список увиденных запросов (метод, путь, query, тело)."""
    seen: list[tuple[str, str, dict, object]] = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        raw_path = req.url.raw_path.split(b"?")[0].decode()  # как ушло по сети, до раскодирования
        seen.append((req.method, raw_path, dict(req.url.params), body))
        return handler(req)

    transport = httpx.MockTransport(wrapped)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: _ORIG_CLIENT(transport=transport, **k))
    monkeypatch.delenv("ASK_LOCAL_URL", raising=False)
    return seen


def json_reply(payload: dict, status: int = 200):
    return lambda req: httpx.Response(status, json=payload)


def stream_reply(raw: bytes):
    return lambda req: httpx.Response(200, content=raw, headers={"content-type": "text/event-stream"})


def run(coro):
    return asyncio.run(coro)


# --- регистрация -------------------------------------------------------------------------------

def names(backend: str) -> set[str]:
    m = FastMCP("t")
    server.register_tools(m, backend)
    return {t.name for t in run(m.list_tools())}


def test_every_group_has_tools_and_names_are_unique():
    fns = all_tools()
    assert len(fns) == len({f.__name__ for f in fns}) >= 40
    for group in (tasks, files, memory, sessions, browser, watches, service):
        assert group.TOOLS
    for fn in fns:
        assert fn.__doc__ and fn.__doc__.strip(), f"у {fn.__name__} нет описания"


def test_backends_register_expected_names():
    api, legacy, both = names("api"), names("legacy"), names("both")
    assert legacy == {"ask", "get_usage", "code"}
    assert {"execute", "start_task", "read_file", "browser_open", "doctor"} <= api
    assert not {"get_usage", "code"} & api
    assert both == api | {"legacy_ask", "legacy_get_usage", "legacy_code"}


def test_default_backend_and_bad_value(monkeypatch):
    from ask_mcp import config
    monkeypatch.delenv("MCP_BACKEND", raising=False)
    assert config.backend() == "api"
    monkeypatch.setenv("MCP_BACKEND", "both")
    assert config.backend() == "both"
    monkeypatch.setenv("MCP_BACKEND", "zzz")
    with pytest.raises(SystemExit) as exc:
        config.backend()
    assert exc.value.code == 2


def test_old_names_still_importable_from_server():
    for name in ("ask", "get_usage", "code", "AskError", "_ask_stream", "_headers", "_State", "_sse_frames"):
        assert hasattr(server, name)


# --- задачи ------------------------------------------------------------------------------------

def test_execute_folds_stream_and_sends_only_set_fields(monkeypatch):
    raw = sse(("status", {"state": "thinking"}), ("delta", {"text": "Гото"}),
              ("tool", {"name": "write_file", "ok": True, "callId": "c1"}), ("delta", {"text": "во."}),
              ("usage", {"input": 5, "output": 2}), ("session", {"session_id": "S1", "requests": 1}),
              ("done", {"steps": ["wrote a"], "answer": "Готово."}))
    seen = install(monkeypatch, stream_reply(raw))
    out = json.loads(run(tasks.execute("create a", mode="plan", session_id="S1", browser=True)))
    assert seen[0][:2] == ("POST", "/execute")
    assert seen[0][3] == {"prompt": "create a", "mode": "plan", "session_id": "S1", "browser": True}
    assert out["text"] == "Готово."
    assert out["tools"] == [{"name": "write_file", "ok": True}]
    assert out["usage"] == {"input": 5, "output": 2}
    assert out["done"]["steps"] == ["wrote a"]


def test_execute_maps_camel_case_fields(monkeypatch):
    seen = install(monkeypatch, stream_reply(sse(("done", {}))))
    run(tasks.execute("x", allowed_sites=["a.com"], headless=False, captcha="handoff"))
    assert seen[0][3] == {"prompt": "x", "allowedSites": ["a.com"], "headless": False, "captcha": "handoff"}


def test_files_are_sent_by_ask_execute_start(monkeypatch):
    seen = install(monkeypatch, stream_reply(sse(("done", {}))))
    run(tasks.ask("q", files=["a.pdf", "b.png"]))
    run(tasks.execute("x", files=["a.xlsx"]))
    assert seen[0][3] == {"prompt": "q", "useContext": True, "files": ["a.pdf", "b.png"]}
    assert seen[1][3] == {"prompt": "x", "files": ["a.xlsx"]}
    seen2 = install(monkeypatch, json_reply({"taskId": "T"}))
    run(tasks.start_task("x", files=["n.txt"]))
    assert seen2[0][3] == {"prompt": "x", "files": ["n.txt"]}


def test_files_not_sent_when_empty(monkeypatch):
    seen = install(monkeypatch, stream_reply(sse(("done", {}))))
    run(tasks.ask("q"))
    run(tasks.ask("q", files=[]))
    run(tasks.execute("x"))
    assert "files" not in seen[0][3] and "files" not in seen[1][3] and "files" not in seen[2][3]


def test_execute_returns_output_files(monkeypatch):
    install(monkeypatch, stream_reply(sse(("done", {"output_files": ["report.md", "src/a.js"]}))))
    out = json.loads(run(tasks.execute("x")))
    assert out["output_files"] == ["report.md", "src/a.js"]
    assert out["done"]["output_files"] == ["report.md", "src/a.js"]


def test_execute_without_output_files_has_no_key(monkeypatch):
    install(monkeypatch, stream_reply(sse(("done", {"steps": []}))))
    assert "output_files" not in json.loads(run(tasks.execute("x")))


def test_analyze_read_uses_ask_with_file(monkeypatch):
    from ask_mcp.tools import analysis
    seen = install(monkeypatch, stream_reply(sse(("delta", {"text": "3 листа"}), ("usage", {"input": 1}), ("done", {}))))
    out = json.loads(run(analysis.analyze("hello.xlsx", "опиши")))
    assert seen[0][:2] == ("POST", "/ask")
    assert seen[0][3] == {"prompt": "опиши", "files": ["hello.xlsx"], "useContext": True}
    assert out == {"text": "3 листа", "usage": {"input": 1}}


def test_analyze_write_uses_execute_and_returns_output_files(monkeypatch):
    from ask_mcp.tools import analysis
    raw = sse(("delta", {"text": "Готово"}), ("done", {"answer": "Готово.", "output_files": ["report.xlsx"]}))
    seen = install(monkeypatch, stream_reply(raw))
    out = json.loads(run(analysis.analyze("hello.xlsx", "создай отчёт", mode="write")))
    assert seen[0][:2] == ("POST", "/execute")
    assert seen[0][3] == {"prompt": "создай отчёт", "files": ["hello.xlsx"], "mode": "all"}
    assert out == {"answer": "Готово.", "output_files": ["report.xlsx"]}


def test_analyze_write_without_files_omits_key(monkeypatch):
    from ask_mcp.tools import analysis
    install(monkeypatch, stream_reply(sse(("delta", {"text": "Нет"}), ("done", {}))))
    assert json.loads(run(analysis.analyze("a.py", "x", mode="write"))) == {"answer": "Нет"}


@pytest.mark.parametrize("args", [("a.py", "x", "bad"), ("", "x", "read"), ("a.py", " ", "read")])
def test_analyze_validates_input_without_request(monkeypatch, args):
    from ask_mcp.tools import analysis
    seen = install(monkeypatch, stream_reply(sse(("done", {}))))
    with pytest.raises(server.AskError):
        run(analysis.analyze(*args))
    assert seen == []


def test_wrappers_send_their_prompt(monkeypatch):
    from ask_mcp.tools import analysis
    monkeypatch.delenv("ASK_LANG", raising=False)
    seen = install(monkeypatch, stream_reply(sse(("delta", {"text": "ok"}), ("done", {}))))
    for fn in (analysis.review, analysis.summarize, analysis.explain):
        run(fn("a.py"))
    run(analysis.plan("добавить тесты"))
    assert [s[3].get("files") for s in seen] == [["a.py"], ["a.py"], ["a.py"], None]
    assert "ошибки" in seen[0][3]["prompt"] and "краткое" in seen[1][3]["prompt"].lower()
    assert "Объясни" in seen[2][3]["prompt"]
    assert "добавить тесты" in seen[3][3]["prompt"] and seen[3][3]["useContext"] is True
    monkeypatch.setenv("ASK_LANG", "en")
    run(analysis.summarize("a.py"))
    assert "summary" in seen[4][3]["prompt"]


def test_error_event_keeps_partial_answer(monkeypatch):
    raw = sse(("delta", {"text": "половина"}), ("error", {"message": "the connection to ask dropped"}))
    install(monkeypatch, stream_reply(raw))
    with pytest.raises(server.AskError) as exc:
        run(tasks.execute("x"))
    assert "dropped" in str(exc.value) and "половина" in str(exc.value)


def test_stream_without_done_is_an_error(monkeypatch):
    install(monkeypatch, stream_reply(sse(("delta", {"text": "обрыв"}))))
    with pytest.raises(server.AskError) as exc:
        run(tasks.ask("q"))
    assert "оборвался" in str(exc.value) and "обрыв" in str(exc.value)


def test_ask_sends_use_context(monkeypatch):
    seen = install(monkeypatch, stream_reply(sse(("delta", {"text": "ok"}), ("usage", {"input": 1}), ("done", {}))))
    out = json.loads(run(tasks.ask("q", use_context=False)))
    assert seen[0][3] == {"prompt": "q", "useContext": False}
    assert out == {"text": "ok", "usage": {"input": 1}}


def test_start_status_stop(monkeypatch):
    seen = install(monkeypatch, json_reply({"taskId": "T", "status": "running"}))
    assert json.loads(run(tasks.start_task("x")))["taskId"] == "T"
    run(tasks.task_status("T"))
    run(tasks.stop_task("T"))
    assert [s[:2] for s in seen] == [("POST", "/start"), ("GET", "/status/T"), ("POST", "/stop/T")]


def test_path_segments_are_quoted(monkeypatch):
    seen = install(monkeypatch, json_reply({"ok": True}))
    run(tasks.task_status("../health"))
    run(memory.read_memory("a/b.md"))
    run(sessions.get_session("x y"))
    assert [s[1] for s in seen] == ["/status/..%2Fhealth", "/memory/a%2Fb.md", "/sessions/x%20y"]


# --- ошибки API --------------------------------------------------------------------------------

@pytest.mark.parametrize("payload,status,expect", [
    ({"error": "prompt is required", "code": "bad_request"}, 400, "400 bad_request: prompt is required"),
    ({"error": "plan mode", "code": "plan_mode"}, 403, "403 plan_mode"),
    ({"error": "too many tasks"}, 429, "429: too many tasks"),
    ({"error": {"code": "x", "message": "nested"}}, 500, "500 x: nested"),
])
def test_http_errors_become_ask_error(monkeypatch, payload, status, expect):
    install(monkeypatch, json_reply(payload, status))
    with pytest.raises(server.AskError) as exc:
        run(files.write_file("a", "b", mode="plan"))
    assert expect in str(exc.value)


def test_non_json_error_body(monkeypatch):
    install(monkeypatch, lambda req: httpx.Response(502, content=b"<html>bad gateway</html>"))
    with pytest.raises(server.AskError) as exc:
        run(tasks.me())
    assert "HTTP 502" in str(exc.value)


def test_server_down_message(monkeypatch):
    def refuse(req):
        raise httpx.ConnectError("refused", request=req)

    install(monkeypatch, refuse)
    with pytest.raises(server.AskError) as exc:
        run(tasks.health())
    assert "npm start" in str(exc.value) and "127.0.0.1:8737" in str(exc.value)


def test_remote_url_refused_without_allow(monkeypatch):
    install(monkeypatch, json_reply({"ok": True}))
    monkeypatch.setenv("ASK_LOCAL_URL", "http://192.168.1.5:8737")
    monkeypatch.delenv("ASK_ALLOW_REMOTE", raising=False)
    with pytest.raises(server.AskError) as exc:
        run(tasks.health())
    assert "ASK_ALLOW_REMOTE" in str(exc.value)
    monkeypatch.setenv("ASK_ALLOW_REMOTE", "1")
    assert json.loads(run(tasks.health())) == {"ok": True}


def test_custom_local_url_is_used(monkeypatch):
    seen_hosts = []

    def handler(req):
        seen_hosts.append(req.url.host + ":" + str(req.url.port))
        return httpx.Response(200, json={"ok": True})

    install(monkeypatch, handler)
    monkeypatch.setenv("ASK_LOCAL_URL", "http://localhost:9999/")
    run(tasks.health())
    assert seen_hosts == ["localhost:9999"]


# --- файлы, память, сессии, служебные ---------------------------------------------------------

def test_file_tools_routes_and_bodies(monkeypatch):
    seen = install(monkeypatch, json_reply({"ok": True, "output": "x"}))
    run(files.read_file("a.txt", offset=2))
    run(files.list_files())
    run(files.search("TODO", regex=True))
    run(files.write_file("a.txt", "hi", overwrite=False))
    run(files.edit_file("a.txt", "hi", "yo", mode="edits"))
    run(files.run_command("node -v", timeout_sec=20))
    assert [(m, p, b) for m, p, _, b in seen] == [
        ("POST", "/read", {"path": "a.txt", "offset": 2}),
        ("POST", "/list", {}),
        ("POST", "/search", {"pattern": "TODO", "regex": True}),
        ("POST", "/write", {"path": "a.txt", "content": "hi", "overwrite": False}),
        ("POST", "/edit", {"path": "a.txt", "old_text": "hi", "new_text": "yo", "mode": "edits"}),
        ("POST", "/command", {"command": "node -v", "timeout_sec": 20}),
    ]


def test_clear_memory_needs_confirm(monkeypatch):
    seen = install(monkeypatch, json_reply({"ok": True}))
    with pytest.raises(server.AskError):
        run(memory.clear_memory())
    assert seen == []  # без confirm запроса нет
    run(memory.clear_memory(confirm=True))
    assert seen[0][:3] == ("DELETE", "/memory", {"mode": "all"})


def test_workspace_tools(monkeypatch):
    from ask_mcp.tools import workspace

    seen = install(monkeypatch, json_reply({"ok": True, "root": "/p"}))
    run(workspace.get_workspace())
    run(workspace.set_workspace("src"))
    run(workspace.set_workspace("/p", mode="edits"))
    assert [(m, p) for m, p, _, _ in seen] == [("GET", "/workspace"), ("POST", "/workspace"), ("POST", "/workspace")]
    assert seen[1][3] == {"path": "src"}  # None не уходит в запрос
    assert seen[2][3] == {"path": "/p", "mode": "edits"}
    assert {"get_workspace", "set_workspace"} <= names("api")


def test_workspace_errors_keep_the_code(monkeypatch):
    from ask_mcp.tools import workspace

    install(monkeypatch, json_reply({"error": "2 task(s) are running", "code": "tasks_running"}, 409))
    with pytest.raises(server.AskError, match="409 tasks_running"):
        run(workspace.set_workspace("/p"))


def test_memory_notes_sessions_service_routes(monkeypatch):
    seen = install(monkeypatch, json_reply({"ok": True}))
    run(memory.get_notes("sub"))
    run(memory.remember("n"))
    run(memory.list_memory())
    run(memory.write_memory("t.md", content="c"))
    run(sessions.list_sessions())
    run(sessions.new_session("demo"))
    run(sessions.resume_session("S"))
    run(sessions.export_session("S", filename="d.md"))
    run(service.get_context(session_id="S"))
    run(service.get_status())
    run(service.list_models())
    run(service.set_model("sonnet"))
    run(service.doctor())
    run(service.report_bug("text"))
    run(watches.list_watches())
    run(watches.add_watch('https://x.com every 5m for "a"'))
    run(watches.remove_watch("1"))
    run(watches.remove_all_watches())
    run(watches.list_apps())
    run(watches.stop_app(2))
    run(watches.stop_all_apps())
    assert [(m, p) for m, p, _, _ in seen] == [
        ("GET", "/notes"), ("POST", "/remember"), ("GET", "/memory"), ("POST", "/memory"),
        ("GET", "/sessions"), ("POST", "/sessions"), ("POST", "/sessions/resume"), ("POST", "/sessions/S/export"),
        ("GET", "/context"), ("GET", "/status"), ("GET", "/models"), ("POST", "/model"), ("GET", "/doctor"),
        ("POST", "/bug"), ("GET", "/watches"), ("POST", "/watches"), ("DELETE", "/watches/1"),
        ("DELETE", "/watches"), ("GET", "/apps"), ("DELETE", "/apps/2"), ("DELETE", "/apps"),
    ]
    assert seen[0][2] == {"folder": "sub"}
    assert seen[8][2] == {"session_id": "S"}
    assert seen[14 + 1][3] == {"spec": 'https://x.com every 5m for "a"'}


def test_compact_returns_summary(monkeypatch):
    raw = sse(("delta", {"text": "резю"}), ("usage", {"input": 9, "output": 3}),
              ("done", {"summary": "резюме", "requests": 2, "session_id": "S"}))
    install(monkeypatch, stream_reply(raw))
    out = json.loads(run(service.compact(focus="API")))
    assert out == {"summary": "резюме", "requests": 2, "session_id": "S", "usage": {"input": 9, "output": 3}}


# --- браузер -----------------------------------------------------------------------------------

PNG = base64.b64encode(b"\x89PNG-fake").decode()


def test_browser_screenshot_returned_as_image_block(monkeypatch):
    seen = install(monkeypatch, json_reply({
        "ok": True, "output": "Now at: http://x/", "captcha": None, "handoff_needed": False,
        "images": [{"mediaType": "image/jpeg", "data": PNG}]}))
    out = run(browser.browser_open("http://x/", headless=False))
    assert seen[0][3] == {"action": "open", "url": "http://x/", "headless": False}
    assert isinstance(out, list) and len(out) == 2
    text, img = out
    assert "images" not in json.loads(text) and json.loads(text)["output"] == "Now at: http://x/"
    assert isinstance(img, Image) and img.data == b"\x89PNG-fake" and img._format == "jpeg"


def test_browser_without_images_is_plain_text(monkeypatch):
    install(monkeypatch, json_reply({"ok": True, "output": "closed"}))
    assert json.loads(run(browser.browser_close())) == {"ok": True, "output": "closed"}


def test_browser_action_fields(monkeypatch):
    seen = install(monkeypatch, json_reply({"ok": True, "output": "."}))
    run(browser.browser_click(selector="text=Войти", allowed_sites=["a.com"]))
    run(browser.browser_type("погода", selector="input[name=q]"))
    run(browser.browser_press())
    run(browser.browser_scroll(dy=-100))
    run(browser.browser_viewport(width=390))
    run(browser.browser_state())
    run(browser.browser_handoff_done(note="готово"))
    assert [(m, p, b) for m, p, _, b in seen] == [
        ("POST", "/browser", {"action": "click", "selector": "text=Войти", "allowedSites": ["a.com"]}),
        ("POST", "/browser", {"action": "type", "text": "погода", "selector": "input[name=q]"}),
        ("POST", "/browser", {"action": "press", "key": "Enter"}),
        ("POST", "/browser", {"action": "scroll", "dy": -100}),
        ("POST", "/browser", {"action": "viewport", "width": 390}),
        ("GET", "/browser", None),
        ("POST", "/browser/handoff/done", {"note": "готово"}),
    ]


def test_browser_handoff_stream(monkeypatch):
    raw = sse(("status", {"state": "waiting", "todo": "captcha"}), ("delta", {"text": "moved"}),
              ("done", {"answer": "ok", "how": "done", "images": [{"mediaType": "image/jpeg", "data": PNG}]}))
    install(monkeypatch, stream_reply(raw))
    out = run(browser.browser_handoff("Пройдите капчу", headless=False))
    text, img = out
    events = json.loads(text)["events"]
    assert [e["event"] for e in events] == ["status", "delta", "done"]
    assert events[2]["how"] == "done" and "images" not in events[2]
    assert isinstance(img, Image)


def test_browser_captcha_handoff_result_then_events(monkeypatch):
    """captcha=handoff: сервер отвечает потоком, первым событием идёт обычный результат действия."""
    raw = sse(("result", {"ok": True, "output": "Now at: http://x/", "captcha": {"kind": "reCAPTCHA", "blocking": True}}),
              ("status", {"state": "waiting"}), ("done", {"how": "done"}))
    seen = install(monkeypatch, stream_reply(raw))
    out = json.loads(run(browser.browser_open("http://x/", captcha="handoff")))
    assert seen[0][3]["captcha"] == "handoff"
    assert out["events"][0]["event"] == "result" and out["events"][0]["captcha"]["blocking"] is True


def test_browser_handoff_error_event_raises(monkeypatch):
    install(monkeypatch, stream_reply(sse(("error", {"message": "stopped"}))))
    with pytest.raises(server.AskError) as exc:
        run(browser.browser_handoff("x"))
    assert "stopped" in str(exc.value)


def test_browser_409_while_handoff(monkeypatch):
    install(monkeypatch, json_reply({"error": "window is with the person", "code": "handoff_active"}, 409))
    with pytest.raises(server.AskError) as exc:
        run(browser.browser_read())
    assert "409 handoff_active" in str(exc.value)
