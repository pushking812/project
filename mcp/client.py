"""Минимальный MCP-клиент для УЖЕ запущенного сервера (сам сервер не запускает).

1) В первом окне запустите сервер:
    set ASK_API_KEY=sk-ask-...
    .venv\\Scripts\\python server.py --http
2) Во втором окне:
    .venv\\Scripts\\python client.py                 (инструменты + get_usage)
    .venv\\Scripts\\python client.py get_usage       (только get_usage)
    .venv\\Scripts\\python client.py "ваш вопрос"    (вызвать ask)
    .venv\\Scripts\\python client.py ask ваш вопрос  (то же, слово ask отбрасывается)
Адрес можно задать так: set ASK_URL=http://127.0.0.1:8000/mcp
"""
import asyncio
import os
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = os.environ.get("ASK_URL", "http://127.0.0.1:8000/mcp")


async def main():
    async with streamablehttp_client(URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = (await session.list_tools()).tools
            print("Инструменты:", [t.name for t in tools])

            # без аргументов: get_usage (бэкенд legacy) или health (бэкенд api, по умолчанию)
            status_tool = "get_usage" if "get_usage" in [t.name for t in tools] else "health"
            if len(sys.argv) > 1 and sys.argv[1] not in ("get_usage", "health"):
                words = sys.argv[1:]
                if words[0] == "ask":
                    words = words[1:]
                name, args = "ask", {"prompt": " ".join(words)}
            else:
                name, args = status_tool, {}
            result = await session.call_tool(name, args)
            print(f"{name} (ошибка):" if result.isError else f"{name}:")
            print(result.content[0].text)


try:
    asyncio.run(main())
except Exception as e:
    print(f"Не удалось подключиться к {URL}. Сервер запущен (server.py --http)? {type(e).__name__}: {e}")
    sys.exit(1)
