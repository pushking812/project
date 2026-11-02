"""Задачи модели: /ask, /execute, /start, /status/:id, /stop/:id и служебные /health, /me."""

from typing import Literal

from ..api_client import call, dumps, fold_stream, seg

Mode = Literal["all", "edits", "plan"]


def _task_body(prompt, mode, session_id, browser, allowed_sites, headless, captcha) -> dict:
    return {
        "prompt": prompt,
        "mode": mode,
        "session_id": session_id,
        "browser": browser,
        "allowedSites": allowed_sites,
        "headless": headless,
        "captcha": captcha,
    }


async def ask(prompt: str, use_context: bool = True) -> str:
    """Вопрос к модели без действий в проекте (POST /ask): файлы не меняются, команды не запускаются.

    prompt: вопрос.
    use_context: добавить к вопросу ASK.md, память и состояние папки (по умолчанию да).
    Возвращает JSON: text (ответ), usage. Расходует лимит тарифа.
    """
    res = await call("POST", "/ask", {"prompt": prompt, "useContext": use_context})
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
) -> str:
    """Поручить задачу агенту и дождаться результата (POST /execute): он читает и правит файлы, запускает команды.

    prompt: текст задачи.
    mode: all — правки и команды без вопросов; edits — правки, без команд и чужих сайтов; plan — только чтение и план.
          По умолчанию берётся ASK_MODE сервера.
    session_id: сессия, историю которой видит модель (см. new_session); без неё задача без истории.
    browser: true — у задачи своё окно браузера (инструмент browser у модели).
    allowed_sites: хосты, которые можно открывать в режимах edits и plan.
    headless: false — окно задачи видимое (нужно для передачи человеку). captcha: handoff — звать человека
              при капче сразу, manual — только сообщить.
    Возвращает JSON: text (ответ), tools (вызванные инструменты), usage, session, done (steps, answer).
    Задача может идти минуты; отмена вызова останавливает её. Расходует лимит тарифа.
    """
    res = await call("POST", "/execute", _task_body(prompt, mode, session_id, browser, allowed_sites, headless, captcha),
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
) -> str:
    """Запустить ту же задачу в фоне (POST /start) и сразу получить taskId. Параметры как у execute.

    Дальше опрашивайте task_status, остановить можно через stop_task. Закрытие соединения задачу не останавливает.
    """
    res = await call("POST", "/start", _task_body(prompt, mode, session_id, browser, allowed_sites, headless, captcha))
    return dumps(res.data)


async def task_status(task_id: str) -> str:
    """Состояние фоновой задачи (GET /status/:taskId): status running|done|error|stopped, answer, steps, usage, error."""
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
