"""Офлайн-проверка 1.5: адрес и порт из ASK_HOST/ASK_PORT. Сеть и запуск сервера не нужны."""
import pytest

import server


def _clean(monkeypatch):
    for name in ("ASK_HOST", "ASK_PORT", "ASK_ALLOW_REMOTE"):
        monkeypatch.delenv(name, raising=False)


def test_default_bind_is_loopback(monkeypatch):
    _clean(monkeypatch)
    assert server._bind_settings() == ("127.0.0.1", 8000)


def test_external_bind_is_refused(monkeypatch, capsys):
    _clean(monkeypatch)
    monkeypatch.setenv("ASK_HOST", "0.0.0.0")
    with pytest.raises(SystemExit) as e:
        server._bind_settings()
    assert e.value.code != 0
    assert "ASK_ALLOW_REMOTE" in capsys.readouterr().err


def test_external_bind_allowed_explicitly(monkeypatch):
    _clean(monkeypatch)
    monkeypatch.setenv("ASK_HOST", "0.0.0.0")
    monkeypatch.setenv("ASK_ALLOW_REMOTE", "1")
    assert server._bind_settings() == ("0.0.0.0", 8000)


def test_bad_port_message(monkeypatch, capsys):
    _clean(monkeypatch)
    monkeypatch.setenv("ASK_PORT", "abc")
    with pytest.raises(SystemExit) as e:
        server._bind_settings()
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert "ASK_PORT" in err
    assert len(err.strip().splitlines()) == 1
    assert "Traceback" not in err


def test_custom_port(monkeypatch):
    _clean(monkeypatch)
    monkeypatch.setenv("ASK_PORT", "8100")
    assert server._bind_settings() == ("127.0.0.1", 8100)


def test_settings_reach_fastmcp(monkeypatch):
    """Порт из ASK_PORT доходит до FastMCP, а не только до _bind_settings()."""
    import importlib
    import sys

    import server

    # reload создаёт новые классы AskError/_StreamError, а openai_proxy держит старые:
    # без возврата исходных объектов его except перестаёт ловить ошибки (тесты прокси краснеют).
    saved = dict(vars(server))
    try:
        monkeypatch.setattr(sys, "argv", ["server.py", "--http"])
        monkeypatch.setenv("ASK_PORT", "8101")
        importlib.reload(server)
        assert (server.mcp.settings.host, server.mcp.settings.port) == ("127.0.0.1", 8101)
    finally:
        monkeypatch.undo()
        importlib.reload(server)
        vars(server).update(saved)


@pytest.mark.parametrize("raw", ["70000", "0", "-1", "65536"])
def test_port_out_of_range(monkeypatch, capsys, raw):
    _clean(monkeypatch)
    monkeypatch.setenv("ASK_PORT", raw)
    with pytest.raises(SystemExit) as e:
        server._bind_settings()
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert raw in err
    assert len(err.strip().splitlines()) == 1
    assert "Traceback" not in err


@pytest.mark.parametrize("raw", ["70000", "0", "-1", "65536"])
def test_port_out_of_range_cli(monkeypatch, capsys, raw):
    _clean(monkeypatch)
    with pytest.raises(SystemExit) as e:
        server._bind_settings(None, int(raw))
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert raw in err
    assert len(err.strip().splitlines()) == 1
    assert "Traceback" not in err


@pytest.mark.parametrize("raw", ["1", "65535"])
def test_port_range_edges_accepted(monkeypatch, raw):
    _clean(monkeypatch)
    monkeypatch.setenv("ASK_PORT", raw)
    assert server._bind_settings() == ("127.0.0.1", int(raw))
