"""Задачи модели: /ask, /execute, /start, /status/:id, /stop/:id и служебные /health, /me."""

from typing import Literal

from .. import autosession
from ..api_client import call, dumps, fold_stream, seg
from ..errors import AskError

Mode = Literal["all", "edits", "plan"]


def _task_body(prompt, mode, session_id, browser, allowed_sites, headless, captcha, files=None) -> dict:
    return {
        "prompt": prompt,
        "mode": mode,
        "session_id": session_id,
        "browser": browser,
        "allowedSites": allowed_sites,
        "headless": headless,
        "captcha": captcha,
        "files": list(files) if files else None,
    }


async def ask(prompt: str, use_context: bool = True, files: list[str] = []) -> str:
    """Вопрос к модели без действий в проекте (POST /ask).

    use_context: добавить ASK.md, память и состояние папки.
    files: до 5 путей файлов проекта (текст, PDF, картинки, .docx, .xlsx); содержимое не передавать.
    Возвращает JSON: text, usage. Расходует лимит тарифа.
    """
    body = {"prompt": prompt, "useContext": use_context}
    if files:
        body["files"] = files
    res = await call("POST", "/ask", body)
    out = fold_stream(res.events or [])
    return dumps({"text": out["text"], "usage": out.get("usage")})


async def execute(
    prompt: str,
    mode: Mode | None = None,
    session_id: str | None = None,
    browser: bool | None = None,
    allowed_sites: list[str] | None = None,
    headless: bool | None = None,
    captcha: Literal["manual", "handoff"] | None = None,
    files: list[str] = [],
) -> str:
    """Поручить задачу агенту и дождаться результата (POST /execute): он правит файлы и запускает команды.

    mode: all — всё без вопросов; edits — правки без команд и чужих сайтов; plan — только чтение и план.
    session_id: сессия с историей (new_session); без неё — автосессия MCP.
    browser: своё окно браузера; headless=false — видимое; allowed_sites — хосты для edits и plan.
    captcha: handoff — звать человека сразу, manual — только сообщить.
    files: до 5 путей файлов проекта, приложить к задаче.
    Возвращает JSON: text, tools, usage, session, done, output_files. Идёт минуты; расходует лимит тарифа.
    """
    auto = None if session_id else autosession.current()
    sid = session_id or auto
    try:
        res = await call("POST", "/execute",
                         _task_body(prompt, mode, sid, browser, allowed_sites, headless, captcha, files),
                         read_timeout=600.0)
    except AskError as e:
        if not (auto and "session_busy" in str(e)):
            raise
        # В автосессии уже идёт другая задача: эта идёт без истории, а не падает.
        res = await call("POST", "/execute",
                         _task_body(prompt, mode, None, browser, allowed_sites, headless, captcha, files),
                         read_timeout=600.0)
    out = fold_stream(res.events or [])
    return dumps(out)


async def start_task(
    prompt: str,
    mode: Mode | None = None,
    session_id: str | None = None,
    browser: bool | None = None,
    allowed_sites: list[str] | None = None,
    headless: bool | None = None,
    captcha: Literal["manual", "handoff"] | None = None,
    files: list[str] = [],
) -> str:
    """Та же задача в фоне (POST /start), сразу возвращает taskId. Параметры как у execute.

    Дальше task_status; остановить — stop_task.
    """
    res = await call("POST", "/start",
                     _task_body(prompt, mode, session_id, browser, allowed_sites, headless, captcha, files))
    return dumps(res.data)


async def task_status(task_id: str) -> str:
    """Состояние фоновой задачи (GET /status/:taskId): status, answer, steps, usage, error, outputFiles."""
    res = await call("GET", f"/status/{seg(task_id)}")
    return dumps(res.data)


async def stop_task(task_id: str) -> str:
    """Остановить фоновую задачу (POST /stop/:taskId). Для уже завершённой вернёт её итоговый статус."""
    res = await call("POST", f"/stop/{seg(task_id)}")
    return dumps(res.data)


async def health() -> str:
    """Состояние нашего сервера (GET /health): версия, папка проекта, есть ли ключ, сколько задач идёт."""
    res = await call("GET", "/health")
    return dumps(res.data)


async def me() -> str:
    """Аккаунт, тариф и лимиты на сайте Ask (GET /me, прокси /v1/me)."""
    res = await call("GET", "/me")
    return dumps(res.data)


TOOLS = [ask, execute, start_task, task_status, stop_task, health, me]
