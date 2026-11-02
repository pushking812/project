"""Наблюдения (/watches) и запущенные приложения (/apps)."""

from typing import Literal

from ..api_client import call, dumps, seg

Mode = Literal["all", "edits", "plan"]


async def list_watches() -> str:
    """Наблюдения за страницами и командами (GET /watches): id, target, everyMs, checks, alerts, wanted."""
    res = await call("GET", "/watches")
    return dumps(res.data)


async def add_watch(spec: str, mode: Mode | None = None, allowed_sites: list[str] | None = None) -> str:
    """Создать наблюдение (POST /watches). spec: https://example.com every 5m for "available"; вместо адреса можно команду.

    Для страницы окно должно быть открыто (browser_open), иначе 400 browser_off. Команда в edits и plan отклоняется.
    """
    res = await call("POST", "/watches", {"spec": spec, "mode": mode, "allowedSites": allowed_sites})
    return dumps(res.data)


async def remove_watch(watch_id: str) -> str:
    """Остановить одно наблюдение (DELETE /watches/:id). Нет такого — 404."""
    res = await call("DELETE", f"/watches/{seg(watch_id)}")
    return dumps(res.data)


async def remove_all_watches() -> str:
    """Остановить все наблюдения (DELETE /watches)."""
    res = await call("DELETE", "/watches")
    return dumps(res.data)


async def list_apps() -> str:
    """Приложения, запущенные командами с & (GET /apps): n, command, url, running."""
    res = await call("GET", "/apps")
    return dumps(res.data)


async def stop_app(n: int) -> str:
    """Остановить одно приложение по номеру (DELETE /apps/:n). Нет такого — 404."""
    res = await call("DELETE", f"/apps/{int(n)}")
    return dumps(res.data)


async def stop_all_apps() -> str:
    """Остановить все приложения (DELETE /apps)."""
    res = await call("DELETE", "/apps")
    return dumps(res.data)


TOOLS = [list_watches, add_watch, remove_watch, remove_all_watches, list_apps, stop_app, stop_all_apps]
