"""code_tap: пересылает запросы на сайт как есть, пишет обмен в файл и не пишет ключи. Сеть подменена."""
import json

import httpx
import pytest
from starlette.testclient import TestClient

import code_tap

_ORIG_CLIENT = httpx.AsyncClient
KEY = "sk-ask-secret-key-123456"


@pytest.fixture
def tap(monkeypatch, tmp_path):
    log = tmp_path / "tap.jsonl"
    monkeypatch.setattr(code_tap, "LOG_PATH", str(log))
    monkeypatch.setattr(code_tap, "OUT_DIR", str(tmp_path))
    monkeypatch.setattr(code_tap, "_counter", 0)
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request):
        seen.append(req)
        if req.url.path == "/v1/me":
            return httpx.Response(200, json={"name": "me", "code": True, "key": KEY})
        if req.url.path == "/v1/code":
            sse = ('event: status\ndata: {"runId":"r1","state":"thinking"}\n\n'
                   'event: tool\ndata: {"runId":"r1","callId":"1","name":"read_file","input":{"path":"a.js"}}\n\n'
                   'event: done\ndata: {"messageId":"m1"}\n\n')
            return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: _ORIG_CLIENT(transport=transport, **k))
    return log, seen


def records(log):
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]


def test_forwards_json_and_hides_key(tap):
    log, seen = tap
    with TestClient(code_tap.app) as c:
        r = c.get("/v1/me", headers={"Authorization": f"Bearer {KEY}", "User-Agent": "ask-code/1"})
    assert r.status_code == 200 and r.json()["name"] == "me"
    assert seen[0].headers["authorization"] == f"Bearer {KEY}"  # сайту ключ уходит как есть
    text = log.read_text(encoding="utf-8")
    assert KEY not in text and "secret-key" not in text
    recs = records(log)
    assert recs[0]["dir"] == "req" and recs[0]["headers"]["authorization"] == "[скрыто]"
    assert recs[0]["headers"]["user-agent"] == "ask-code/1"
    assert recs[1]["dir"] == "res" and recs[1]["status"] == 200


def test_streams_events_and_logs_them(tap):
    log, seen = tap
    body = {"prompt": "fix", "history": [], "commands": True, "notes": "x" * 5000}
    with TestClient(code_tap.app) as c:
        r = c.post("/v1/code", json=body, headers={"Authorization": f"Bearer {KEY}"})
    assert "event: tool" in r.text and "read_file" in r.text
    assert json.loads(seen[0].content) == body  # тело переслано без изменений
    recs = records(log)
    req = recs[0]
    assert req["body"]["prompt"] == "fix" and "ещё 3000 знаков" in req["body"]["notes"]  # в логе строка урезана
    events = [(x["event"], x["data"]) for x in recs if x["dir"] == "event"]
    assert [e for e, _ in events] == ["status", "tool", "done"]
    assert events[1][1]["input"] == {"path": "a.js"}
    assert recs[-1]["dir"] == "end"


def test_unreachable_site_is_502(monkeypatch, tap):
    def boom(req):
        raise httpx.ConnectError("нет сети")

    transport = httpx.MockTransport(boom)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: _ORIG_CLIENT(transport=transport, **k))
    with TestClient(code_tap.app) as c:
        r = c.get("/v1/me")
    assert r.status_code == 502
