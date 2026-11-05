"""Настройки Telegram-бота: mcp/.env, переменные окружения, проверки.

Значения по умолчанию безопасные: режим `plan`, опасные инструменты запрещены,
без списка разрешённых пользователей бот не запускается.
"""

import os
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlparse

from ..config import load_dotenv  # noqa: F401  (.env рядом с server.py читается при импорте ask_mcp.config)

LOCAL_HOSTS = ("127.0.0.1", "::1", "localhost")
MODES = ("all", "edits", "plan")
LOG_LEVELS = ("debug", "info", "warn", "error")
DEFAULT_MCP_URL = "http://127.0.0.1:8000/mcp"
DEFAULT_API_URL = "https://api.telegram.org"


class ConfigError(Exception):
    """Понятная ошибка настроек: сообщение печатает точка входа, код выхода 2."""


@dataclass(frozen=True)
class BotConfig:
    token: str
    allowed_users: frozenset[int]
    allowed_chats: frozenset[int]
    mcp_url: str
    api_url: str
    default_mode: str
    dangerous: bool
    task_timeout: float
    poll_interval: float
    max_message: int
    ask_timeout: float
    log_level: str
    poll_timeout: int


def _raw(env: Mapping[str, str], name: str) -> str:
    return (env.get(name) or "").strip()


def _flag(env: Mapping[str, str], name: str, default: bool = False) -> bool:
    value = _raw(env, name).lower()
    if not value:
        return default
    return value in ("1", "true", "yes", "on")


def _int(env: Mapping[str, str], name: str, default: int, low: int, high: int) -> int:
    raw = _raw(env, name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} должен быть целым числом, получено: {raw!r}") from None
    if not low <= value <= high:
        raise ConfigError(f"{name} должен быть от {low} до {high}, получено: {value}")
    return value


def _float(env: Mapping[str, str], name: str, default: float, low: float, high: float) -> float:
    raw = _raw(env, name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} должен быть числом, получено: {raw!r}") from None
    if not low <= value <= high:
        raise ConfigError(f"{name} должен быть от {low} до {high}, получено: {value}")
    return value


def parse_ids(raw: str, name: str) -> frozenset[int]:
    """`123, 456` -> {123, 456}. Пустая строка -> пустой набор; мусор -> ConfigError."""
    ids: set[int] = set()
    for part in (raw or "").replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.add(int(part))
        except ValueError:
            raise ConfigError(f"{name}: ожидались числовые id через запятую, получено: {part!r}") from None
    return frozenset(ids)


def mcp_url(env: Mapping[str, str]) -> str:
    """TELEGRAM_MCP_URL, иначе ASK_URL, иначе http://127.0.0.1:8000/mcp. Только этот компьютер."""
    raw = (_raw(env, "TELEGRAM_MCP_URL") or _raw(env, "ASK_URL") or DEFAULT_MCP_URL).rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ConfigError(f"TELEGRAM_MCP_URL должен быть адресом вида {DEFAULT_MCP_URL}, получено: {raw!r}")
    allow = _flag(env, "TELEGRAM_ALLOW_REMOTE") or _flag(env, "ASK_ALLOW_REMOTE")
    if parsed.hostname not in LOCAL_HOSTS and not allow:
        raise ConfigError(
            f"TELEGRAM_MCP_URL={raw} указывает не на этот компьютер, а у MCP-сервера нет аутентификации. "
            "Оставьте 127.0.0.1 или задайте TELEGRAM_ALLOW_REMOTE=1 осознанно."
        )
    return raw


def api_url(env: Mapping[str, str]) -> str:
    """Адрес Bot API: https://api.telegram.org; http:// допустим только для этого компьютера (тесты)."""
    raw = (_raw(env, "TELEGRAM_API_URL") or DEFAULT_API_URL).rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ConfigError(f"TELEGRAM_API_URL должен быть адресом, получено: {raw!r}")
    if parsed.scheme != "https" and parsed.hostname not in LOCAL_HOSTS:
        raise ConfigError("TELEGRAM_API_URL: http:// допустим только для 127.0.0.1 (токен иначе уйдёт открытым)")
    return raw


def load_config(env: Mapping[str, str] | None = None) -> BotConfig:
    """Собирает настройки. Ошибка настроек — ConfigError с готовым текстом."""
    env = os.environ if env is None else env

    token = _raw(env, "TELEGRAM_BOT_TOKEN")
    if not token:
        raise ConfigError(
            "TELEGRAM_BOT_TOKEN не задан. Положите строку TELEGRAM_BOT_TOKEN=123456:AA... в mcp\\.env "
            "или задайте переменную окружения."
        )
    if ":" not in token or any(ch.isspace() for ch in token):
        raise ConfigError("TELEGRAM_BOT_TOKEN не похож на токен бота: нужен вид 123456789:AA...")

    users = parse_ids(_raw(env, "TELEGRAM_ALLOWED_USER_IDS"), "TELEGRAM_ALLOWED_USER_IDS")
    if not users and not _flag(env, "TELEGRAM_ALLOW_ANY"):
        raise ConfigError(
            "TELEGRAM_ALLOWED_USER_IDS не задан: бот не должен слушать всех подряд. "
            "Укажите свой id (узнать: /id у любого бота-эха) или TELEGRAM_ALLOW_ANY=1 осознанно."
        )
    chats = parse_ids(_raw(env, "TELEGRAM_ALLOWED_CHAT_IDS"), "TELEGRAM_ALLOWED_CHAT_IDS") or users

    mode = (_raw(env, "TELEGRAM_DEFAULT_MODE") or "plan").lower()
    if mode not in MODES:
        raise ConfigError(f"TELEGRAM_DEFAULT_MODE должен быть одним из {', '.join(MODES)}, получено: {mode!r}")

    level = (_raw(env, "TELEGRAM_LOG_LEVEL") or "info").lower()
    if level not in LOG_LEVELS:
        raise ConfigError(f"TELEGRAM_LOG_LEVEL должен быть одним из {', '.join(LOG_LEVELS)}, получено: {level!r}")

    return BotConfig(
        token=token,
        allowed_users=users,
        allowed_chats=chats,
        mcp_url=mcp_url(env),
        api_url=api_url(env),
        default_mode=mode,
        dangerous=_flag(env, "TELEGRAM_ALLOW_DANGEROUS"),
        task_timeout=_float(env, "TELEGRAM_TASK_TIMEOUT", 900.0, 5.0, 86_400.0),
        poll_interval=_float(env, "TELEGRAM_POLL_INTERVAL", 2.0, 0.1, 60.0),
        max_message=_int(env, "TELEGRAM_MAX_MESSAGE", 3900, 200, 4000),
        ask_timeout=_float(env, "TELEGRAM_ASK_TIMEOUT", 600.0, 5.0, 3600.0),
        log_level=level,
        poll_timeout=_int(env, "TELEGRAM_POLL_TIMEOUT", 25, 0, 50),
    )
