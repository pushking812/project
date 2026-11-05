"""Запуск и остановка локального MCP-сервера (server.py --http) по команде из Telegram.

Бот управляет только тем процессом, который запустил сам. Экземпляр, поднятый Cline,
start_servers.ps1 или вручную, не трогается: иначе можно погасить чужую работу.
"""

import asyncio
import subprocess
import sys
from pathlib import Path

from .log import info, warn

MCP_DIR = Path(__file__).resolve().parents[2]  # .../mcp
SERVER = MCP_DIR / "server.py"


class ServiceError(Exception):
    """Понятная ошибка запуска или остановки процесса."""


def default_python() -> Path:
    if sys.platform == "win32":
        return MCP_DIR / ".venv" / "Scripts" / "python.exe"
    return MCP_DIR / ".venv" / "bin" / "python"


def _spawn(args, cwd):
    """Запуск без нового окна (Windows) и без вывода в stdout бота."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    return subprocess.Popen(list(args), cwd=str(cwd), stdout=subprocess.DEVNULL, creationflags=flags)


class McpProcess:
    """Процесс MCP-сервера, запущенный ботом."""

    def __init__(
        self,
        *,
        python: str | Path | None = None,
        script: str | Path | None = None,
        spawn=None,
        ready_timeout: float = 25.0,
        poll: float = 0.5,
    ):
        self._python = Path(python) if python else default_python()
        self._script = Path(script) if script else SERVER
        self._spawn = spawn or _spawn
        self._ready_timeout = ready_timeout
        self._poll = poll
        self._proc = None

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    @property
    def pid(self):
        return self._proc.pid if self._proc is not None else None

    def status(self, worker=None) -> str:
        if self.running:
            return f"MCP-сервер запущен этим ботом (PID {self.pid})."
        if worker is not None and getattr(worker, "ready", False):
            return (
                "MCP-сервер отвечает, но запущен не ботом: /svc stop его не остановит "
                "(для этого stop_servers.ps1)."
            )
        return "MCP-сервер не запущен. Запустить: /svc start"

    async def start(self, worker=None) -> str:
        if self.running:
            return f"MCP-сервер уже запущен (PID {self.pid})."
        if worker is not None and getattr(worker, "ready", False):
            return "MCP-сервер уже отвечает (запущен не ботом): второй экземпляр не нужен."
        if not self._python.exists():
            raise ServiceError(f"не найден Python: {self._python}. Выполните init_app.ps1 в папке проекта.")
        if not self._script.exists():
            raise ServiceError(f"не найден {self._script}")
        self._proc = self._spawn([str(self._python), str(self._script), "--http"], MCP_DIR)
        info("svc", f"MCP запущен ботом, PID {self._proc.pid}")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._ready_timeout
        while loop.time() < deadline:
            code = self._proc.poll()
            if code is not None:
                self._proc = None
                raise ServiceError(f"MCP-сервер завершился с кодом {code}. Смотрите вывод в окне бота.")
            if worker is not None and getattr(worker, "ready", False):
                return f"MCP-сервер запущен (PID {self.pid}) и отвечает."
            await asyncio.sleep(self._poll)
        raise ServiceError(
            f"MCP-сервер не ответил за {self._ready_timeout:.0f} c. Проверьте TELEGRAM_MCP_URL и вкладку MCP."
        )

    async def stop(self) -> str:
        if self._proc is None:
            return "MCP-сервер запущен не ботом (или не запущен): останавливайте его stop_servers.ps1."
        if not self.running:
            self._proc = None
            return "MCP-сервер уже завершился."
        proc, self._proc = self._proc, None
        proc.terminate()
        try:
            await asyncio.to_thread(proc.wait, 5)
        except subprocess.TimeoutExpired:
            warn("svc", "MCP не завершился за 5 c, завершаю принудительно")
            proc.kill()
            await asyncio.to_thread(proc.wait, 5)
        info("svc", "MCP остановлен ботом")
        return "MCP-сервер остановлен."
