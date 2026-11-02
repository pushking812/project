"""Проверка УЖЕ запущенного MCP-сервера (сам сервер не запускает): OK/FAIL по шагам.

1) В первом окне запустите сервер:
    set ASK_API_KEY=sk-ask-...
    .venv\\Scripts\\python server.py --http
2) Во втором окне:
    .venv\\Scripts\\python check_mcp.py          # без траты лимита
    .venv\\Scripts\\python check_mcp.py --ask    # ещё и один короткий вызов ask (расходует лимит)
Адрес: set ASK_URL=http://127.0.0.1:8000/mcp
Код выхода 0 при успехе, 1 при любой ошибке.
"""
import asyncio
import os
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = os.environ.get("ASK_URL", "http://127.0.0.1:8000/mcp")
failed = False


def report(ok, name, info=""):
    global failed
    failed = failed or not ok
    print(f"[{'OK' if ok else 'FAIL'}] {name} {info}".rstrip())


def short(res):
    return res.content[0].text[:120].replace("\n", " ") if res.content else ""


async def main():
    async with streamablehttp_client(URL) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()
            report(True, "подключение к серверу", URL)

            names = [t.name for t in (await s.list_tools()).tools]
            # бэкенд legacy даёт get_usage, бэкенд api (по умолчанию) — health и остальные инструменты API
            legacy = "get_usage" in names and "health" not in names
            status_tool = "get_usage" if legacy else "health"
            need = {"ask", "get_usage"} if legacy else {"ask", "execute", "health", "read_file"}
            report(need <= set(names), "инструменты", str(names))

            res = await s.call_tool(status_tool, {})
            report(not res.isError, status_tool, short(res))

            if "--ask" in sys.argv:
                res = await s.call_tool("ask", {"prompt": "Ответь одним словом: pong"})
                report(not res.isError, "ask", short(res))


try:
    asyncio.run(main())
except BaseException as e:
    if isinstance(e, KeyboardInterrupt):
        raise
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    report(False, "подключение", f"{URL} — сервер запущен (server.py --http)? {type(e).__name__}: {e}")

sys.exit(1 if failed else 0)
