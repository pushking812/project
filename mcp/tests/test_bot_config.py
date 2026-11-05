"""Офлайн-проверка настроек бота: fail-closed и разбор переменных."""

import pytest

from ask_mcp.bot.config import ConfigError, load_config, parse_ids, redact_proxy


def env(**kw):
    base = {"TELEGRAM_BOT_TOKEN": "123456789:AAtest", "TELEGRAM_ALLOWED_USER_IDS": "1, 2"}
    base.update({name: str(value) for name, value in kw.items()})
    return base


def test_defaults_are_safe():
    cfg = load_config(env())
    assert cfg.allowed_users == frozenset({1, 2})
    assert cfg.allowed_chats == cfg.allowed_users
    assert cfg.default_mode == "plan"  # ничего не меняем, пока не попросят
    assert cfg.dangerous is False
    assert cfg.max_message == 3900
    assert cfg.mcp_url == "http://127.0.0.1:8000/mcp"
    assert cfg.api_url == "https://api.telegram.org"
    assert cfg.poll_interval == 2.0 and cfg.poll_timeout == 25


def test_token_required_with_hint():
    with pytest.raises(ConfigError) as e:
        load_config({"TELEGRAM_ALLOWED_USER_IDS": "1"})
    assert "TELEGRAM_BOT_TOKEN" in str(e.value) and "mcp" in str(e.value)


def test_token_shape():
    with pytest.raises(ConfigError):
        load_config(env(TELEGRAM_BOT_TOKEN="без двоеточия"))
    with pytest.raises(ConfigError):
        load_config(env(TELEGRAM_BOT_TOKEN="123:AA BB"))


def test_users_required_unless_explicitly_any():
    with pytest.raises(ConfigError) as e:
        load_config({"TELEGRAM_BOT_TOKEN": "123:AA"})
    assert "TELEGRAM_ALLOWED_USER_IDS" in str(e.value)
    cfg = load_config({"TELEGRAM_BOT_TOKEN": "123:AA", "TELEGRAM_ALLOW_ANY": "1"})
    assert cfg.allowed_users == frozenset()


def test_parse_ids():
    assert parse_ids("1, 2;3", "X") == frozenset({1, 2, 3})
    assert parse_ids("", "X") == frozenset()
    with pytest.raises(ConfigError) as e:
        parse_ids("1,abc", "X")
    assert "TELEGRAM" in str(e.value) or "X" in str(e.value)


def test_chats_default_to_users_and_can_override():
    assert load_config(env()).allowed_chats == frozenset({1, 2})
    cfg = load_config(env(TELEGRAM_ALLOWED_CHAT_IDS="-100500"))
    assert cfg.allowed_chats == frozenset({-100500})


def test_mode_and_limits():
    with pytest.raises(ConfigError):
        load_config(env(TELEGRAM_DEFAULT_MODE="act"))
    with pytest.raises(ConfigError):
        load_config(env(TELEGRAM_TASK_TIMEOUT="abc"))
    with pytest.raises(ConfigError):
        load_config(env(TELEGRAM_POLL_INTERVAL="0"))
    with pytest.raises(ConfigError):
        load_config(env(TELEGRAM_LOG_LEVEL="trace"))
    cfg = load_config(
        env(
            TELEGRAM_TASK_TIMEOUT="60",
            TELEGRAM_POLL_INTERVAL="0.5",
            TELEGRAM_MAX_MESSAGE="1000",
            TELEGRAM_ASK_TIMEOUT="30",
            TELEGRAM_ALLOW_DANGEROUS="1",
        )
    )
    assert (cfg.task_timeout, cfg.poll_interval, cfg.max_message, cfg.ask_timeout) == (60, 0.5, 1000, 30)
    assert cfg.dangerous is True


def test_mcp_url_only_loopback():
    with pytest.raises(ConfigError) as e:
        load_config(env(TELEGRAM_MCP_URL="http://192.168.1.5:8000/mcp"))
    assert "TELEGRAM_ALLOW_REMOTE" in str(e.value)
    cfg = load_config(env(TELEGRAM_MCP_URL="http://192.168.1.5:8000/mcp", TELEGRAM_ALLOW_REMOTE="1"))
    assert cfg.mcp_url == "http://192.168.1.5:8000/mcp"


def test_mcp_url_fallbacks():
    assert load_config(env(ASK_URL="http://127.0.0.1:9000/mcp")).mcp_url == "http://127.0.0.1:9000/mcp"
    both = load_config(env(ASK_URL="http://127.0.0.1:9000/mcp", TELEGRAM_MCP_URL="http://127.0.0.1:8001/mcp"))
    assert both.mcp_url == "http://127.0.0.1:8001/mcp"
    with pytest.raises(ConfigError):
        load_config(env(TELEGRAM_MCP_URL="не адрес"))


def test_api_url_http_only_for_loopback():
    with pytest.raises(ConfigError):
        load_config(env(TELEGRAM_API_URL="http://evil.example.com"))
    assert load_config(env(TELEGRAM_API_URL="http://127.0.0.1:8081")).api_url == "http://127.0.0.1:8081"


def test_proxy_is_optional():
    assert load_config(env()).proxy is None


def test_proxy_schemes_accepted():
    for url in ("http://127.0.0.1:8080", "https://proxy.local:3128", "socks5://127.0.0.1:1080",
                "socks5h://127.0.0.1:1080"):
        assert load_config(env(TELEGRAM_PROXY=url)).proxy == url


def test_proxy_bad_value():
    with pytest.raises(ConfigError) as e:
        load_config(env(TELEGRAM_PROXY="127.0.0.1:8080"))  # без схемы
    assert "TELEGRAM_PROXY" in str(e.value)
    with pytest.raises(ConfigError):
        load_config(env(TELEGRAM_PROXY="ftp://127.0.0.1:21"))


def test_proxy_credentials_injected_and_redacted():
    cfg = load_config(
        env(
            TELEGRAM_PROXY="http://127.0.0.1:8080",
            TELEGRAM_PROXY_USERNAME="u@x",
            TELEGRAM_PROXY_PASSWORD="p:/1",
        )
    )
    assert cfg.proxy == "http://u%40x:p%3A%2F1@127.0.0.1:8080"
    shown = redact_proxy(cfg.proxy)
    assert shown == "http://***@127.0.0.1:8080"
    assert "u%40x" not in shown and "p%3A" not in shown


def test_proxy_credentials_from_url_are_kept():
    cfg = load_config(env(TELEGRAM_PROXY="socks5://user:pass@127.0.0.1:1080"))
    assert cfg.proxy == "socks5://user:pass@127.0.0.1:1080"
    assert redact_proxy(cfg.proxy) == "socks5://***@127.0.0.1:1080"


def test_redact_proxy_without_credentials():
    assert redact_proxy("http://127.0.0.1:8080") == "http://127.0.0.1:8080"
    assert redact_proxy(None) == "не задан"
