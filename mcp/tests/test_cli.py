"""Офлайн-проверка разбора флагов запуска (_cli) и _bind_settings. Сеть и запуск сервера не нужны."""
import pytest

import server


def _clean(monkeypatch):
    for name in ("ASK_HOST", "ASK_PORT", "ASK_ALLOW_REMOTE"):
        monkeypatch.delenv(name, raising=False)


def test_help_exits_zero_and_prints_usage(capsys):
    with pytest.raises(SystemExit) as e:
        server._cli(["--help"])
    assert e.value.code == 0
    assert "usage" in capsys.readouterr().out.lower()


def test_unknown_flag_exits_2(capsys):
    with pytest.raises(SystemExit) as e:
        server._cli(["--nonsense"])
    assert e.value.code == 2
    assert capsys.readouterr().err.strip()


def test_port_without_http_exits_2(capsys):
    with pytest.raises(SystemExit) as e:
        server._cli(["--port", "8100"])
    assert e.value.code == 2
    assert "--http" in capsys.readouterr().err


def test_http_with_port():
    args = server._cli(["--http", "--port", "8100"])
    assert args.http is True
    assert args.port == 8100


def test_http_with_bad_port_exits_2(capsys):
    with pytest.raises(SystemExit) as e:
        server._cli(["--http", "--port", "abc"])
    assert e.value.code == 2
    assert capsys.readouterr().err.strip()


def test_port_argument_ignores_bad_env_port(monkeypatch):
    _clean(monkeypatch)
    monkeypatch.setenv("ASK_PORT", "abc")
    assert server._bind_settings(port=8100) == ("127.0.0.1", 8100)


def test_host_argument_external_refused_without_allow(monkeypatch, capsys):
    _clean(monkeypatch)
    with pytest.raises(SystemExit) as e:
        server._bind_settings(host="0.0.0.0")
    assert e.value.code == 2
    assert "ASK_ALLOW_REMOTE" in capsys.readouterr().err


def test_host_argument_external_allowed_with_flag(monkeypatch):
    _clean(monkeypatch)
    monkeypatch.setenv("ASK_ALLOW_REMOTE", "1")
    assert server._bind_settings(host="0.0.0.0") == ("0.0.0.0", 8000)
