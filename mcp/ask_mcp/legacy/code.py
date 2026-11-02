"""Прежний инструмент code: Ask правит файлы проекта через /v1/code сайта Ask.

Код перенесён из старого server.py без изменения поведения. Новый путь для правок кода — инструмент `execute`
(бэкенд api), который идёт через наш сервер; этот модуль остаётся для режима MCP_BACKEND=legacy|both.
Поведение скопировано с review/checks/ask_code.py (эталон M0.5, маршрут B). Отличие одно: границы записи
задаются списком запретов CODE_DENY, а не списком разрешённых путей.
"""

import asyncio
import json
import os
import re
import sys
import time

import httpx

from ..config import BASE_URL
from ..errors import AskError
from ..sse import sse_frames
from .remote import State, handle, headers, http_error_text

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CODE_ROOT = os.path.abspath(os.environ.get("ASK_CODE_ROOT") or _REPO_ROOT)
CODE_DENY = (".env", ".git", ".venv", "__pycache__", ".pytest_cache", "runs")
CODE_MAX_OUTPUT = 8000


def _code_root() -> str:
    # Читается при вызове, не на импорте: тесты подменяют CODE_ROOT.
    return os.path.abspath(CODE_ROOT)


def _code_rel(path: str) -> str:
    """Путь относительно корня; абсолютный путь или выход из корня — RuntimeError."""
    root = _code_root()
    clean = (path or ".").replace("\\", "/").strip()
    if clean.startswith("/") or (len(clean) > 1 and clean[1] == ":"):
        raise RuntimeError(f"абсолютный путь запрещён: {path}")
    full = os.path.abspath(os.path.join(root, clean))
    if full != root and not full.startswith(root + os.sep):
        raise RuntimeError(f"путь вне проекта: {path}")
    return os.path.relpath(full, root).replace("\\", "/")


def _code_denied(name: str) -> bool:
    """Запрет по сегментам пути (не по подстроке): .env закрыт, .env.example открыт."""
    deny = {d.lower() for d in CODE_DENY}
    return any(part.lower() in deny for part in name.split("/"))


def _code_path(path: str) -> str:
    """_code_rel плюс запреты CODE_DENY: один вход для чтения и записи."""
    name = _code_rel(path)
    if _code_denied(name):
        raise RuntimeError(f"доступ запрещён: {name}")
    return name


def _code_clip(text: str) -> str:
    return text if len(text) <= CODE_MAX_OUTPUT else text[:CODE_MAX_OUTPUT] + "\n…обрезано"


def _code_walk(base: str):
    """Файлы под base без запрещённых каталогов и файлов; если base — файл, то он сам."""
    if os.path.isfile(base):
        yield base
        return
    for folder, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d.lower() not in {x.lower() for x in CODE_DENY})
        for name in sorted(files):
            if name.lower() not in {x.lower() for x in CODE_DENY}:
                yield os.path.join(folder, name)


def _tl_list_files(args: dict) -> str:
    root = _code_root()
    target = _code_path(args.get("path", "."))
    depth = int(args.get("depth", 2))
    base = os.path.join(root, target)
    lines = []
    for full in _code_walk(base):
        inside = os.path.relpath(os.path.dirname(full), base)
        if inside != "." and inside.count(os.sep) + 1 >= depth:
            continue
        lines.append(os.path.relpath(full, root).replace("\\", "/"))
    return "\n".join(lines[:500]) or "(пусто)"


def _tl_read_file(args: dict) -> str:
    name = _code_path(args["path"])
    offset = int(args.get("offset") or 1)
    limit = int(args.get("limit") or 400)
    with open(os.path.join(_code_root(), name), encoding="utf-8", newline="") as handle_:
        rows = handle_.read().splitlines()
    chunk = rows[offset - 1: offset - 1 + limit]
    head = f"# {name}: строки {offset}-{offset + len(chunk) - 1} из {len(rows)}\n"
    return head + "\n".join(chunk)


def _tl_search(args: dict) -> str:
    root = _code_root()
    pattern = args["pattern"]
    target = _code_path(args.get("path", "."))
    matcher = re.compile(pattern if args.get("regex") else re.escape(pattern))
    hits = []
    for full in _code_walk(os.path.join(root, target)):
        try:
            with open(full, encoding="utf-8", newline="") as handle_:
                for number, line in enumerate(handle_, 1):
                    if matcher.search(line):
                        name = os.path.relpath(full, root).replace("\\", "/")
                        hits.append(f"{name}:{number}: {line.rstrip()}")
                        if len(hits) >= 100:
                            return "\n".join(hits) + "\n…ещё есть"
        except (UnicodeDecodeError, OSError):
            continue
    return "\n".join(hits) or "(не найдено)"


def _tl_write_file(args: dict) -> str:
    root = _code_root()
    name = _code_path(args["path"])
    full = os.path.join(root, name)
    os.makedirs(os.path.dirname(full) or root, exist_ok=True)
    body = args.get("content") or ""
    with open(full, "w", encoding="utf-8", newline="") as handle_:
        handle_.write(body)
    return f"записано {len(body)} символов в {name}"


def _tl_edit_file(args: dict) -> str:
    name = _code_path(args["path"])
    full = os.path.join(_code_root(), name)
    old, new = args.get("old_text") or "", args.get("new_text") or ""
    with open(full, encoding="utf-8", newline="") as handle_:
        body = handle_.read()
    found = body.count(old)
    if found != 1:
        raise RuntimeError(f"old_text встречается {found} раз, нужно ровно 1")
    with open(full, "w", encoding="utf-8", newline="") as handle_:
        handle_.write(body.replace(old, new))
    return f"заменено в {name} ({len(old)} → {len(new)} символов)"


_CODE_TOOLS = {
    "list_files": _tl_list_files,
    "read_file": _tl_read_file,
    "search": _tl_search,
    "write_file": _tl_write_file,
    "edit_file": _tl_edit_file,
}


def _code_run_tool(name: str, args: dict) -> dict:
    """Выполняет инструмент; возвращает {"ok": bool, "output": str} для /v1/code/{runId}/tools/{callId}."""
    handler = _CODE_TOOLS.get(name)
    if handler is None:
        return {"ok": False, "output": f"неизвестный инструмент: {name}"}
    try:
        return {"ok": True, "output": _code_clip(handler(args or {}))}
    except Exception as exc:  # модель должна узнать причину и сменить план
        return {"ok": False, "output": f"{type(exc).__name__}: {exc}"}


async def code(task: str, model: str | None = None, max_steps: int = 35) -> str:
    """Поручить Ask правку кода проекта (POST /v1/code); возвращает JSON с итогом.

    task: что сделать (например «добавь тест для X»). Модель читает и меняет файлы в корне
    проекта через list_files, read_file, search, write_file, edit_file; запускать команды
    она не может. Запись и чтение закрыты для .env, .git, .venv, __pycache__, runs.
    model: необязательно, например claude-haiku-5-5.
    max_steps: сколько вызовов инструментов разрешено (по умолчанию 35), потом задача останавливается.
    Каждый вызов расходует лимит тарифа.
    """
    if not task or not task.strip():
        raise AskError("Пустая задача: опишите, что нужно сделать с кодом.")
    body: dict = {"prompt": task, "folder": os.path.basename(_code_root())}
    if model:
        body["model"] = model
    hdrs = headers({"Accept": "text/event-stream"})

    started = time.monotonic()
    state = State()
    steps: list[dict] = []
    status = "no_done"
    try:
        async with httpx.AsyncClient(base_url=BASE_URL, timeout=httpx.Timeout(300.0, connect=30.0)) as client:
            async with client.stream("POST", "/v1/code", json=body, headers=hdrs) as r:
                if r.status_code >= 400:
                    raise AskError(http_error_text(r.status_code, await r.aread(), r.headers))
                state.run_id = r.headers.get("x-run-id")
                async for event, data, _ in sse_frames(r):
                    if event != "tool":
                        handle(event, data, state)  # error -> AskError
                        if state.saw_done:
                            status = "done"
                            break
                        continue
                    run_id = data.get("runId") or state.run_id
                    call_id = str(data.get("callId", ""))
                    over = len(steps) >= max_steps
                    if over:
                        result = {"ok": False, "output": "бюджет шагов исчерпан проверяющим"}
                    else:
                        tool_input = data.get("input")
                        result = await asyncio.to_thread(
                            _code_run_tool, str(data.get("name", "")), tool_input if isinstance(tool_input, dict) else {}
                        )
                        steps.append({"name": data.get("name", ""), "ok": result["ok"]})
                    rr = await client.post(f"/v1/code/{run_id}/tools/{call_id}", json=result, headers=hdrs)
                    if over:
                        try:
                            await client.post(f"/v1/runs/{run_id}/stop", headers=hdrs)
                        except httpx.HTTPError:
                            pass
                        status = "budget"
                        break
                    if rr.status_code >= 400:
                        raise AskError(http_error_text(rr.status_code, rr.content, rr.headers))
    except httpx.HTTPError as e:
        status = "error"
        raise AskError(f"Сетевая ошибка: {type(e).__name__}: {e}") from e
    except AskError:
        status = "error"
        raise
    finally:
        if status == "no_done":
            status = "interrupted"
        print(
            json.dumps(
                {"tool": "code", "prompt_chars": len(task), "steps": len(steps), "status": status,
                 "ms": int((time.monotonic() - started) * 1000)},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
    if status == "interrupted":
        raise AskError("Поток оборвался до завершения задачи; у Code-задач возобновления нет.")
    return json.dumps(
        {
            "status": status,
            "answer": "".join(state.parts),
            "steps": steps,
            "usage": state.usage,
            "limits": state.limits,
            "runId": state.run_id,
        },
        ensure_ascii=False,
    )
