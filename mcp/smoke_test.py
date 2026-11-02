"""Проверка: запускает server.py по stdio, показывает инструменты и вызывает безопасные.

Запуск: .venv\\Scripts\\python smoke_test.py
Бэкенд api (по умолчанию): нужен запущенный ask-code-server (ASK_LOCAL_URL, по умолчанию http://127.0.0.1:8737).
Вызываются health, list_files, browser_state: модель не трогается, лимит не расходуется.
Бэкенд legacy (MCP_BACKEND=legacy): вызывается get_usage; нужен ASK_API_KEY (лимит не расходуется).
"""
import asyncio
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    params = StdioServerParameters(command=sys.executable, args=["server.py"], env=dict(os.environ))
    legacy = os.environ.get("MCP_BACKEND", "api").strip().lower() == "legacy"
    calls = [("get_usage", {})] if legacy else [("health", {}), ("list_files", {"depth": 1}), ("browser_state", {})]
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tools = await s.list_tools()
            print(f"tools ({len(tools.tools)}):", [t.name for t in tools.tools])
            failed = False
            for name, args in calls:
                res = await s.call_tool(name, args)
                print(f"--- {name}: isError={res.isError}")
                print(res.content[0].text[:600])
                failed = failed or res.isError
            return 1 if failed else 0


sys.exit(asyncio.run(main()))
