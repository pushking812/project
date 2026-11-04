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
    """Вопрос к модели без действий в проекте (POST /ask): файлы не меняются, команды не запускаются.

    prompt: вопрос.
    use_context: добавить к вопросу ASK.md, память и состояние папки (по умолчанию да).
    files: пути файлов в папке проекта (до 5, обычно до 30 МБ), которые сервер прочитает и приложит к вопросу:
           текст, PDF, картинки, .docx, .xlsx. Содержимое передавать не нужно, только пути.
    Возвращает JSON: text (ответ), usage. Расходует лимит тарифа.
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
    """Поручить задачу агенту и дождаться результата (POST /execute): он читает и правит файлы, запускает команды.

    prompt: текст задачи.
    mode: all — правки и команды без вопросов; edits — правки, без команд и чужих сайтов; plan — только чтение и план.
          По умолчанию берётся ASK_MODE сервера.
    session_id: сессия, историю которой видит модель (см. new_session). Без него берётся автосессия MCP
          (session_info; ASK_SESSION_AUTO=false отключает её, тогда задача без истории).
    browser: true — у задачи своё окно браузера (инструмент browser у модели).
    allowed_sites: хосты, которые можно открывать в режимах edits и plan.
    headless: false — окно задачи видимое (нужно для передачи человеку). captcha: handoff — звать человека
              при капче сразу, manual — только сообщить.
    files: пути файлов в папке проекта (до 5), которые сервер приложит к задаче (текст, PDF, картинки, .docx, .xlsx).
    Возвращает JSON: text (ответ), tools (вызванные инструменты), usage, session, done (steps, answer),
    output_files — относительные пути файлов, которые задача создала или изменила (поля нет, если таких не было).
    Задача может идти минуты; отмена вызова останавливает её. Расходует лимит тарифа.
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
    """Запустить ту же задачу в фоне (POST /start) и сразу получить taskId. Параметры как у execute.

    Дальше опрашивайте task_status (там же outputFiles), остановить можно через stop_task.
    Закрытие соединения задачу не останавливает.
    """
    res = await call("POST", "/start",
                     _task_body(prompt, mode, session_id, browser, allowed_sites, headless, captcha, files))
    return dumps(res.data)


async def task_status(task_id: str) -> str:
    """Состояние фоновой задачи (GET /status/:taskId): status running|done|error|stopped, answer, steps, usage, error, outputFiles (если задача что-то записала)."""
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
