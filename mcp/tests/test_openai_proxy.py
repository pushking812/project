"""Офлайн-проверка шага 12: OpenAI-совместимый прокси. Ask подменён MockTransport, ключ и сеть не нужны."""
import asyncio
import json

import httpx
import pytest
from starlette.testclient import TestClient

import openai_proxy

_ORIG_CLIENT = httpx.AsyncClient  # до подмены

KEY = "sk-ask-test-key-0001"
TOKEN = "proxy-secret-token-0002"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

TOOLS = [{"type": "function", "function": {
    "name": "read_file", "description": "Прочитать файл",
    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}]


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("ASK_API_KEY", KEY)
    monkeypatch.setenv("PROXY_TOKEN", TOKEN)
    monkeypatch.delenv("PROXY_MODEL", raising=False)


def sse(*events) -> bytes:
    out = b""
    for n, (event, data) in enumerate(events, 1):
        out += f"id: {n}\nevent: {event}\ndata: {json.dumps(data)}\n\n".encode()
    return out


def reply(*texts, usage=True) -> bytes:
    events = [("status", {"state": "starting", "runId": "run1"})]
    events += [("delta", {"text": t}) for t in texts]
    if usage:
        events.append(("usage", {"input": 630, "output": 41, "costUsd": 0.0023}))
        events.append(("limits", {"plan": "max", "kind": "windows", "used": 4.2, "limit": 80}))
    events.append(("done", {"messageId": "m1"}))
    return sse(*events)


def install(monkeypatch, responder=None, raw: bytes | None = None):
    """Подменяет httpx.AsyncClient; возвращает список увидевших запросов к Ask."""
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request):
        seen.append(req)
        if responder is not None:
            return responder(req)
        if req.url.path == "/v1/ask":
            return httpx.Response(200, content=raw, headers={"x-run-id": "run1"})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **k: _ORIG_CLIENT(transport=transport, **k))
    return seen


def asks(seen):
    return [json.loads(r.content) for r in seen if r.url.path == "/v1/ask"]


def chat(body: dict, headers: dict | None = None):
    with TestClient(openai_proxy.app) as c:
        return c.post("/v1/chat/completions", json=body, headers={**AUTH, **(headers or {})})


def log_lines(capsys) -> list[dict]:
    err = capsys.readouterr().err
    return [json.loads(line) for line in err.splitlines() if line.strip()]


def msg(text="привет"):
    return [{"role": "user", "content": text}]


def test_models_list():
    with TestClient(openai_proxy.app) as c:
        r = c.get("/v1/models", headers=AUTH)
    assert r.status_code == 200
    data = r.json()["data"]
    assert [m["id"] for m in data] == [
        "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "ask"]
    assert all(m["object"] == "model" for m in data)
    assert data[-1]["owned_by"] == "ask"


def test_healthz():
    with TestClient(openai_proxy.app) as c:
        r = c.get("/healthz")
    body = r.json()
    assert body["status"] == "ok"
    assert body["ask_key_set"] is True and body["proxy_token_set"] is True
    assert KEY not in r.text and TOKEN not in r.text


def test_401_without_token():
    with TestClient(openai_proxy.app) as c:
        r = c.post("/v1/chat/completions", json={"messages": msg()})
        r2 = c.post("/v1/chat/completions", json={"messages": msg()},
                    headers={"Authorization": f"Bearer {KEY}"})
    for resp in (r, r2):
        assert resp.status_code == 401
        err = resp.json()["error"]
        assert err["type"] == "invalid_request_error" and err["code"] == "invalid_api_key"


def test_chat_plain(monkeypatch):
    seen = install(monkeypatch, raw=reply("Hel", "lo"))
    r = chat({"model": "claude-sonnet-5-5", "messages": msg()})
    assert r.status_code == 200
    body = r.json()
    choice = body["choices"][0]
    assert choice["message"]["content"] == "Hello"
    assert choice["finish_reason"] == "stop"
    assert body["usage"] == {"prompt_tokens": 630, "completion_tokens": 41, "total_tokens": 671}
    assert body["x_ask"]["limits"]["used"] == 4.2
    assert asks(seen)[0]["prompt"] == "привет"


def test_chat_stream_passthrough(monkeypatch):
    install(monkeypatch, raw=reply("Hel", "lo"))
    r = chat({"stream": True, "messages": msg()})
    assert r.status_code == 200
    lines = [ln for ln in r.text.splitlines() if ln.startswith("data: ")]
    assert lines[-1] == "data: [DONE]"
    chunks = [json.loads(ln[6:]) for ln in lines[:-1]]
    deltas = [c["choices"][0]["delta"]["content"] for c in chunks if "content" in c["choices"][0]["delta"]]
    assert deltas == ["Hel", "lo"]
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    assert chunks[-1]["usage"]["total_tokens"] == 671


def test_tool_call(monkeypatch):
    seen = install(monkeypatch, raw=reply('{"tool": "read_file", ', '"args": {"path": "a.py"}}'))
    r = chat({"messages": msg("прочитай a.py"), "tools": TOOLS})
    choice = r.json()["choices"][0]
    call = choice["message"]["tool_calls"][0]
    assert call["function"]["name"] == "read_file"
    assert isinstance(call["function"]["arguments"], str)
    assert json.loads(call["function"]["arguments"]) == {"path": "a.py"}
    assert choice["finish_reason"] == "tool_calls"
    assert "read_file" in asks(seen)[0]["prompt"]
    assert openai_proxy.TOOLS_PROTOCOL in asks(seen)[0]["system"]


def test_tool_result_transcript(monkeypatch):
    seen = install(monkeypatch, raw=reply("Готово."))
    messages = [
        {"role": "user", "content": "прочитай a.py"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "read_file", "arguments": '{"path": "a.py"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "print(1)"},
    ]
    r = chat({"messages": messages, "tools": TOOLS})
    assert r.status_code == 200
    prompt = asks(seen)[0]["prompt"]
    assert "tool read_file:" in prompt
    assert '{"path": "a.py"}' in prompt
    assert "print(1)" in prompt


def test_prose_reply_is_final(monkeypatch, capsys):
    install(monkeypatch, raw=reply("Ничего вызывать не нужно."))
    r = chat({"messages": msg(), "tools": TOOLS})
    choice = r.json()["choices"][0]
    assert choice["message"]["content"] == "Ничего вызывать не нужно."
    assert choice["finish_reason"] == "stop"
    assert log_lines(capsys)[-1]["fallback"] is True


def test_unknown_tool_becomes_final(monkeypatch):
    install(monkeypatch, raw=reply('{"tool": "nope", "args": {}}'))
    r = chat({"messages": msg(), "tools": TOOLS})
    assert r.status_code == 200
    choice = r.json()["choices"][0]
    assert "nope" in choice["message"]["content"] and "read_file" in choice["message"]["content"]
    assert choice["finish_reason"] == "stop"
    assert "tool_calls" not in choice["message"]


def test_fenced_json_is_parsed(monkeypatch):
    install(monkeypatch, raw=reply('```json\n{"tool": "read_file", "args": {"path": "b.py"}}\n```'))
    r = chat({"messages": msg(), "tools": TOOLS})
    choice = r.json()["choices"][0]
    assert choice["message"]["tool_calls"][0]["function"]["name"] == "read_file"
    assert choice["finish_reason"] == "tool_calls"


def test_idempotency_header_forwarded(monkeypatch):
    seen = install(monkeypatch, raw=reply("ok"))
    chat({"messages": msg()}, headers={"Idempotency-Key": "abc-123"})
    ask_req = [r for r in seen if r.url.path == "/v1/ask"][0]
    assert ask_req.headers["idempotency-key"] == "abc-123"


def test_bad_body_400(monkeypatch):
    install(monkeypatch, raw=reply("ok"))
    for body in ({"model": "ask"}, {"messages": "привет"}):
        r = chat(body)
        assert r.status_code == 400
        assert r.json()["error"]["type"] == "invalid_request_error"
        assert "Traceback" not in r.text


def test_ask_error_maps_to_502(monkeypatch):
    raw = sse(("status", {"runId": "run1"}), ("delta", {"text": "Hel"}),
              ("error", {"code": "internal", "message": "boom", "retryable": False}))
    install(monkeypatch, raw=raw)
    r = chat({"messages": msg()})
    assert r.status_code == 502
    message = r.json()["error"]["message"]
    assert "boom" in message and "Частичный ответ" in message and "Hel" in message


def test_quota_maps_to_429_with_retry_after(monkeypatch):
    def responder(req):
        return httpx.Response(429, headers={"Retry-After": "3600"},
                              json={"error": {"code": "quota_exceeded", "message": "лимит исчерпан"}})
    seen = install(monkeypatch, responder=responder)
    r = chat({"messages": msg()})
    assert r.status_code == 429
    assert r.headers["retry-after"] == "3600"
    assert "лимит исчерпан" in r.json()["error"]["message"]
    assert len(asks(seen)) == 1


def test_models_lists_documented_names(monkeypatch):
    seen = install(monkeypatch, raw=reply("ok"))
    for name in ("claude-haiku-5-5", "gpt-4o", "ask", "Claude-Haiku-5-5"):
        assert chat({"model": name, "messages": msg()}).status_code == 200
    assert [a["model"] for a in asks(seen)] == [
        "claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
    monkeypatch.setenv("PROXY_MODEL", "claude-opus-5-5")
    chat({"model": "ask", "messages": msg()})
    assert asks(seen)[-1]["model"] == "claude-opus-5-5"


def test_input_limits_truncate_and_flag(monkeypatch, capsys):
    seen = install(monkeypatch, raw=reply("ok"))
    messages = [{"role": "system", "content": "S" * 30_000}]
    messages += [{"role": "user", "content": f"msg-{i} " + "x" * 200} for i in range(450)]
    assert chat({"messages": messages}).status_code == 200
    body = asks(seen)[0]
    assert len(body["system"]) == openai_proxy.LIMIT_SYSTEM
    assert body["system"].endswith(openai_proxy.CUT)
    assert len(body["prompt"]) <= openai_proxy.LIMIT_PROMPT
    assert body["prompt"].count("user: msg-") <= openai_proxy.LIMIT_HISTORY
    assert openai_proxy.OMIT in body["prompt"]
    assert "msg-0 " not in body["prompt"] and "msg-449 " in body["prompt"]
    log = log_lines(capsys)[-1]
    assert log["truncated"] is True
    # хвост system не потерян, а переехал в начало prompt
    assert log["system_cut"] is True and log["prompt_cut"] is True
    assert log["spill_chars"] == 30_000 - (len(body["system"]) - len(openai_proxy.CUT))
    assert log["spill_chars"] == 10_011
    assert log["system_chars"] == len(body["system"])
    assert body["prompt"].startswith("S")
    assert "S" * 10_011 in body["prompt"]

    big = [{"role": "user", "content": "q"},
           {"role": "assistant", "content": None, "tool_calls": [
               {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
           {"role": "tool", "tool_call_id": "c1", "content": "y" * 9_000}]
    chat({"messages": big, "tools": TOOLS})
    prompt = asks(seen)[1]["prompt"]
    assert openai_proxy.CUT in prompt and "y" * 8_000 not in prompt
    assert log_lines(capsys)[-1]["truncated"] is True


class _Hang(httpx.AsyncByteStream):
    """Ответ Ask: первые события приходят, дальше поток молчит, пока клиент не уйдёт."""

    async def __aiter__(self):
        yield reply("Hel", usage=False).split(b"id: 3")[0]
        await asyncio.Event().wait()


def test_stop_on_client_disconnect(monkeypatch, capsys):
    def responder(req):
        if req.url.path == "/v1/ask":
            return httpx.Response(200, headers={"x-run-id": "run1"}, stream=_Hang())
        return httpx.Response(404)  # run уже закончился: для прокси это не ошибка

    seen = install(monkeypatch, responder=responder)
    payload = json.dumps({"stream": True, "messages": msg()}).encode()
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": "POST", "scheme": "http", "path": "/v1/chat/completions",
        "raw_path": b"/v1/chat/completions", "query_string": b"", "root_path": "",
        "headers": [(b"authorization", f"Bearer {TOKEN}".encode()), (b"content-type", b"application/json")],
        "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8789),
    }

    async def drive():
        got_chunk = asyncio.Event()
        sent_body = False

        async def receive():
            nonlocal sent_body
            if not sent_body:
                sent_body = True
                return {"type": "http.request", "body": payload, "more_body": False}
            await got_chunk.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body" and b"Hel" in message.get("body", b""):
                got_chunk.set()

        await asyncio.wait_for(openai_proxy.app(scope, receive, send), 10)

    asyncio.run(drive())
    stops = [r for r in seen if r.method == "POST" and r.url.path == "/v1/runs/run1/stop"]
    assert len(stops) == 1
    assert log_lines(capsys)[-1]["status"] == "client_gone"


def test_log_line_json(monkeypatch, capsys):
    install(monkeypatch, raw=reply("Hel", "lo"))
    chat({"messages": msg("секретный текст промпта")}, headers={"Idempotency-Key": "client-key-xyz"})
    err = capsys.readouterr().err
    lines = [ln for ln in err.splitlines() if ln.strip()]
    assert len(lines) == 1
    entry = json.loads(lines[0])
    for field in ("ts", "run_id", "usage", "status", "ms", "idempotency_key_hash"):
        assert field in entry
    assert entry["run_id"] == "run1" and entry["status"] == "ok"
    assert entry["usage"] == {"input": 630, "output": 41, "costUsd": 0.0023}
    assert len(entry["idempotency_key_hash"]) == 8
    for secret in (KEY, TOKEN, "client-key-xyz", "секретный текст промпта"):
        assert secret not in err


def _catalog_tools(native=16, mcp=184, big=0):
    tools = []
    for i in range(native):
        tools.append({"type": "function", "function": {
            "name": f"native_{i}", "description": "Родной инструмент " + "d" * 100,
            "parameters": {"type": "object", "properties": {"p": {"type": "string", "description": "x" * 100}}}}})
    for i in range(mcp):
        tools.append({"type": "function", "function": {
            "name": f"srv__tool_{i}", "description": "MCP инструмент " + "d" * 100,
            "parameters": {"type": "object", "properties": {"p": {"type": "string", "description": "y" * 100}}}}})
    return tools


def test_big_catalog_goes_to_prompt_and_system_survives(monkeypatch, capsys):
    seen = install(monkeypatch, raw=reply("ok"))
    messages = [{"role": "system", "content": "S" * 19_000}, {"role": "user", "content": "привет"}]
    assert chat({"messages": messages, "tools": _catalog_tools()}).status_code == 200
    body = asks(seen)[0]
    assert len(body["system"]) >= 19_000
    assert not body["system"].endswith(openai_proxy.CUT)
    assert openai_proxy.TOOLS_PROTOCOL in body["system"]
    assert "Доступные инструменты:" in body["prompt"]
    assert "Доступные инструменты:" not in body["system"]
    for i in range(16):
        assert f"- native_{i} Параметры:" in body["prompt"]
    assert len(body["prompt"]) <= openai_proxy.LIMIT_PROMPT
    entry = log_lines(capsys)[-1]
    assert entry["tools"] == 200
    assert entry["tools_dropped"] > 0
    assert entry["tools_sent"] + entry["tools_dropped"] == 200
    assert 0 < len(entry["tools_dropped_names"]) <= 5
    assert all(n.startswith("srv__") for n in entry["tools_dropped_names"])
    assert entry["truncated"] is True


def test_no_tools_no_catalog(monkeypatch, capsys):
    seen = install(monkeypatch, raw=reply("ok"))
    messages = [{"role": "system", "content": "Ты помощник."}, {"role": "user", "content": "привет"}]
    chat({"messages": messages})
    body = asks(seen)[0]
    assert body["system"] == "Ты помощник."
    assert body["prompt"] == "привет"
    assert "Доступные инструменты" not in body["prompt"]
    entry = log_lines(capsys)[-1]
    assert entry["tools_sent"] == 0 and entry["tools_dropped"] == 0
    assert entry["tools_dropped_names"] == [] and entry["truncated"] is False


def test_giant_tool_does_not_crowd_out_native(monkeypatch, capsys):
    seen = install(monkeypatch, raw=reply("ok"))
    tools = _catalog_tools(native=15, mcp=0)
    giant_params = {"type": "object", "properties": {"blob": {"type": "string", "description": "G" * 5_000}}}
    tools.insert(0, {"type": "function", "function": {
        "name": "giant", "description": "гигант", "parameters": giant_params}})
    assert chat({"messages": msg(), "tools": tools}).status_code == 200
    prompt = asks(seen)[0]["prompt"]
    for i in range(15):
        assert f"- native_{i} Параметры:" in prompt
    assert "- giant" not in prompt
    assert "G" * 100 not in prompt
    entry = log_lines(capsys)[-1]
    assert entry["tools_dropped"] == 1 and entry["tools_sent"] == 15
    assert entry["tools_dropped_names"] == ["giant"]
    assert entry["truncated"] is True


def test_tool_that_does_not_fit_is_skipped_whole(monkeypatch):
    seen = install(monkeypatch, raw=reply("ok"))
    monkeypatch.setattr(openai_proxy, "LIMIT_TOOLS_BLOCK", 1_500)
    tools = _catalog_tools(native=3, mcp=5)
    assert chat({"messages": msg(), "tools": tools}).status_code == 200
    prompt = asks(seen)[0]["prompt"]
    lines = [ln for ln in prompt.splitlines() if ln.startswith("- ")]
    assert 0 < len(lines) < 8
    # ни одна строка не оборвана посередине: JSON параметров цел, CUT нет
    pj = json.dumps(tools[0]["function"]["parameters"], ensure_ascii=False, separators=(",", ":"))
    for ln in lines:
        assert pj in ln or "srv__" in ln
        assert openai_proxy.CUT not in ln
        json.loads(ln.split(" Параметры: ", 1)[1].split(" — ", 1)[0])
    assert [ln.split(" ")[1] for ln in lines][:3] == ["native_0", "native_1", "native_2"]


def _tool(name, desc, params):
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": params}}


def _params_of_len(n):
    """Схема, чей json.dumps(separators=(',', ':')) ровно n знаков."""
    base = {"type": "object", "properties": {"p": {"type": "string", "description": ""}}}
    pad = n - len(json.dumps(base, ensure_ascii=False, separators=(",", ":")))
    base["properties"]["p"]["description"] = "z" * pad
    s = json.dumps(base, ensure_ascii=False, separators=(",", ":"))
    assert len(s) == n
    return base, s


def test_schema_arrives_whole(monkeypatch):
    seen = install(monkeypatch, raw=reply("ok"))
    params, pj = _params_of_len(1_475)
    tools = [_tool("read_files", "D" * 1_400, params)]
    assert chat({"messages": msg(), "tools": tools}).status_code == 200
    prompt = asks(seen)[0]["prompt"]
    assert pj in prompt
    line = [ln for ln in prompt.splitlines() if ln.startswith("- read_files")][0]
    desc = line.split(" — ", 1)[1]
    assert 0 < len(desc) <= 400
    assert openai_proxy.CUT not in prompt


def test_200_tools_native_schemas_intact(monkeypatch, capsys):
    seen = install(monkeypatch, raw=reply("ok"))
    tools = []
    pjs = []
    for i in range(16):
        params = {"type": "object", "properties": {"p": {"type": "string", "description": "n" * 200}}, "required": ["p"]}
        pjs.append(json.dumps(params, ensure_ascii=False, separators=(",", ":")))
        tools.append(_tool(f"native_{i}", "N" * 600, params))
    for i in range(184):
        params = {"type": "object", "properties": {"p": {"type": "string", "description": "m" * 300}}}
        tools.append(_tool(f"srv__tool_{i}", "M" * 600, params))
    assert chat({"messages": msg(), "tools": tools}).status_code == 200
    prompt = asks(seen)[0]["prompt"]
    for pj in pjs:
        assert pj in prompt
    assert openai_proxy.CUT not in prompt
    assert len(prompt) <= openai_proxy.LIMIT_PROMPT
    assert log_lines(capsys)[-1]["tools_dropped"] > 0


def test_params_come_before_description(monkeypatch):
    seen = install(monkeypatch, raw=reply("ok"))
    chat({"messages": msg(), "tools": _catalog_tools(native=2, mcp=1)})
    lines = [ln for ln in asks(seen)[0]["prompt"].splitlines() if ln.startswith("- ")]
    assert lines
    for ln in lines:
        assert ln.find("Параметры:") < ln.find(" — ")


def test_tool_line_limit_decides_not_cuts(monkeypatch, capsys):
    seen = install(monkeypatch, raw=reply("ok"))
    limit = openai_proxy.LIMIT_TOOL_LINE
    fixed = len("- exact Параметры: ")
    p_ok, pj_ok = _params_of_len(limit - fixed)
    fixed2 = len("- toolong Параметры: ")
    p_big, pj_big = _params_of_len(limit + 100 - fixed2)
    tools = [_tool("exact", "описание", p_ok), _tool("toolong", "описание", p_big)]
    assert chat({"messages": msg(), "tools": tools}).status_code == 200
    prompt = asks(seen)[0]["prompt"]
    assert f"- exact Параметры: {pj_ok}" in prompt
    assert "toolong" not in prompt and pj_big not in prompt
    entry = log_lines(capsys)[-1]
    assert entry["tools_dropped_names"] == ["toolong"] and entry["truncated"] is True


def test_rules_survive_system_cut(monkeypatch, capsys):
    seen = install(monkeypatch, raw=reply("ok"))
    marker = "ПРАВИЛА-ХВОСТ"
    system = "H" * 19_800 + marker + "R" * 17_000
    assert chat({"messages": [{"role": "system", "content": system}] + msg(), "tools": TOOLS}).status_code == 200
    body = asks(seen)[0]
    log = log_lines(capsys)[-1]
    assert len(body["system"]) == openai_proxy.LIMIT_SYSTEM
    assert log["system_cut"] is True
    # место под system = лимит - протокол - 2 (разделитель); в spill уходит всё, что за (место - CUT)
    kept = openai_proxy.LIMIT_SYSTEM - len(openai_proxy.TOOLS_PROTOCOL) - 2 - len(openai_proxy.CUT)
    assert log["spill_chars"] == len(system) - kept
    assert marker in body["prompt"] and marker not in body["system"]
    assert not body["system"].endswith(openai_proxy.CUT)  # конец — протокол
    assert body["system"].endswith(openai_proxy.TOOLS_PROTOCOL)
    assert len(body["prompt"]) <= openai_proxy.LIMIT_PROMPT


def test_fits_without_spill(monkeypatch, capsys):
    seen = install(monkeypatch, raw=reply("ok"))
    room = openai_proxy.LIMIT_SYSTEM - len(openai_proxy.TOOLS_PROTOCOL) - 2  # ровно впритык
    system = "H" * (room - 247) + "P" * 247
    assert chat({"messages": [{"role": "system", "content": system}] + msg(), "tools": TOOLS}).status_code == 200
    body = asks(seen)[0]
    log = log_lines(capsys)[-1]
    assert log["system_cut"] is False and log["spill_chars"] == 0
    assert "H" * 100 not in body["prompt"]
    assert body["system"].startswith("H" * (room - 247))
    assert body["system"].endswith(openai_proxy.TOOLS_PROTOCOL)


def test_prompt_budget_counts_spill(monkeypatch, capsys):
    seen = install(monkeypatch, raw=reply("ok"))
    messages = [{"role": "system", "content": "S" * 36_000}]
    messages += [{"role": "user", "content": f"msg-{i} " + "x" * 300} for i in range(400)]
    assert chat({"messages": messages, "tools": _catalog_tools()}).status_code == 200
    body = asks(seen)[0]
    log = log_lines(capsys)[-1]
    assert log["spill_chars"] > 0 and log["prompt_cut"] is True
    assert len(body["prompt"]) <= openai_proxy.LIMIT_PROMPT
    assert "msg-399 " in body["prompt"]


def test_spill_shrinks_for_big_tools_catalog(monkeypatch, capsys):
    # каталог до 60 000 знаков + спилл system не должны выталкивать историю и выходить за предел
    seen = install(monkeypatch, raw=reply("ok"))
    messages = [{"role": "system", "content": "S" * 200_000}]
    messages += [{"role": "user", "content": f"msg-{i} " + "x" * 300} for i in range(400)]
    assert chat({"messages": messages, "tools": _catalog_tools()}).status_code == 200
    body = asks(seen)[0]
    log = log_lines(capsys)[-1]
    assert len(body["prompt"]) <= openai_proxy.LIMIT_PROMPT
    assert log["spill_chars"] < openai_proxy.LIMIT_PROMPT // 2
    assert "msg-399 " in body["prompt"]


def test_spill_is_capped(monkeypatch, capsys):
    monkeypatch.setattr(openai_proxy, "LIMIT_TOOLS_BLOCK", 25_000)  # прежний размер каталога
    seen = install(monkeypatch, raw=reply("ok"))
    system = "S" * 200_000
    messages = [{"role": "system", "content": system}]
    messages += [{"role": "user", "content": f"msg-{i} " + "x" * 300} for i in range(400)]
    assert chat({"messages": messages, "tools": _catalog_tools()}).status_code == 200
    body = asks(seen)[0]
    log = log_lines(capsys)[-1]
    # кэп сработал: перенесена ровно половина предела, остальное потеряно
    assert log["spill_chars"] == openai_proxy.LIMIT_PROMPT // 2
    assert "S" * (openai_proxy.LIMIT_PROMPT // 2) in body["prompt"]
    assert log["spill_chars"] + len(body["system"]) < len(system)
    # при этом контракт цел, а история не выброшена целиком
    assert len(body["prompt"]) <= openai_proxy.LIMIT_PROMPT
    assert log["system_cut"] is True and log["prompt_cut"] is True
    assert openai_proxy.OMIT in body["prompt"] and "msg-399 " in body["prompt"]


def test_reminder_sits_right_before_the_answer_cue(monkeypatch):
    seen = install(monkeypatch, raw=reply("ok"))
    messages = [
        {"role": "user", "content": "тест"},
        {"role": "assistant", "content": "Тест получен."},
        {"role": "user", "content": "запусти терминал"},
    ]
    chat({"messages": messages, "tools": TOOLS})
    prompt = asks(seen)[0]["prompt"]
    assert prompt.endswith(openai_proxy.TOOLS_REMINDER + "\n\nassistant:")
    assert prompt.count(openai_proxy.TOOLS_REMINDER) == 1


def test_no_reminder_without_tools(monkeypatch):
    seen = install(monkeypatch, raw=reply("ok"))
    messages = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
    ]
    chat({"messages": messages})
    prompt = asks(seen)[0]["prompt"]
    assert openai_proxy.TOOLS_REMINDER not in prompt
    assert prompt.endswith("\n\nassistant:")


def test_reminder_fits_prompt_budget(monkeypatch):
    seen = install(monkeypatch, raw=reply("ok"))
    big = "x" * 60_000
    messages = [{"role": "user", "content": big}, {"role": "assistant", "content": big},
                {"role": "user", "content": "дальше"}]
    chat({"messages": messages, "tools": TOOLS})
    prompt = asks(seen)[0]["prompt"]
    assert len(prompt) <= openai_proxy.LIMIT_PROMPT
    assert prompt.endswith(openai_proxy.TOOLS_REMINDER + "\n\nassistant:")
