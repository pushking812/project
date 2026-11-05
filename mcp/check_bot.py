"""Проверка Telegram-бота без отправки сообщений: настройки, токен (getMe) и связь с MCP.

Запуск: .venv\\Scripts\\python check_bot.py
Печатает [OK]/[FAIL] по шагам; код выхода 0, если всё прошло, 1 — иначе.
Сообщения в чат не уходят: отправка проверяется вручную (run_bot.ps1).
"""

import asyncio
import sys

from ask_mcp.bot.config import ConfigError, load_config, redact_proxy
from ask_mcp.bot.mcp_client import McpError, McpWorker
from ask_mcp.bot.tg import TgApi, TgError

failed = False


def report(ok: bool, name: str, info: str = "") -> None:
    global failed
    failed = failed or not ok
    print(f"[{'OK' if ok else 'FAIL'}] {name} {info}".rstrip())


async def main() -> None:
    try:
        cfg = load_config()
    except ConfigError as e:
        report(False, "настройки", str(e))
        return
    proxy = redact_proxy(cfg.proxy) if cfg.proxy else "не задан (HTTPS_PROXY/ALL_PROXY из среды, если есть)"
    report(True, "настройки", f"пользователей {len(cfg.allowed_users)}, MCP {cfg.mcp_url}, прокси {proxy}")

    tg = TgApi(cfg.token, cfg.api_url, proxy=cfg.proxy)
    try:
        me = await tg.get_me()
        report(True, "токен", f"@{me.get('username')} (id {me.get('id')})")
    except TgError as e:
        report(False, "токен", str(e))
    finally:
        await tg.close()

    worker = McpWorker(cfg.mcp_url, connect_wait=6.0)
    await worker.start()
    try:
        tools = await worker.list_tools(timeout=15.0)
        report(True, "MCP", f"{cfg.mcp_url}: инструментов {len(tools)}")
        res = await worker.call("health", timeout=15.0)
        report(not res.is_error, "health", res.text[:120].replace("\n", " "))
    except McpError as e:
        report(False, "MCP", str(e))
    finally:
        await worker.stop()


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(1 if failed else 0)
