"""Прямые операции с файлами и командами без модели: /read, /list, /search, /write, /edit, /command."""

from typing import Literal

from ..api_client import call, dumps

Mode = Literal["all", "edits", "plan"]


async def read_file(path: str, offset: int | None = None, limit: int | None = None) -> str:
    """Прочитать файл проекта с номерами строк (POST /read).

    path: путь относительно папки проекта. offset: первая строка (с 1). limit: сколько строк.
    Секретные файлы (.env и подобные) сервер не отдаёт.
    """
    res = await call("POST", "/read", {"path": path, "offset": offset, "limit": limit})
    return dumps(res.data)


async def list_files(path: str | None = None, depth: int | None = None) -> str:
    """Дерево файлов (POST /list). path: папка (по умолчанию корень проекта). depth: глубина."""
    res = await call("POST", "/list", {"path": path, "depth": depth})
    return dumps(res.data)


async def search(pattern: str, path: str | None = None, regex: bool | None = None) -> str:
    """Поиск текста по файлам (POST /search); строки вида путь:строка: текст. regex: true — pattern регулярное выражение."""
    res = await call("POST", "/search", {"pattern": pattern, "path": path, "regex": regex})
    return dumps(res.data)


async def write_file(path: str, content: str, overwrite: bool | None = None, mode: Mode | None = None) -> str:
    """Записать файл (POST /write). Возвращает diff изменений.

    overwrite: false — не перезаписывать существующий файл (будет 409 exists). mode=plan запрещает запись (403).
    """
    res = await call("POST", "/write", {"path": path, "content": content, "overwrite": overwrite, "mode": mode})
    return dumps(res.data)


async def edit_file(path: str, old_text: str, new_text: str, mode: Mode | None = None) -> str:
    """Заменить фрагмент в файле (POST /edit). old_text должен встречаться ровно один раз, иначе 409.

    mode=plan запрещает правку (403).
    """
    res = await call("POST", "/edit", {"path": path, "old_text": old_text, "new_text": new_text, "mode": mode})
    return dumps(res.data)


async def run_command(command: str, timeout_sec: int | None = None, mode: Mode | None = None) -> str:
    """Выполнить команду в папке проекта (POST /command). Возвращает output и код выхода.

    timeout_sec: по умолчанию 120, максимум 600; по истечении 408. Команда с & в конце запускает приложение
    (смотрите list_apps). Команды, называющие .env или ключ, отклоняются (403). mode=plan запрещает команды.
    """
    wait = float(timeout_sec or 120) + 30.0  # ответ приходит одним куском, без пингов
    res = await call("POST", "/command", {"command": command, "timeout_sec": timeout_sec, "mode": mode},
                     read_timeout=wait)
    return dumps(res.data)


TOOLS = [read_file, list_files, search, write_file, edit_file, run_command]
