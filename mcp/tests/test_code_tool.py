"""Офлайн-проверка инструмента code: /v1/code подменён MockTransport, ключ и сеть не нужны."""
import asyncio
import json

import httpx
import pytest

import server
from ask_mcp.legacy import code as code_module

_ORIG_CLIENT = httpx.AsyncClient  # до подмены


def sse(*events: tuple[str, dict]) -> bytes:
    return "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events).encode()


def tool(name: str, call: str, **inp) -> tuple[str, dict]:
    return "tool", {"name": name, "input": inp, "callId": call, "runId": "RUN"}


def delta(text: str) -> tuple[str, dict]:
    return "delta", {"text": text}


STATUS = ("status", {"state": "running", "runId": "RUN"})
DONE = ("done", {"messageId": "m1"})


@pytest.fixture
def root(monkeypatch, tmp_path):
    monkeypatch.setenv("ASK_API_KEY", "sk-ask-test")
    monkeypatch.setattr(code_module, "CODE_ROOT", str(tmp_path))  # настройка живёт в модуле, не в server
    return tmp_path


def run_code(monkeypatch, raw=None, start=None, **kw):
    """Гоняет server.code; возвращает (результат, список запросов (метод, путь, тело))."""
    seen: list[tuple[str, str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        seen.append((req.method, req.url.path, body))
        if req.url.path == "/v1/code":
            if start is not None:
                return start
            return httpx.Response(200, content=raw, headers={"x-run-id": "RUN"})
        return httpx.Response(200, json={})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: _ORIG_CLIENT(transport=transport, **k))
    return asyncio.run(server.code(**kw)), seen


def posted(seen, call: str):
    return next(b for m, p, b in seen if m == "POST" and p == f"/v1/code/RUN/tools/{call}")


def test_code_writes_file(monkeypatch, root):
    raw = sse(STATUS, delta("Гото"), tool("write_file", "CALL", path="pkg/a.txt", content="hello"),
              delta("во."), DONE)
    out, seen = run_code(monkeypatch, raw, task="создай pkg/a.txt", model="claude-haiku-5-5")
    assert (root / "pkg" / "a.txt").read_text(encoding="utf-8") == "hello"
    assert posted(seen, "CALL")["ok"] is True
    data = json.loads(out)
    assert data["status"] == "done"
    assert data["answer"] == "Готово."
    assert data["steps"] == [{"name": "write_file", "ok": True}]
    assert data["runId"] == "RUN"
    assert seen[0][2] == {"prompt": "создай pkg/a.txt", "folder": root.name, "model": "claude-haiku-5-5"}
    with pytest.raises(server.AskError):  # пустая задача не уходит в API
        asyncio.run(server.code(task="   "))


def test_edit_file_needs_unique_old_text(monkeypatch, root):
    (root / "f.txt").write_text("aa bb aa", encoding="utf-8")
    raw = sse(STATUS,
              tool("edit_file", "DUP", path="f.txt", old_text="aa", new_text="cc"),
              tool("edit_file", "ONE", path="f.txt", old_text="bb", new_text="dd"),
              DONE)
    _, seen = run_code(monkeypatch, raw, task="x")
    dup = posted(seen, "DUP")
    assert dup["ok"] is False and "2" in dup["output"]
    # дубль файл не тронул, единственное вхождение заменилось
    assert (root / "f.txt").read_text(encoding="utf-8") == "aa dd aa"
    assert posted(seen, "ONE")["ok"] is True


def test_write_outside_root_refused(monkeypatch, root):
    target = root.parent / "abs.txt"
    raw = sse(STATUS,
              tool("write_file", "REL", path="../evil.txt", content="x"),
              tool("write_file", "ABS", path=str(target), content="x"),
              tool("write_file", "SIB", path=f"../{root.name}x/s.txt", content="x"),
              DONE)
    _, seen = run_code(monkeypatch, raw, task="x")
    assert posted(seen, "REL")["ok"] is False
    assert posted(seen, "ABS")["ok"] is False
    assert posted(seen, "SIB")["ok"] is False  # соседняя папка с тем же началом имени
    assert not (root.parent / "evil.txt").exists() and not target.exists()
    assert not (root.parent / f"{root.name}x").exists()
    for bad in ("../x", "..", "/etc/passwd", "C:/x"):
        with pytest.raises(RuntimeError):
            server._code_rel(bad)
    assert server._code_rel("sub/../x.txt") == "x.txt"


def test_env_is_denied(monkeypatch, root):
    (root / ".env").write_text("ASK_API_KEY=secret", encoding="utf-8")
    raw = sse(STATUS,
              tool("write_file", "W", path=".env", content="x"),
              tool("read_file", "R", path=".env"),
              DONE)
    _, seen = run_code(monkeypatch, raw, task="x")
    assert posted(seen, "W")["ok"] is False
    read = posted(seen, "R")
    assert read["ok"] is False and "secret" not in read["output"]
    assert (root / ".env").read_text(encoding="utf-8") == "ASK_API_KEY=secret"


def test_unknown_tool_reported(monkeypatch, root):
    raw = sse(STATUS, tool("run_command", "CALL", command="dir"), DONE)
    out, seen = run_code(monkeypatch, raw, task="x")
    body = posted(seen, "CALL")
    assert body["ok"] is False and "неизвестный инструмент" in body["output"]
    assert json.loads(out)["status"] == "done"


def test_step_budget_stops_run(monkeypatch, root):
    raw = sse(STATUS,
              tool("write_file", "A", path="one.txt", content="1"),
              tool("write_file", "B", path="two.txt", content="2"),
              DONE)
    out, seen = run_code(monkeypatch, raw, task="x", max_steps=1)
    data = json.loads(out)
    assert data["status"] == "budget"
    assert data["steps"] == [{"name": "write_file", "ok": True}]
    assert (root / "one.txt").exists() and not (root / "two.txt").exists()
    assert posted(seen, "B")["ok"] is False
    assert ("POST", "/v1/runs/RUN/stop", None) in seen


def test_code_http_error(monkeypatch, root, capsys):
    start = httpx.Response(401, json={"error": {"code": "unauthorized", "message": "bad key"}})
    with pytest.raises(server.AskError) as exc:
        run_code(monkeypatch, start=start, task="секретная задача")
    assert "unauthorized" in str(exc.value) and "bad key" in str(exc.value)
    line = [ln for ln in capsys.readouterr().err.splitlines() if ln.startswith("{")][-1]
    rec = json.loads(line)
    assert rec["tool"] == "code" and rec["status"] == "error" and rec["prompt_chars"] == len("секретная задача")
    assert "секретн" not in line and "sk-ask" not in line


def test_tools_unit(root):
    (root / "a.txt").write_text("\n".join(f"line {i}" for i in range(1, 11)), encoding="utf-8")
    (root / "sub").mkdir()
    (root / "sub" / "b.py").write_text("needle = 1\nother = 2\n", encoding="utf-8")
    (root / "sub" / "deep").mkdir()
    (root / "sub" / "deep" / "c.py").write_text("needle = 3\n", encoding="utf-8")
    (root / ".env").write_text("needle=secret", encoding="utf-8")
    (root / ".env.example").write_text("ASK_API_KEY=\n", encoding="utf-8")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("needle", encoding="utf-8")

    listing = server._code_run_tool("list_files", {})
    assert listing["ok"] and listing["output"].splitlines() == [".env.example", "a.txt", "sub/b.py"]

    read = server._code_run_tool("read_file", {"path": "a.txt", "offset": 3, "limit": 2})
    assert read == {"ok": True, "output": "# a.txt: строки 3-4 из 10\nline 3\nline 4"}
    assert server._code_run_tool("read_file", {"path": ".env.example"})["ok"] is True
    assert server._code_run_tool("read_file", {"path": ".git/config"})["ok"] is False

    found = server._code_run_tool("search", {"pattern": "needle"})
    assert found["output"].splitlines() == ["sub/b.py:1: needle = 1", "sub/deep/c.py:1: needle = 3"]
    rx = server._code_run_tool("search", {"pattern": r"other\s*=", "regex": True, "path": "sub"})
    assert rx["output"] == "sub/b.py:2: other = 2"
    assert server._code_run_tool("search", {"pattern": "zzz"})["output"] == "(не найдено)"

    n = server.CODE_MAX_OUTPUT
    assert server._code_clip("a" * n) == "a" * n
    assert server._code_clip("a" * (n + 5)) == "a" * n + "\n…обрезано"
