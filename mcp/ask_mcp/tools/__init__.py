"""Инструменты MCP, работающие через HTTP API нашего сервера (бэкенд «api»). Одна группа на модуль."""

from . import analysis, browser, desktop, files, memory, office, service, sessions, tasks, vba, watches, workspace

GROUPS = {
    "tasks": tasks,
    "analysis": analysis,
    "files": files,
    "office": office,
    "vba": vba,
    "memory": memory,
    "sessions": sessions,
    "browser": browser,
    "watches": watches,
    "service": service,
    "workspace": workspace,
    "desktop": desktop,
}


def parse_groups(value: str | None) -> list[str]:
    """«office, vba» -> ['office', 'vba']; неизвестное имя группы — ValueError."""
    names = [p.strip().lower() for p in (value or "").split(",") if p.strip()]
    bad = [n for n in names if n not in GROUPS]
    if bad:
        raise ValueError(f"Неизвестные группы инструментов: {', '.join(bad)}. Есть: {', '.join(GROUPS)}.")
    return names


def all_tools(only: list[str] | None = None, skip: list[str] | None = None) -> list:
    """Инструменты групп: only — только эти группы, skip — все, кроме этих."""
    return [fn for name, group in GROUPS.items()
            if (not only or name in only) and name not in (skip or [])
            for fn in group.TOOLS]


def register(mcp, only: list[str] | None = None, skip: list[str] | None = None) -> None:
    """Подключает инструменты; имя инструмента = имя функции."""
    for fn in all_tools(only, skip):
        mcp.tool(name=fn.__name__)(fn)
