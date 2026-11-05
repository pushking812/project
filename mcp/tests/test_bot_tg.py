"""Офлайн-проверка клиента Bot API на httpx.MockTransport: сеть не нужна."""

import asyncio
import json

import httpx
import pytest

from ask_mcp.bot.tg import TgApi, TgError

TOKEN = "123456789:AAtest-token"


def api(handler):
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return TgApi(TOKEN, "https://api.telegram.org", transport=httpx.MockTransport(wrapped)), seen


def ok(payload):
    return lambda req: httpx.Response(200, json={"ok": True, "result": payload})


def run(coro):
    return asyncio.run(coro)


def test_send_message_payload_and_path():
    client, seen = api(ok({"message_id": 7}))
    try:
        res = run(client.send_message(1, "привет", reply_markup={"inline_keyboard": []}, reply_to=5))
    finally:
        run(client.close())
    assert res["message_id"] == 7
    request = seen[0]
    assert request.url.path == f"/bot{TOKEN}/sendMessage"
    body = json.loads(request.content)
    assert body["chat_id"] == 1 and body["text"] == "привет"
    assert body["reply_markup"] == {"inline_keyboard": []}
    assert body["reply_parameters"]["message_id"] == 5
    assert "parse_mode" not in body  # текст инструментов не экранируется


def test_get_updates_offset_and_timeout():
    client, seen = api(ok([]))
    try:
        run(client.get_updates(offset=42, timeout=3))
    finally:
        run(client.close())
    assert json.loads(seen[0].content) == {
        "timeout": 3,
        "allowed_updates": ["message", "callback_query"],
        "offset": 42,
    }


def test_error_429_retry_after():
    client, _ = api(
        lambda req: httpx.Response(
            429,
            json={
                "ok": False,
                "error_code": 429,
                "description": "Too Many Requests: retry after 7",
                "parameters": {"retry_after": 7},
            },
        )
    )
    try:
        with pytest.raises(TgError) as e:
            run(client.send_message(1, "x"))
    finally:
        run(client.close())
    assert e.value.status == 429 and e.value.retry_after == 7 and e.value.retryable


def test_error_401_not_retryable_and_token_hidden():
    client, _ = api(
        lambda req: httpx.Response(401, json={"ok": False, "error_code": 401, "description": "Unauthorized"})
    )
    try:
        with pytest.raises(TgError) as e:
            run(client.get_me())
    finally:
        run(client.close())
    assert e.value.status == 401 and not e.value.retryable
    assert TOKEN not in str(e.value)


def test_send_photo_is_multipart():
    client, seen = api(ok({"message_id": 1}))
    try:
        run(client.send_photo(5, b"\x89PNG", "screen.png", caption="снимок"))
    finally:
        run(client.close())
    request = seen[0]
    assert request.headers["content-type"].startswith("multipart/form-data")
    assert b'name="photo"' in request.content and b"screen.png" in request.content


def test_set_my_commands():
    client, seen = api(ok(True))
    try:
        run(client.set_my_commands([("help", "справка"), ("exec", "задача")]))
    finally:
        run(client.close())
    assert json.loads(seen[0].content) == {
        "commands": [
            {"command": "help", "description": "справка"},
            {"command": "exec", "description": "задача"},
        ]
    }


def test_proxy_is_passed_and_environment_ignored(monkeypatch):
    import ask_mcp.bot.tg as tg_module

    captured = {}

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(tg_module.httpx, "AsyncClient", FakeClient)
    tg_module.TgApi("1:x", proxy="http://user:secret@127.0.0.1:8080")
    assert captured["proxy"] == "http://user:secret@127.0.0.1:8080"
    assert captured["trust_env"] is False  # явный прокси сильнее HTTPS_PROXY/NO_PROXY


def test_without_proxy_environment_is_used(monkeypatch):
    import ask_mcp.bot.tg as tg_module

    captured = {}

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(tg_module.httpx, "AsyncClient", FakeClient)
    tg_module.TgApi("1:x")
    assert "proxy" not in captured and "trust_env" not in captured


def test_redact_hides_proxy_credentials():
    from ask_mcp.bot.tg import _redact

    proxy = "http://user:secret@127.0.0.1:8080"
    out = _redact(f"ProxyError: cannot connect to {proxy}", proxy)
    assert "secret" not in out and "***@" in out and "127.0.0.1:8080" in out
    # логин и пароль в незнакомой записи тоже скрываются
    assert "secret" not in _redact("http://user:secret@proxy:8080", None)


def test_network_error_becomes_tg_error_without_token():
    def boom(request):
        raise httpx.ConnectError("нет сети", request=request)

    client, _ = api(boom)
    try:
        with pytest.raises(TgError) as e:
            run(client.send_message(1, "x"))
    finally:
        run(client.close())
    assert "Telegram недоступен" in str(e.value)
    assert TOKEN not in str(e.value)
