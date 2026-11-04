"""Автосессия: MCP сам выбирает session_id, чтобы история задач не терялась между вызовами и перезапусками.

Порядок выбора: id, названный явно в этом процессе (new_session, resume_session) > ASK_SESSION_ID > файл > новый uuid4.
Файл: ASK_SESSION_FILE, иначе %APPDATA%\\ask-code\\mcp-session.json (Windows) или ~/.config/ask-code/mcp-session.json.
ASK_SESSION_AUTO=false выключает всё: ни id, ни файла, задачи без истории, как раньше.
Id один на все папки: сервер хранит историю по папке, а неизвестный ему id открывает пустым.
"""

import json
import os
import re
import uuid
from pathlib import Path

SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")  # как на сервере (lib/sessions.mjs)

_explicit: str | None = None


def enabled() -> bool:
    return os.environ.get("ASK_SESSION_AUTO", "true").strip().lower() not in ("0", "false", "no", "off")


def session_file() -> Path:
    custom = os.environ.get("ASK_SESSION_FILE", "").strip()
    if custom:
        return Path(custom).expanduser()
    appdata = os.environ.get("APPDATA")
    if os.name == "nt" and appdata:
        return Path(appdata) / "ask-code" / "mcp-session.json"
    return Path.home() / ".config" / "ask-code" / "mcp-session.json"


def _read() -> str | None:
    try:
        value = json.loads(session_file().read_text(encoding="utf-8")).get("session_id")
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and SESSION_ID.match(value) else None


def _write(session_id: str) -> None:
    """Сохраняет id. Ошибка записи не мешает работе: id останется в памяти до перезапуска."""
    path = session_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"session_id": session_id}), encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
    except OSError:
        pass


def current() -> str | None:
    """Id автосессии для задач; None, если автосессия выключена."""
    global _explicit
    if not enabled():
        return None
    if _explicit:
        return _explicit
    env = os.environ.get("ASK_SESSION_ID", "").strip()
    if env and SESSION_ID.match(env):
        return env
    saved = _read()
    if saved:
        return saved
    _explicit = str(uuid.uuid4())
    _write(_explicit)
    return _explicit


def set_current(session_id: str) -> None:
    """Запоминает id (после new_session и resume_session) в памяти и в файле."""
    global _explicit
    if not enabled() or not isinstance(session_id, str) or not SESSION_ID.match(session_id):
        return
    _explicit = session_id
    _write(session_id)


def reset() -> None:
    """Забывает id в памяти (для тестов)."""
    global _explicit
    _explicit = None
