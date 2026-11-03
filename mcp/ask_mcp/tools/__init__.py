"""Инструменты MCP, работающие через HTTP API нашего сервера (бэкенд «api»). Одна группа на модуль."""

from . import browser, files, memory, office, service, sessions, tasks, vba, watches

GROUPS = {
    "tasks": tasks,
    "files": files,
    "office": office,
    "vba": vba,
    "memory": memory,
    "sessions": sessions,
    "browser": browser,
    "watches": watches,
    "service": service,
}


def all_tools() -> list:
    return [fn for group in GROUPS.values() for fn in group.TOOLS]


def register(mcp) -> None:
    """Подключает все инструменты; имя инструмента = имя функции."""
    for fn in all_tools():
        mcp.tool(name=fn.__name__)(fn)
