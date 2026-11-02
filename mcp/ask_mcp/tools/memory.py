"""Заметки ASK.md и память проекта: /notes, /remember, /memory."""

from typing import Literal

from ..api_client import call, dumps, seg
from ..errors import AskError

Mode = Literal["all", "edits", "plan"]


async def get_notes(folder: str | None = None) -> str:
    """Заметки проекта, которые получит модель (GET /notes): объединённый ASK.md, sources, clipped."""
    res = await call("GET", "/notes", params={"folder": folder})
    return dumps(res.data)


async def remember(note: str, folder: str | None = None, mode: Mode | None = None) -> str:
    """Дописать заметку в ASK.md (POST /remember). До 2000 символов. mode=plan запрещает запись."""
    res = await call("POST", "/remember", {"note": note, "folder": folder, "mode": mode})
    return dumps(res.data)


async def list_memory(folder: str | None = None) -> str:
    """Память проекта (GET /memory): index (MEMORY.md) и список тем."""
    res = await call("GET", "/memory", params={"folder": folder})
    return dumps(res.data)


async def read_memory(topic: str, folder: str | None = None) -> str:
    """Прочитать тему памяти (GET /memory/:topic), например stage2.md. Нет темы — 404."""
    res = await call("GET", f"/memory/{seg(topic)}", params={"folder": folder})
    return dumps(res.data)


async def write_memory(
    topic: str,
    content: str | None = None,
    old_text: str | None = None,
    new_text: str | None = None,
    folder: str | None = None,
    mode: Mode | None = None,
) -> str:
    """Записать тему памяти (POST /memory): либо content (целиком), либо old_text и new_text (правка).

    topic: простое имя с .md, без папок.
    """
    body = {"topic": topic, "content": content, "old_text": old_text, "new_text": new_text,
            "folder": folder, "mode": mode}
    res = await call("POST", "/memory", body)
    return dumps(res.data)


async def clear_memory(confirm: bool = False, folder: str | None = None) -> str:
    """Стереть всю память проекта (DELETE /memory). Необратимо: нужно confirm=true (сервер требует mode=all)."""
    if not confirm:
        raise AskError("clear_memory стирает всю память проекта. Передайте confirm=true, если это нужно.")
    res = await call("DELETE", "/memory", params={"mode": "all", "folder": folder})
    return dumps(res.data)


TOOLS = [get_notes, remember, list_memory, read_memory, write_memory, clear_memory]
