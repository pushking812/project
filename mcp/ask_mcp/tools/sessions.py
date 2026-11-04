"""Сессии: /sessions*. Сессия хранит историю запросов; её session_id передают в execute и start_task."""

from typing import Literal

from .. import autosession
from ..api_client import call, dumps, seg
from ..errors import AskError

Mode = Literal["all", "edits", "plan"]


async def list_sessions(folder: str | None = None) -> str:
    """Список сессий папки, новые первыми (GET /sessions): id, title, requests, savedAt, current."""
    res = await call("GET", "/sessions", params={"folder": folder})
    return dumps(res.data)


async def new_session(title: str | None = None, folder: str | None = None) -> str:
    """Создать пустую сессию (POST /sessions); она становится текущей. Вернёт session_id для execute."""
    res = await call("POST", "/sessions", {"title": title, "folder": folder})
    autosession.set_current(res.data.get("session_id"))  # execute без session_id идёт в новую сессию
    return dumps(res.data)


async def resume_session(id: str, folder: str | None = None) -> str:
    """Сделать сессию текущей и получить её историю (POST /sessions/resume). 404 — нет такой; 409 — уже текущая."""
    res = await call("POST", "/sessions/resume", {"id": id, "folder": folder})
    autosession.set_current(res.data.get("session_id"))  # дальше execute без session_id продолжает её
    return dumps(res.data)


async def session_info(folder: str | None = None) -> str:
    """Автосессия этого MCP: session_id, title, requests, savedAt (GET /sessions/:id). Если сервер её ещё не сохранил
    (задач в ней не было), вернёт requests 0 и saved false. При ASK_SESSION_AUTO=false автосессии нет."""
    sid = autosession.current()
    if not sid:
        return dumps({"session_id": None, "auto": False})
    try:
        res = await call("GET", f"/sessions/{seg(sid)}", params={"folder": folder})
    except AskError as e:
        if not str(e).startswith("404"):
            raise
        return dumps({"session_id": sid, "title": None, "requests": 0, "savedAt": None, "saved": False})
    d = res.data
    return dumps({"session_id": sid, "title": d.get("title"), "requests": (len(d.get("history") or []) + 1) // 2,
                  "savedAt": d.get("savedAt"), "saved": True})


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


TOOLS = [list_sessions, new_session, resume_session, session_info, get_session, export_session]
