"""Анализ файлов и готовые запросы: analyze, review, summarize, explain, plan. Строятся на /ask и /execute с `files`."""

import os
from typing import Literal

from ..api_client import call, dumps, fold_stream
from ..errors import AskError

# Тот же текст, что REVIEW_PROMPT в ask-code.mjs, но для одного файла.
_PROMPTS = {
    "ru": {
        "review": "Проверь этот файл: ищи ошибки, риски и всё неясное. Ничего не меняй: перечисли, что бы ты "
                  "исправил, самое важное первым.",
        "summarize": "Дай краткое описание содержимого этого файла.",
        "explain": "Объясни, что делает этот код или документ и для чего он.",
        "plan": "Составь подробный план для задачи: {prompt}. Не выполняй её, дай только план.",
    },
    "en": {
        "review": "Review this file for bugs, risks and anything unclear. Don't change anything: list what you "
                  "would fix, most important first.",
        "summarize": "Give a concise summary of this file's contents.",
        "explain": "Explain what this code or document does and what it is for.",
        "plan": "Make a detailed plan for this task: {prompt}. Do not carry it out, only give the plan.",
    },
}


def _prompt(kind: str, **kw) -> str:
    lang = "en" if os.environ.get("ASK_LANG", "").strip().lower().startswith("en") else "ru"
    return _PROMPTS[lang][kind].format(**kw)


async def analyze(path: str, prompt: str, mode: Literal["read", "write"] = "read") -> str:
    """Разобрать файл по вопросу: сервер сам читает его (текст, PDF, картинка, .docx, .xlsx).

    path: файл в папке проекта (вне неё — 403). mode: read — только ответ (/ask); write — агент может менять файлы (/execute).
    Возвращает JSON: text и usage (read) или answer и output_files (write). Расходует лимит тарифа.
    """
    if mode not in ("read", "write"):
        raise AskError(f"mode должен быть read или write, получено: {mode!r}")
    if not isinstance(path, str) or not path.strip():
        raise AskError("path не должен быть пустым")
    if not isinstance(prompt, str) or not prompt.strip():
        raise AskError("prompt не должен быть пустым")
    if mode == "read":
        res = await call("POST", "/ask", {"prompt": prompt, "files": [path], "useContext": True})
        out = fold_stream(res.events or [])
        return dumps({"text": out["text"], "usage": out.get("usage")})
    res = await call("POST", "/execute", {"prompt": prompt, "files": [path], "mode": "all"}, read_timeout=600.0)
    out = fold_stream(res.events or [])
    answer = (out.get("done") or {}).get("answer") or out["text"]
    result = {"answer": answer}
    if out.get("output_files"):
        result["output_files"] = out["output_files"]
    return dumps(result)


async def review(path: str) -> str:
    """Проверить файл (код или документ) на ошибки, риски и недочёты, ничего не меняя. Ответ как у analyze в режиме read."""
    return await analyze(path, _prompt("review"), mode="read")


async def summarize(path: str) -> str:
    """Краткое описание содержимого файла. Ответ как у analyze в режиме read."""
    return await analyze(path, _prompt("summarize"), mode="read")


async def explain(path: str) -> str:
    """Объяснить, что делает код или документ и для чего он. Ответ как у analyze в режиме read."""
    return await analyze(path, _prompt("explain"), mode="read")


async def plan(prompt: str) -> str:
    """План для задачи без её выполнения (POST /ask с контекстом проекта). Возвращает JSON: text, usage."""
    if not isinstance(prompt, str) or not prompt.strip():
        raise AskError("prompt не должен быть пустым")
    res = await call("POST", "/ask", {"prompt": _prompt("plan", prompt=prompt), "useContext": True})
    out = fold_stream(res.events or [])
    return dumps({"text": out["text"], "usage": out.get("usage")})


TOOLS = [analyze, review, summarize, explain, plan]
