"""Живая проверка против настоящего MCP-сервера. Запуск: pytest -m live при `run_server.ps1`.

По умолчанию пропускается (pytest.ini: addopts = -m "not live"). Токен Telegram не нужен.
"""

import asyncio

import pytest

from ask_mcp.bot.config import load_config
from ask_mcp.bot.mcp_client import McpError, McpWorker

pytestmark = pytest.mark.live


def test_tools_and_health_against_running_server():
    cfg = load_config({"TELEGRAM_BOT_TOKEN": "1:live", "TELEGRAM_ALLOWED_USER_IDS": "1"})

    async def go():
        worker = McpWorker(cfg.mcp_url, connect_wait=3.0)
        await worker.start()
        try:
            tools = await worker.list_tools(timeout=10.0)
            names = {tool.name for tool in tools}
            assert {"ask", "health", "execute", "list_files"} <= names
            # health вызывает Node API: если он не запущен, MCP всё равно ответил текстом ошибки
            res = await worker.call("health", timeout=10.0)
            assert res.text
            if not res.is_error:
                assert '"ok"' in res.text
        except McpError as e:
            pytest.skip(f"нужен запущенный server.py --http ({cfg.mcp_url}): {e}")
        finally:
            await worker.stop()

    asyncio.run(go())
