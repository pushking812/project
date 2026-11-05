"""Подставные объекты для офлайн-тестов бота: сеть, Telegram и MCP не нужны."""

import asyncio
import json

from ask_mcp.bot.config import load_config
from ask_mcp.bot.mcp_client import ToolInfo, ToolResult

BASE_ENV = {
    "TELEGRAM_BOT_TOKEN": "123456789:AAtest-token",
    "TELEGRAM_ALLOWED_USER_IDS": "1",
    "TELEGRAM_API_URL": "https://api.telegram.org",
    "TELEGRAM_MCP_URL": "http://127.0.0.1:8000/mcp",
    "TELEGRAM_DEFAULT_MODE": "plan",
}


def make_config(**env):
    """BotConfig из значений по умолчанию и переопределений (имена как у переменных среды)."""
    values = dict(BASE_ENV)
    values.update({name: str(value) for name, value in env.items()})
    return load_config(values)


def result(payload, *, images=None, is_error=False) -> ToolResult:
    """ToolResult из словаря (как будто его вернул инструмент MCP)."""
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return ToolResult(text=text, images=images or [], is_error=is_error)


class FakeWorker:
    """MCP-клиент: answers — {имя инструмента: ToolResult, список ответов или функция}."""

    def __init__(self, answers=None, tools=None, *, ready=True, error=None):
        self.answers = answers or {}
        self.tools = tools if tools is not None else default_tools()
        self.ready = ready
        self.error = error
        self.calls: list[tuple[str, dict]] = []

    def describe(self) -> str:
        return "подключён к http://127.0.0.1:8000/mcp" if self.ready else "нет соединения с MCP"

    async def list_tools(self, timeout: float = 15.0):
        if self.error is not None:
            raise self.error
        return self.tools

    async def call(self, name: str, arguments: dict | None = None, timeout: float = 120.0) -> ToolResult:
        self.calls.append((name, arguments or {}))
        if self.error is not None:
            raise self.error
        answer = self.answers.get(name)
        if callable(answer):
            return answer(name, arguments or {})
        if isinstance(answer, list):
            return answer.pop(0) if answer else result({})
        return answer if answer is not None else result({})


def default_tools():
    names = [
        "ask", "execute", "start_task", "task_status", "stop_task", "health", "me", "get_status",
        "get_workspace", "set_workspace", "session_info", "new_session", "resume_session", "list_sessions",
        "read_file", "list_files", "search", "write_file", "remember", "get_notes", "browser_screenshot",
        "browser_open", "doctor", "get_context", "list_models", "set_model", "compact", "list_apps",
        "stop_all_apps", "list_watches",
    ]
    return [ToolInfo(name, f"{name}: тестовый инструмент", {"type": "object", "properties": {}}) for name in names]


class FakeNotifier:
    """Замена TelegramNotifier: запоминает отправленное и правки прогресса."""

    def __init__(self):
        self.sent: list[tuple[int, str]] = []
        self.edits: list[tuple[int, int, str]] = []
        self._message_id = 100

    async def send(self, chat_id: int, text: str, keyboard=None, reply_to=None) -> int:
        self._message_id += 1
        self.sent.append((chat_id, text))
        return self._message_id

    async def edit(self, chat_id: int, message_id: int, text: str) -> None:
        self.edits.append((chat_id, message_id, text))


class FakeClock:
    """Часы и sleep вместе: ожидание двигает время, реально ничего не ждёт."""

    def __init__(self):
        self.t = 0.0

    def monotonic(self) -> float:
        return self.t

    def now(self) -> float:
        return 1_000_000.0 + self.t

    async def sleep(self, seconds: float) -> None:
        self.t += seconds
        await asyncio.sleep(0)
