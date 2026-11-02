"""Контекст, сжатие, модель и диагностика: /context, /status, /compact, /models, /model, /doctor, /bug."""

from ..api_client import call, dumps, fold_stream


async def get_context(folder: str | None = None, session_id: str | None = None) -> str:
    """Сколько токенов занимают задача, заметки, память и описание папки (GET /context); contextLeft — остаток в процентах."""
    res = await call("GET", "/context", params={"folder": folder, "session_id": session_id})
    return dumps(res.data)


async def get_status(folder: str | None = None, session_id: str | None = None) -> str:
    """Аккаунт, тариф, модель, папка, режим, задача, память и заметки (GET /status). Не путать с task_status."""
    res = await call("GET", "/status", params={"folder": folder, "session_id": session_id})
    return dumps(res.data)


async def compact(session_id: str | None = None, folder: str | None = None, focus: str | None = None) -> str:
    """Сжать историю сессии в краткое резюме (POST /compact). focus: на чём сделать упор.

    Нужно минимум два запроса в сессии (иначе 400 too_short). Возвращает summary. Расходует лимит тарифа.
    """
    res = await call("POST", "/compact", {"session_id": session_id, "folder": folder, "focus": focus},
                     read_timeout=300.0)
    out = fold_stream(res.events or [])
    done = out.get("done") or {}
    return dumps({"summary": done.get("summary") or out["text"], "requests": done.get("requests"),
                  "session_id": done.get("session_id"), "usage": out.get("usage")})


async def list_models() -> str:
    """Модели вашего тарифа и выбранная сейчас (GET /models)."""
    res = await call("GET", "/models")
    return dumps(res.data)


async def set_model(name: str) -> str:
    """Выбрать модель для следующих задач (POST /model): sonnet, opus или полное имя. Действует на весь сервер."""
    res = await call("POST", "/model", {"name": name})
    return dumps(res.data)


async def doctor(folder: str | None = None) -> str:
    """Проверки компьютера и сайта (GET /doctor): ключ, тариф, Chrome, poppler, редактор, ASK.md. У провалов есть fix."""
    res = await call("GET", "/doctor", params={"folder": folder})
    return dumps(res.data)


async def report_bug(text: str) -> str:
    """Отправить отчёт команде сайта Ask (POST /bug). Уходит только text (до 2000 знаков) и версии; создаёт настоящий отчёт."""
    res = await call("POST", "/bug", {"text": text})
    return dumps(res.data)


TOOLS = [get_context, get_status, compact, list_models, set_model, doctor, report_bug]
