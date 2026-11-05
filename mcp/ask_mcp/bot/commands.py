"""Команды бота: разбор текста, вызовы инструментов MCP, подтверждения.

Telegram здесь нет: сервис возвращает Reply, а app.py отправляет его. Поэтому вся логика
(включая опрос фоновой задачи) проверяется офлайн, без сети и без токена.
"""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from difflib import get_close_matches

from . import format as fmt
from .log import error as log_error
from .mcp_client import McpError, McpNotConnected, ToolResult

HELP = """MCP-бот: управление локальным MCP-сервером Ask.

Задачи
/exec <задача> — выполнить и дождаться (режим из /mode)
/plan <задача> — то же в режиме plan
/task <id> — состояние, /tasks — последние, /stop <id> — остановить
/ask <вопрос> — вопрос модели без действий
Текст без «/» считается вопросом (/ask) и ничего не меняет: для действий нужен /exec.

Команды в папке
/run <команда> — выполнить команду (режим all или edits, с подтверждением)
/run <секунды> <команда> — свой таймаут, до 600 с
Команда с «&» в конце запускает приложение: смотреть /apps, остановить /apps stop <номер>.

Сервер
/status — связь с MCP, сервер, папка, сессия
/mode [plan|edits|all] — режим задач
/ws — рабочая папка, /cd <путь> — сменить
/health, /me, /doctor, /context — диагностика
/svc [start|stop|restart|status] — процесс MCP-сервера

Инструменты
/tools [фильтр] — список, /tool <имя> — описание
/call <имя> {json} — вызвать любой инструмент

Файлы и сессии
/ls [путь], /cat <файл>, /find <текст>
/sessions, /new [заголовок], /use <id>, /session
/notes, /remember <текст>

Браузер
/browser — состояние; open <url>, shot, read, close, handoff

Запись файлов, команды, очистка памяти, остановка приложений и смена папки
требуют подтверждения и TELEGRAM_ALLOW_DANGEROUS=1."""

MODES = ("all", "edits", "plan")
CONFIRM_TTL = 60.0

# Инструменты, которые меняют файлы, память, процессы или папку.
DANGEROUS = {
    "write_file", "edit_file", "run_command",
    "remember", "write_memory", "clear_memory",
    "write_excel", "edit_word", "write_vba", "edit_vba", "run_vba",
    "set_workspace", "export_session",
    "stop_app", "stop_all_apps", "remove_watch", "remove_all_watches",
}

# Сколько ждать ответ инструмента (секунды). Долгие задачи идут через start_task.
TIMEOUTS = {"ask": 600.0, "execute": 600.0, "compact": 600.0, "run_command": 360.0,
            "browser_handoff": 600.0, "browser_open": 600.0, "analyze": 600.0}


@dataclass
class Reply:
    """Ответ бота: текст, кнопки подтверждения, картинки и файлы."""

    text: str = ""
    keyboard: list[list[tuple[str, str]]] | None = None
    images: list[tuple[bytes, str]] = field(default_factory=list)  # (данные, mime)
    documents: list[tuple[bytes, str, str]] = field(default_factory=list)  # (данные, имя, подпись)


@dataclass
class Pending:
    """Действие, ждущее подтверждения кнопкой."""

    token: str
    kind: str  # "tool" | "svc"
    name: str
    args: dict
    label: str
    created: float


@dataclass
class ChatState:
    mode: str
    session_id: str | None = None
    last_task: str | None = None
    tasks: list[str] = field(default_factory=list)
    pending: Pending | None = None


# Глаголы, по которым видно: человек просит действие, а не задаёт вопрос.
ACTION_WORDS = (
    "создай", "создать", "запиши", "записать", "измени", "изменить", "исправь", "правь",
    "удали", "удалить", "запусти", "запустить", "выполни", "выполнить", "сделай", "сделать",
    "добавь", "добавить", "переименуй", "скопируй", "перемести", "установи", "обнови",
    "create", "write", "delete", "remove", "edit", "run", "execute", "make", "add", "update",
)


def looks_like_action(text: str) -> bool:
    """Похоже ли сообщение на просьбу что-то сделать в папке (а не на вопрос)."""
    low = (text or "").casefold()
    return any(word in low for word in ACTION_WORDS)


def parse_command(text: str) -> tuple[str, str] | None:
    """`/exec@my_bot задача` -> ("exec", "задача"). Не команда -> None."""
    text = (text or "").strip()
    if not text.startswith("/"):
        return None
    head, _, rest = text.partition(" ")
    name = head[1:].split("@", 1)[0].lower()
    if not name:
        return None
    return name, rest.strip()


class BotService:
    """Логика команд поверх MCP-клиента. notifier — то, чем править сообщение с прогрессом."""

    def __init__(
        self,
        worker,
        cfg,
        notifier=None,
        service=None,
        *,
        sleep=asyncio.sleep,
        clock=time.monotonic,
        now=time.time,
    ):
        self.worker = worker
        self.cfg = cfg
        self.notifier = notifier
        self.service = service
        self._sleep = sleep
        self._clock = clock
        self._now = now
        self._states: dict[int, ChatState] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._auto_checked = False
        self._auto_session: str | None = None
        self._handlers = {
            "start": self._cmd_help, "help": self._cmd_help,
            "status": self._cmd_status, "health": self._cmd_health, "me": self._cmd_me,
            "tools": self._cmd_tools, "tool": self._cmd_tool, "call": self._cmd_call,
            "ask": self._cmd_ask, "mode": self._cmd_mode,
            "run": self._cmd_run, "cmd": self._cmd_run,
            "exec": self._cmd_exec, "plan": self._cmd_plan,
            "task": self._cmd_task, "tasks": self._cmd_tasks, "stop": self._cmd_stop,
            "ws": self._cmd_ws, "cd": self._cmd_cd,
            "ls": self._cmd_ls, "cat": self._cmd_cat, "find": self._cmd_find,
            "sessions": self._cmd_sessions, "new": self._cmd_new, "use": self._cmd_use,
            "session": self._cmd_session,
            "models": self._cmd_models, "model": self._cmd_model,
            "doctor": self._cmd_doctor, "context": self._cmd_context, "compact": self._cmd_compact,
            "browser": self._cmd_browser, "notes": self._cmd_notes, "remember": self._cmd_remember,
            "apps": self._cmd_apps, "watches": self._cmd_watches, "watch": self._cmd_watch,
            "svc": self._cmd_svc,
        }

    # --- общее ---------------------------------------------------------------------------------

    def _state(self, chat_id: int) -> ChatState:
        state = self._states.get(chat_id)
        if state is None:
            state = ChatState(mode=self.cfg.default_mode)
            self._states[chat_id] = state
        return state

    async def handle(self, chat_id: int, text: str) -> Reply:
        """Текст из чата -> ответ. Не команда считается вопросом модели."""
        parsed = parse_command(text)
        if parsed is None:
            question = (text or "").strip()
            if not question:
                return Reply("Напишите вопрос или /help.")
            return await self._safe(self._cmd_ask, chat_id, question)
        name, rest = parsed
        handler = self._handlers.get(name)
        if handler is None:
            return Reply(f"Неизвестная команда /{name}. Список: /help")
        return await self._safe(handler, chat_id, rest)

    async def _safe(self, handler, chat_id: int, arg) -> Reply:
        try:
            return await handler(chat_id, arg)
        except McpNotConnected as e:
            return Reply(str(e))
        except McpError as e:
            return Reply(f"Ошибка: {e}")
        except Exception as e:  # noqa: BLE001 — бот не должен падать от одного запроса
            log_error("bot", f"{handler.__name__}: {type(e).__name__}: {e}")
            return Reply(f"Внутренняя ошибка бота: {type(e).__name__}: {e}")

    async def _tool(self, name: str, args: dict | None = None, timeout: float | None = None) -> ToolResult:
        return await self.worker.call(name, args or {}, timeout=timeout or TIMEOUTS.get(name, 120.0))

    async def _data(self, name: str, args: dict | None = None, timeout: float | None = None) -> dict:
        """То же, но ошибку инструмента превращает в McpError с текстом сервера."""
        res = await self._tool(name, args, timeout)
        data = fmt.payload(res.text)
        if res.is_error:
            raise McpError(fmt.text_of(data) or res.text or f"{name}: ошибка")
        return data

    def _result(self, res: ToolResult) -> Reply:
        images = [(img.data, img.mime) for img in res.images]
        if res.is_error:
            message = fmt.text_of(fmt.payload(res.text)) or res.text or "ошибка"
            return Reply(f"Ошибка: {fmt.clip(message, self.cfg.max_message)}", images=images)
        text = fmt.pretty(res.text, self.cfg.max_message) if res.text.strip() else ""
        return Reply(text or "(пусто)", images=images)

    def _command_reply(self, res: ToolResult) -> Reply:
        """Ответ /run: код возврата, вывод и фоновое приложение (если команда с «&»)."""
        data = fmt.payload(res.text)
        output = str(data.get("output") or data.get("shown") or "").strip()
        code = data.get("code")
        head = "Команда выполнена" + (f", код {code}" if code is not None else "")
        if data.get("app"):
            head += f"\nПриложение запущено в фоне: #{data['app']}"
            if data.get("url"):
                head += f" {data['url']}"
            head += "\nСписок: /apps, остановить: /apps stop <номер>"
        text = f"{head}\n\n{output}" if output else head
        return self._answer_reply(text, "command.txt")

    async def _notify(self, chat_id: int, text: str) -> int | None:
        if self.notifier is None:
            return None
        try:
            return await self.notifier.send(chat_id, text)
        except Exception as e:  # noqa: BLE001 — прогресс не должен ломать задачу
            log_error("bot", f"не удалось отправить прогресс: {type(e).__name__}: {e}")
            return None

    async def _edit(self, chat_id: int, message_id: int, text: str) -> None:
        if self.notifier is None:
            return
        try:
            await self.notifier.edit(chat_id, message_id, fmt.split_text(text, self.cfg.max_message)[0])
        except Exception as e:  # noqa: BLE001
            log_error("bot", f"не удалось обновить прогресс: {type(e).__name__}: {e}")

    def _confirm(self, chat_id: int, kind: str, name: str, args: dict, label: str) -> Reply:
        token = uuid.uuid4().hex[:8]
        self._state(chat_id).pending = Pending(token, kind, name, args, label, self._now())
        return Reply(
            f"{label}\nПодтвердите действие:",
            keyboard=[[("Да, выполнить", f"cf:{token}:yes"), ("Отмена", f"cf:{token}:no")]],
        )

    async def handle_callback(self, chat_id: int, data: str) -> Reply | None:
        """Нажатие кнопки. Возвращает ответ или None, если это не наша кнопка."""
        if not (data or "").startswith("cf:"):
            return None
        try:
            _, token, action = data.split(":", 2)
        except ValueError:
            return None
        state = self._state(chat_id)
        pending, state.pending = state.pending, None
        if pending is None or pending.token != token:
            return Reply("Кнопка устарела или уже использована. Повторите команду.")
        if self._now() - pending.created > CONFIRM_TTL:
            return Reply(f"Подтверждение истекло ({int(CONFIRM_TTL)} c). Повторите команду.")
        if action != "yes":
            return Reply("Отменено.")
        return await self._safe(self._run_pending, chat_id, pending)

    async def _run_pending(self, chat_id: int, pending: Pending) -> Reply:
        if pending.kind == "svc":
            return await self._svc_action(pending.name)
        if pending.name in DANGEROUS and not self.cfg.dangerous:
            return Reply(f"{pending.name} в боте запрещён (TELEGRAM_ALLOW_DANGEROUS=1, чтобы разрешить).")
        timeout = None
        if pending.name == "run_command":
            # команда ждёт свой таймаут на сервере: не обрываем её раньше
            timeout = min(float(pending.args.get("timeout_sec") or 120) + 45.0, 700.0)
        res = await self._tool(pending.name, pending.args, timeout)
        if pending.name == "run_command" and not res.is_error:
            return self._command_reply(res)
        return self._result(res)

    # --- справка и состояние -------------------------------------------------------------------

    async def _cmd_help(self, chat_id: int, arg: str = "") -> Reply:
        return Reply(HELP)

    async def _cmd_status(self, chat_id: int, arg: str = "") -> Reply:
        describe = getattr(self.worker, "describe", None)
        mcp = describe() if callable(describe) else ("подключён" if getattr(self.worker, "ready", False) else "нет соединения")
        state = self._state(chat_id)
        lines = [f"MCP: {mcp}", f"Режим бота: {state.mode}"]
        try:
            health = await self._data("health")
        except McpError as e:
            return Reply("\n".join(lines + ["", f"Сервер: {e}"]))
        lines.append(
            f"Сервер: версия {health.get('version', '?')}, "
            f"задач {health.get('running', '?')}/{health.get('maxParallel', '?')}"
        )
        lines.append(f"Ключ ask: {'есть' if health.get('keyPresent') else 'нет'}")
        lines.append(f"Папка: {health.get('root') or '?'}")
        try:
            ws = await self._data("get_workspace")
            roots = ws.get("allowedRoots") or []
            lines.append(f"Можно перейти: {', '.join(map(str, roots)) if roots else '—'}")
        except McpError:
            pass
        try:
            status = await self._data("get_status")
            for label, key in (("Аккаунт", "account"), ("Тариф", "plan"), ("Модель", "model"), ("Режим сервера", "mode")):
                value = status.get(key)
                if value not in (None, "", [], {}):
                    lines.append(f"{label}: {_value(value)}")
        except McpError:
            pass
        sid = state.session_id or self._auto_session
        if sid:
            lines.append(f"Сессия: {sid}")
        lines.append("Подробнее: /health, /doctor, /tools")
        return Reply("\n".join(lines))

    async def _cmd_health(self, chat_id: int, arg: str = "") -> Reply:
        return self._result(await self._tool("health"))

    async def _cmd_me(self, chat_id: int, arg: str = "") -> Reply:
        return self._result(await self._tool("me"))

    # --- инструменты ---------------------------------------------------------------------------

    async def _cmd_tools(self, chat_id: int, arg: str = "") -> Reply:
        tools = await self.worker.list_tools()
        flt = (arg or "").strip().lower()
        items = [t for t in tools if not flt or flt in t.name.lower() or flt in (t.description or "").lower()]
        items.sort(key=lambda t: t.name)
        if not items:
            return Reply(f"Инструментов с «{arg}» нет. /tools — все.")
        lines = [f"Инструменты MCP: {len(items)}" + (", показаны первые 40" if len(items) > 40 else "")]
        for tool in items[:40]:
            first = (tool.description or "").strip().splitlines()[0] if (tool.description or "").strip() else ""
            if first:
                first = first[:90] + ("…" if len(first) > 90 else "")
                lines.append(f"{tool.name} — {first}")
            else:
                lines.append(tool.name)
        lines += ["", "Описание: /tool <имя>. Вызов: /call <имя> {json}"]
        return Reply("\n".join(lines))

    async def _cmd_tool(self, chat_id: int, arg: str = "") -> Reply:
        name = (arg or "").strip()
        tools = await self.worker.list_tools()
        names = [t.name for t in tools]
        if not name:
            return Reply("Формат: /tool <имя>. Список: /tools")
        tool = next((t for t in tools if t.name == name), None)
        if tool is None:
            close = get_close_matches(name, names, n=5)
            return Reply(f"Нет инструмента {name}." + (f" Похожие: {', '.join(close)}" if close else " Список: /tools"))
        schema = tool.schema or {}
        props = schema.get("properties") or {}
        required = set(schema.get("required") or [])
        lines = [tool.name, (tool.description or "").strip(), ""]
        if props:
            lines.append("Параметры:")
            for pname, spec in props.items():
                spec = spec if isinstance(spec, dict) else {}
                mark = "*" if pname in required else "-"
                kind = spec.get("type") or "?"
                desc = str(spec.get("description") or "")[:120]
                lines.append(f" {mark} {pname}: {kind} — {desc}" if desc else f" {mark} {pname}: {kind}")
        else:
            lines.append("Параметров нет.")
        lines += ["", f"Вызов: /call {tool.name} {{...}}"]
        return Reply("\n".join(lines))

    async def _cmd_call(self, chat_id: int, arg: str = "") -> Reply:
        parts = (arg or "").split(maxsplit=1)
        if not parts or not parts[0].strip():
            return Reply("Формат: /call <инструмент> {json}. Список: /tools")
        name = parts[0].strip()
        raw = parts[1].strip() if len(parts) > 1 else "{}"
        try:
            args = json.loads(raw or "{}")
        except ValueError as e:
            return Reply(f"Аргументы должны быть JSON-объектом: {e}")
        if not isinstance(args, dict):
            return Reply("Аргументы должны быть JSON-объектом {...}.")
        names = [t.name for t in await self.worker.list_tools()]
        if name not in names:
            close = get_close_matches(name, names, n=5)
            return Reply(f"Нет инструмента {name}." + (f" Похожие: {', '.join(close)}" if close else " Список: /tools"))
        if name in DANGEROUS:
            if not self.cfg.dangerous:
                return Reply(
                    f"{name} меняет файлы, память или процессы и в боте запрещён. "
                    "Включите TELEGRAM_ALLOW_DANGEROUS=1, если это осознанно."
                )
            label = f"Вызвать {name} с аргументами {fmt.clip(json.dumps(args, ensure_ascii=False), 300)}"
            return self._confirm(chat_id, "tool", name, args, label)
        return self._result(await self._tool(name, args))

    # --- вопрос и режим ------------------------------------------------------------------------

    async def _cmd_ask(self, chat_id: int, arg: str = "") -> Reply:
        prompt = (arg or "").strip()
        if not prompt:
            return Reply("Спросите так: /ask что такое MCP?")
        res = await self._tool("ask", {"prompt": prompt}, timeout=self.cfg.ask_timeout)
        data = fmt.payload(res.text)
        if res.is_error:
            return Reply(f"Ошибка: {fmt.text_of(data) or res.text}")
        answer = fmt.text_of(data) or "(пустой ответ)"
        usage = fmt.usage_line(data.get("usage"))
        text = f"{answer}\n\n{usage}" if usage else answer
        if looks_like_action(prompt):
            # /ask ничего не меняет: без подсказки человек думает, что задача выполнена
            text += (
                "\n\nℹ️ /ask только спрашивает и ничего не меняет в папке. "
                "Чтобы бот это выполнил: /mode edits (или /mode all) и /exec <та же задача>."
            )
        return self._answer_reply(text, "ask.txt")

    async def _cmd_run(self, chat_id: int, arg: str = "") -> Reply:
        """`/run [секунды] <команда>`: прямой вызов run_command, без модели."""
        raw = (arg or "").strip()
        if not raw:
            return Reply(
                "Формат: /run <команда>, например /run npm test\n"
                "Свой таймаут: /run 300 npm test (до 600 с)\n"
                "Нужен режим all или edits: /mode all"
            )
        timeout_sec = None
        parts = raw.split(maxsplit=1)
        if len(parts) == 2 and parts[0].isdigit():
            timeout_sec, raw = min(int(parts[0]), 600), parts[1].strip()
            if not raw:
                return Reply("После таймаута нужна команда: /run 300 npm test")
        state = self._state(chat_id)
        if state.mode == "plan":
            return Reply(
                "Режим plan: команды запрещены. Смените режим: /mode all (или /mode edits) и повторите."
            )
        refusal = self._danger_refusal("run_command")
        if refusal:
            return refusal
        args: dict = {"command": raw, "mode": state.mode}
        if timeout_sec:
            args["timeout_sec"] = timeout_sec
        label = f"Выполнить команду ({timeout_sec} с): {fmt.clip(raw, 300)}" if timeout_sec \
            else f"Выполнить команду: {fmt.clip(raw, 300)}"
        return self._confirm(chat_id, "tool", "run_command", args, label)

    async def _cmd_mode(self, chat_id: int, arg: str = "") -> Reply:
        state = self._state(chat_id)
        value = (arg or "").strip().lower()
        if not value:
            return Reply(f"Режим задач: {state.mode}. Сменить: /mode plan|edits|all")
        if value not in MODES:
            return Reply(f"Допустимо: {', '.join(MODES)}. Сейчас: {state.mode}")
        state.mode = value
        return Reply(f"Режим задач: {value}. Действует на /exec, /plan и /browser.")

    def _answer_reply(self, text: str, filename: str) -> Reply:
        """Длинный ответ — файлом, иначе сообщением (его разобьёт app.py)."""
        if len(text) > self.cfg.max_message * 3:
            return Reply(
                "Ответ длинный — отправляю файлом.",
                documents=[(text.encode("utf-8"), filename, text[:200])],
            )
        return Reply(text)

    # --- задачи: start_task + опрос статуса -----------------------------------------------------

    async def _cmd_exec(self, chat_id: int, arg: str = "") -> Reply:
        return await self._task_locked(chat_id, arg, self._state(chat_id).mode)

    async def _cmd_plan(self, chat_id: int, arg: str = "") -> Reply:
        return await self._task_locked(chat_id, arg, "plan")

    async def _task_locked(self, chat_id: int, arg: str, mode: str) -> Reply:
        prompt = (arg or "").strip()
        if not prompt:
            return Reply("Напишите задачу: /exec исправь падающий тест\nРежим меняет /mode.")
        lock = self._locks.setdefault(chat_id, asyncio.Lock())
        if lock.locked():
            last = self._state(chat_id).last_task
            return Reply(f"Уже идёт задача {last}. Дождитесь конца: /task {last} или /stop {last}.")
        async with lock:
            return await self._run_task(chat_id, prompt, mode)

    async def _mcp_session(self) -> str | None:
        """Автосессия MCP-сервера, чтобы /exec видел историю между вызовами."""
        if self._auto_checked:
            return self._auto_session
        self._auto_checked = True
        try:
            data = await self._data("session_info", {}, timeout=30.0)
        except McpError:
            return None
        sid = data.get("session_id")
        self._auto_session = sid if isinstance(sid, str) and sid else None
        return self._auto_session

    async def _run_task(self, chat_id: int, prompt: str, mode: str) -> Reply:
        state = self._state(chat_id)
        args: dict = {"prompt": prompt, "mode": mode}
        sid = state.session_id or await self._mcp_session()
        if sid:
            args["session_id"] = sid
        try:
            started = await self._data("start_task", args, timeout=60.0)
        except McpError as e:
            if sid and "session_busy" in str(e):
                args.pop("session_id", None)  # сессию занял другой клиент: задача идёт без истории
                started = await self._data("start_task", args, timeout=60.0)
            else:
                raise
        task_id = str(started.get("taskId") or "").strip()
        if not task_id:
            return Reply("Сервер не вернул taskId:\n" + fmt.pretty(json.dumps(started, ensure_ascii=False), self.cfg.max_message))
        state.last_task = task_id
        if task_id not in state.tasks:
            state.tasks.append(task_id)
            del state.tasks[:-10]

        message_id = await self._notify(chat_id, f"Задача {task_id} запущена (режим {mode}).")
        started_at = self._clock()
        deadline = started_at + self.cfg.task_timeout
        last_edit = started_at
        status: dict = {}
        while self._clock() < deadline:
            await self._sleep(self.cfg.poll_interval)
            status = await self._data("task_status", {"task_id": task_id}, timeout=60.0)
            if status.get("status") != "running":
                break
            now = self._clock()
            if message_id is not None and now - last_edit >= 10.0:
                last_edit = now
                steps = len(status.get("steps") or [])
                await self._edit(
                    chat_id,
                    message_id,
                    f"Задача {task_id} идёт: {fmt.seconds(now - started_at)}, шагов {steps}.\n"
                    f"Остановить: /stop {task_id}",
                )
        else:
            return Reply(
                f"Задача {task_id} идёт дольше {fmt.seconds(self.cfg.task_timeout)}.\n"
                f"Смотреть: /task {task_id}, остановить: /stop {task_id}."
            )
        card = self._task_card(task_id, status)
        if mode == "plan":
            card += (
                "\n\nℹ️ Режим plan: изменения в папке не применялись. "
                "Разрешить правки: /mode edits, затем повторите задачу."
            )
        if message_id is not None:
            await self._edit(chat_id, message_id, fmt.split_text(card, self.cfg.max_message)[0])
        return Reply(card)

    def _task_card(self, task_id: str, data: dict) -> str:
        status = str(data.get("status") or "?")
        lines = [f"Задача {task_id}: {status}"]
        answer = str(data.get("answer") or "").strip()
        if answer:
            lines += ["", answer]
        elif status == "done":
            lines += ["", "(ответ пустой)"]
        files = fmt.files_line(data.get("outputFiles"))
        if files:
            lines += ["", files]
        usage = fmt.usage_line(data.get("usage"))
        if usage:
            lines.append(usage)
        err = data.get("error")
        if err:
            lines += ["", f"Ошибка: {err}"]
        return "\n".join(lines)

    async def _cmd_task(self, chat_id: int, arg: str = "") -> Reply:
        task_id = (arg or "").strip()
        if not task_id:
            return Reply("Формат: /task <id>. Последние задачи: /tasks")
        data = await self._data("task_status", {"task_id": task_id}, timeout=60.0)
        return Reply(self._task_card(task_id, data))

    async def _cmd_tasks(self, chat_id: int, arg: str = "") -> Reply:
        ids = list(reversed(self._state(chat_id).tasks))[:5]
        if not ids:
            return Reply("В этой сессии бота задач не было. Запустить: /exec <задача>")
        lines = ["Последние задачи:"]
        for task_id in ids:
            try:
                data = await self._data("task_status", {"task_id": task_id}, timeout=30.0)
                mark = data.get("status", "?")
            except McpError:
                mark = "нет данных"
            lines.append(f"{task_id}: {mark}")
        lines.append("Подробно: /task <id>")
        return Reply("\n".join(lines))

    async def _cmd_stop(self, chat_id: int, arg: str = "") -> Reply:
        task_id = (arg or "").strip() or self._state(chat_id).last_task
        if not task_id:
            return Reply("Нечего останавливать. id берётся из /exec или указывается: /stop <id>")
        data = await self._data("stop_task", {"task_id": task_id}, timeout=60.0)
        return Reply(f"Задача {task_id}: {data.get('status') or 'остановлена'}")

    # --- папка и файлы -------------------------------------------------------------------------

    def _danger_refusal(self, name: str) -> Reply | None:
        if name in DANGEROUS and not self.cfg.dangerous:
            return Reply(
                f"{name} меняет файлы, память или процессы и в боте запрещён. "
                "Включите TELEGRAM_ALLOW_DANGEROUS=1, если это осознанно."
            )
        return None

    async def _cmd_ws(self, chat_id: int, arg: str = "") -> Reply:
        data = await self._data("get_workspace")
        lines = [f"Папка: {data.get('root') or '?'}"]
        roots = data.get("allowedRoots") or []
        if roots:
            lines.append("Можно перейти: " + ", ".join(map(str, roots)))
        if data.get("sessionId"):
            lines.append(f"Сессия папки: {data['sessionId']}")
        lines.append("Сменить: /cd <путь>")
        return Reply("\n".join(lines))

    async def _cmd_cd(self, chat_id: int, arg: str = "") -> Reply:
        path = (arg or "").strip()
        if not path:
            return Reply("Формат: /cd <путь>. Текущая папка: /ws")
        refusal = self._danger_refusal("set_workspace")
        if refusal:
            return refusal
        return self._confirm(chat_id, "tool", "set_workspace", {"path": path}, f"Сменить рабочую папку на {path}?")

    async def _cmd_ls(self, chat_id: int, arg: str = "") -> Reply:
        path = (arg or "").strip()
        return self._result(await self._tool("list_files", {"path": path} if path else {}))

    async def _cmd_cat(self, chat_id: int, arg: str = "") -> Reply:
        path = (arg or "").strip()
        if not path:
            return Reply("Формат: /cat <файл>. Смещение и лимит строк — через /call read_file {\"path\": ..., \"offset\": ...}")
        res = await self._tool("read_file", {"path": path})
        if res.is_error:
            return self._result(res)
        data = fmt.payload(res.text)
        return self._answer_reply(fmt.text_of(data) or fmt.pretty(res.text), "file.txt")

    async def _cmd_find(self, chat_id: int, arg: str = "") -> Reply:
        pattern = (arg or "").strip()
        if not pattern:
            return Reply("Формат: /find <текст или регулярное выражение>")
        return self._result(await self._tool("search", {"pattern": pattern}))

    # --- сессии --------------------------------------------------------------------------------

    async def _cmd_sessions(self, chat_id: int, arg: str = "") -> Reply:
        data = await self._data("list_sessions")
        items = data.get("sessions")
        if not isinstance(items, list) or not items:
            return Reply("Сессий нет.\n" + fmt.pretty(json.dumps(data, ensure_ascii=False), 1200))
        lines = ["Сессии (новые первыми):"]
        for item in items[:15]:
            if not isinstance(item, dict):
                continue
            mark = "*" if item.get("current") else "-"
            lines.append(
                f"{mark} {item.get('id')}: {item.get('title') or 'без названия'} — "
                f"запросов {item.get('requests', 0)}"
            )
        lines.append("Продолжить: /use <id>. Новая: /new [заголовок]")
        return Reply("\n".join(lines))

    async def _cmd_new(self, chat_id: int, arg: str = "") -> Reply:
        title = (arg or "").strip()
        data = await self._data("new_session", {"title": title} if title else {})
        sid = data.get("session_id") or data.get("id")
        if isinstance(sid, str) and sid:
            self._state(chat_id).session_id = sid
        return Reply(f"Новая сессия: {sid or '?'}. /exec будет её продолжать.")

    async def _cmd_use(self, chat_id: int, arg: str = "") -> Reply:
        sid = (arg or "").strip()
        if not sid:
            return Reply("Формат: /use <id>. Список: /sessions")
        data = await self._data("resume_session", {"id": sid})
        new_id = data.get("session_id") or sid
        self._state(chat_id).session_id = new_id
        return Reply(f"Текущая сессия: {new_id} (запросов {data.get('requests', '?')}).")

    async def _cmd_session(self, chat_id: int, arg: str = "") -> Reply:
        data = await self._data("session_info")
        lines = [f"Автосессия MCP: {data.get('session_id') or 'нет'}"]
        if data.get("auto") is False:
            lines.append("Автосессия выключена (ASK_SESSION_AUTO=false).")
        for key in ("title", "requests", "savedAt"):
            if data.get(key) is not None:
                lines.append(f"{key}: {_value(data[key])}")
        own = self._state(chat_id).session_id
        if own:
            lines.append(f"Выбранная в боте: {own}")
        return Reply("\n".join(lines))

    # --- модель и диагностика ------------------------------------------------------------------

    async def _cmd_models(self, chat_id: int, arg: str = "") -> Reply:
        res = await self._tool("list_models")
        if res.is_error:
            return self._result(res)
        data = fmt.payload(res.text)
        models = data.get("models")
        current = data.get("current") or data.get("model")
        if not isinstance(models, list) or not models:
            return self._result(res)
        lines = ["Модели:"] + [f"{'*' if m == current else '-'} {_value(m)}" for m in models[:30]]
        if current:
            lines.append(f"Сейчас: {_value(current)}")
        lines.append("Выбрать: /model <имя>")
        return Reply("\n".join(lines))

    async def _cmd_model(self, chat_id: int, arg: str = "") -> Reply:
        name = (arg or "").strip()
        if not name:
            return await self._cmd_models(chat_id)
        return self._result(await self._tool("set_model", {"name": name}))

    async def _cmd_doctor(self, chat_id: int, arg: str = "") -> Reply:
        return self._result(await self._tool("doctor"))

    async def _cmd_context(self, chat_id: int, arg: str = "") -> Reply:
        return self._result(await self._tool("get_context"))

    async def _cmd_compact(self, chat_id: int, arg: str = "") -> Reply:
        focus = (arg or "").strip()
        res = await self._tool("compact", {"focus": focus} if focus else {})
        data = fmt.payload(res.text)
        if res.is_error:
            return Reply(f"Ошибка: {fmt.text_of(data) or res.text}")
        summary = data.get("summary") or fmt.text_of(data) or "(пусто)"
        requests = data.get("requests")
        head = f"История сжата (запросов {requests}).\n\n" if requests is not None else "История сжата.\n\n"
        return self._answer_reply(head + summary, "summary.txt")

    async def _cmd_notes(self, chat_id: int, arg: str = "") -> Reply:
        return self._result(await self._tool("get_notes"))

    async def _cmd_remember(self, chat_id: int, arg: str = "") -> Reply:
        note = (arg or "").strip()
        if not note:
            return Reply("Формат: /remember <заметка>")
        refusal = self._danger_refusal("remember")
        if refusal:
            return refusal
        return self._confirm(chat_id, "tool", "remember", {"note": note}, f"Дописать в ASK.md: {fmt.clip(note, 200)}")

    # --- браузер, приложения, наблюдения -------------------------------------------------------

    async def _cmd_browser(self, chat_id: int, arg: str = "") -> Reply:
        parts = (arg or "").strip().split(maxsplit=1)
        sub = parts[0].lower() if parts and parts[0] else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        if sub in ("", "state"):
            return self._result(await self._tool("browser_state"))
        if sub in ("shot", "screenshot"):
            return self._result(await self._tool("browser_screenshot"))
        if sub == "read":
            return self._result(await self._tool("browser_read"))
        if sub == "close":
            return self._result(await self._tool("browser_close"))
        if sub == "open":
            if not rest:
                return Reply("Формат: /browser open <адрес>")
            mode = self._state(chat_id).mode
            return self._result(await self._tool("browser_open", {"url": rest, "mode": mode}))
        if sub == "handoff":
            return self._result(await self._tool("browser_handoff", {"text": rest or None, "headless": False}))
        if sub == "done":
            return self._result(await self._tool("browser_handoff_done", {"note": rest or None}))
        return Reply("Подкоманды: (пусто), open <url>, read, shot, close, handoff [текст], done [заметка]")

    async def _cmd_apps(self, chat_id: int, arg: str = "") -> Reply:
        parts = (arg or "").strip().split(maxsplit=1)
        sub = parts[0].lower() if parts and parts[0] else ""
        if not sub:
            return self._result(await self._tool("list_apps"))
        if sub == "stop":
            target = parts[1].strip() if len(parts) > 1 else ""
            if target in ("", "all", "все"):
                refusal = self._danger_refusal("stop_all_apps")
                if refusal:
                    return refusal
                return self._confirm(chat_id, "tool", "stop_all_apps", {}, "Остановить все приложения?")
            if not target.isdigit():
                return Reply("Формат: /apps stop <номер> или /apps stop all")
            refusal = self._danger_refusal("stop_app")
            if refusal:
                return refusal
            return self._confirm(chat_id, "tool", "stop_app", {"n": int(target)}, f"Остановить приложение {target}?")
        return Reply("Подкоманды: /apps, /apps stop <номер>, /apps stop all")

    async def _cmd_watches(self, chat_id: int, arg: str = "") -> Reply:
        return self._result(await self._tool("list_watches"))

    async def _cmd_watch(self, chat_id: int, arg: str = "") -> Reply:
        parts = (arg or "").strip().split(maxsplit=1)
        sub = parts[0].lower() if parts and parts[0] else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        if sub in ("", "list"):
            return self._result(await self._tool("list_watches"))
        if sub == "add":
            if not rest:
                return Reply('Формат: /watch add https://example.com every 5m for "слово"')
            mode = self._state(chat_id).mode
            return self._result(await self._tool("add_watch", {"spec": rest, "mode": mode}))
        if sub == "stop":
            if rest in ("", "all", "все"):
                refusal = self._danger_refusal("remove_all_watches")
                if refusal:
                    return refusal
                return self._confirm(chat_id, "tool", "remove_all_watches", {}, "Остановить все наблюдения?")
            refusal = self._danger_refusal("remove_watch")
            if refusal:
                return refusal
            return self._confirm(chat_id, "tool", "remove_watch", {"watch_id": rest}, f"Остановить наблюдение {rest}?")
        return Reply("Подкоманды: /watch, add <spec>, stop <id>, stop all")

    # --- процесс MCP-сервера -------------------------------------------------------------------

    async def _cmd_svc(self, chat_id: int, arg: str = "") -> Reply:
        if self.service is None:
            return Reply("Управление процессом MCP в этом запуске недоступно (service не передан).")
        sub = (arg or "").strip().lower() or "status"
        if sub == "status":
            return Reply(self.service.status(worker=self.worker))
        if sub == "start":
            return await self._svc_action("start")
        if sub in ("stop", "restart"):
            label = "Перезапустить MCP-сервер?" if sub == "restart" else "Остановить MCP-сервер?"
            return self._confirm(chat_id, "svc", sub, {}, label)
        return Reply("Формат: /svc [status|start|stop|restart]")

    async def _svc_action(self, name: str) -> Reply:
        if self.service is None:
            return Reply("Управление процессом MCP в этом запуске недоступно.")
        try:
            if name == "start":
                return Reply(await self.service.start(worker=self.worker))
            if name == "stop":
                return Reply(await self.service.stop())
            if name == "restart":
                stopped = await self.service.stop()
                started = await self.service.start(worker=self.worker)
                return Reply(f"{stopped}\n{started}")
        except Exception as e:  # noqa: BLE001 — ServiceError и ошибки запуска процесса
            return Reply(f"Ошибка: {e}")
        return Reply(f"Неизвестное действие: {name}")


def _value(value) -> str:
    """Значение из JSON сервера в одну строку (словари и списки — компактным JSON)."""
    if isinstance(value, (dict, list)):
        return fmt.clip(json.dumps(value, ensure_ascii=False), 200)
    return str(value)
