"""Telegram-бот для управления локально запущенным MCP-сервером Ask.

Бот — MCP-клиент по Streamable HTTP: команды вызывают инструменты ask_mcp/server.py --http.
Настройки берутся из mcp\\.env и переменных окружения (TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, ...);
описание — docs/telegram-bot.md. Запуск: mcp\\run_bot.ps1 или .venv\\Scripts\\python telegram_bot.py.
"""

import asyncio
import sys

from ask_mcp.bot.app import main
from ask_mcp.bot.config import ConfigError


def run() -> int:
    try:
        asyncio.run(main())
    except ConfigError as e:
        print(e, file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
