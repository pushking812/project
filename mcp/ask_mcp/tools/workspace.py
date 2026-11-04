"""Рабочая папка сервера: GET/POST /workspace. После смены все файловые инструменты и задачи работают в новой папке."""

from typing import Literal

from ..api_client import call, dumps

Mode = Literal["all", "edits", "plan"]


async def get_workspace() -> str:
    """Рабочая папка сервера (GET /workspace): root, allowedRoots (куда её можно сменить), sessionId текущей сессии папки."""
    res = await call("GET", "/workspace")
    return dumps(res.data)


async def set_workspace(path: str, mode: Mode | None = None) -> str:
    """Сменить рабочую папку сервера (POST /workspace). Относительный путь считается от текущей папки.

    Закрывает окно браузера, останавливает наблюдения и фоновые приложения старой папки. Ошибки: 403 system_path /
    home_forbidden / not_allowed (ASK_ALLOWED_ROOTS) / plan_mode, 404 not_found, 409 tasks_running (идёт задача или
    запрос: дождитесь или остановите). Повтор на текущую папку — 200 already_current.
    """
    res = await call("POST", "/workspace", {"path": path, "mode": mode})
    return dumps(res.data)


TOOLS = [get_workspace, set_workspace]
