"""Сессии: /sessions*. Сессия хранит историю запросов; её session_id передают в execute и start_task."""

from typing import Literal

from ..api_client import call, dumps, seg

Mode = Literal["all", "edits", "plan"]


async def list_sessions(folder: str | None = None) -> str:
    """Список сессий папки, новые первыми (GET /sessions): id, title, requests, savedAt, current."""
    res = await call("GET", "/sessions", params={"folder": folder})
    return dumps(res.data)


async def new_session(title: str | None = None, folder: str | None = None) -> str:
    """Создать пустую сессию (POST /sessions); она становится текущей. Вернёт session_id для execute."""
    res = await call("POST", "/sessions", {"title": title, "folder": folder})
    return dumps(res.data)


async def resume_session(id: str, folder: str | None = None) -> str:
    """Сделать сессию текущей и получить её историю (POST /sessions/resume). 404 — нет такой; 409 — уже текущая."""
    res = await call("POST", "/sessions/resume", {"id": id, "folder": folder})
    return dumps(res.data)


async def get_session(id: str, folder: str | None = None) -> str:
    """История сессии без смены текущей (GET /sessions/:id): history, title, inputs, savedAt."""
    res = await call("GET", f"/sessions/{seg(id)}", params={"folder": folder})
    return dumps(res.data)


async def export_session(
    id: str, filename: str | None = None, folder: str | None = None, mode: Mode | None = None
) -> str:
    """Выгрузить сессию в Markdown-файл проекта (POST /sessions/:id/export). Существующий файл не перезаписывается (409)."""
    res = await call("POST", f"/sessions/{seg(id)}/export", {"filename": filename, "folder": folder, "mode": mode})
    return dumps(res.data)


TOOLS = [list_sessions, new_session, resume_session, get_session, export_session]
