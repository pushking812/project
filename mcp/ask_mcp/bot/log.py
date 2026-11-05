"""Логи бота: только stderr, одна строка на событие.

Токен бота в текст не попадает: set_secret() подменяет его на `***` во всех сообщениях.
"""

import sys

LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}
_level = LEVELS["info"]
_secret = ""


def configure(level: str = "info") -> None:
    """Уровень вывода (debug|info|warn|error). Неизвестное значение — info."""
    global _level
    _level = LEVELS.get(str(level).lower(), LEVELS["info"])


def set_secret(value: str | None) -> None:
    """Значение, которое нельзя показывать в логе (токен бота)."""
    global _secret
    _secret = value or ""


def redact(text: str) -> str:
    return text.replace(_secret, "***") if _secret else text


def log(level: str, area: str, message: str) -> None:
    if LEVELS.get(level, LEVELS["info"]) < _level:
        return
    print(f"[{level.upper()}] [{area}] {redact(str(message))}", file=sys.stderr, flush=True)


def debug(area: str, message: str) -> None:
    log("debug", area, message)


def info(area: str, message: str) -> None:
    log("info", area, message)


def warn(area: str, message: str) -> None:
    log("warn", area, message)


def error(area: str, message: str) -> None:
    log("error", area, message)
