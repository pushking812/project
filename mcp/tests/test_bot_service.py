"""Офлайн-проверка управления процессом MCP: подставной Popen."""

import asyncio

import pytest

from ask_mcp.bot.service import McpProcess, ServiceError


class FakeProc:
    def __init__(self, pid=4242, exit_code=None):
        self.pid = pid
        self.returncode = exit_code
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class ReadyWorker:
    """ready становится True после третьей проверки — как настоящее переподключение."""

    def __init__(self, ready=False, becomes_ready=True):
        self._ready = ready
        self._becomes_ready = becomes_ready
        self.checks = 0

    @property
    def ready(self):
        self.checks += 1
        if not self._ready and self._becomes_ready and self.checks >= 3:
            self._ready = True
        return self._ready


def make(spawn, tmp_path, ready_timeout=5.0):
    python = tmp_path / "python.exe"
    script = tmp_path / "server.py"
    python.write_text("")
    script.write_text("")
    return McpProcess(python=python, script=script, spawn=spawn, ready_timeout=ready_timeout, poll=0.01)


def test_start_spawns_server_and_waits_for_connection(tmp_path):
    proc = FakeProc()
    seen = {}

    def spawn(argv, cwd):
        seen["argv"] = argv
        seen["cwd"] = str(cwd)
        return proc

    service = make(spawn, tmp_path)
    text = asyncio.run(service.start(worker=ReadyWorker()))
    assert seen["argv"][-1] == "--http" and "server.py" in seen["argv"][-2]
    assert text.startswith("MCP-сервер запущен") and "4242" in text
    assert service.running and service.pid == 4242


def test_start_twice_spawns_once(tmp_path):
    calls = []
    service = make(lambda argv, cwd: calls.append(argv) or FakeProc(), tmp_path)
    asyncio.run(service.start(worker=ReadyWorker()))
    second = asyncio.run(service.start(worker=ReadyWorker()))
    assert "уже запущен" in second
    assert len(calls) == 1


def test_start_skips_when_server_already_answers(tmp_path):
    calls = []
    service = make(lambda argv, cwd: calls.append(argv) or FakeProc(), tmp_path)
    text = asyncio.run(service.start(worker=ReadyWorker(ready=True)))
    assert "уже отвечает" in text and not calls


def test_start_reports_crash(tmp_path):
    service = make(lambda argv, cwd: FakeProc(exit_code=3), tmp_path)
    with pytest.raises(ServiceError) as e:
        asyncio.run(service.start(worker=ReadyWorker(becomes_ready=False)))
    assert "кодом 3" in str(e.value)


def test_start_requires_venv(tmp_path):
    script = tmp_path / "server.py"
    script.write_text("")
    service = McpProcess(python=tmp_path / "nope.exe", script=script, spawn=lambda argv, cwd: FakeProc())
    with pytest.raises(ServiceError) as e:
        asyncio.run(service.start())
    assert "Python" in str(e.value)


def test_stop_terminates_only_own_process(tmp_path):
    proc = FakeProc()
    service = make(lambda argv, cwd: proc, tmp_path)
    asyncio.run(service.start(worker=ReadyWorker()))
    text = asyncio.run(service.stop())
    assert proc.terminated and not proc.killed
    assert "остановлен" in text and not service.running


def test_stop_does_not_touch_foreign_process(tmp_path):
    service = make(lambda argv, cwd: FakeProc(), tmp_path)
    text = asyncio.run(service.stop())
    assert "не ботом" in text and "stop_servers.ps1" in text


def test_status_lines(tmp_path):
    service = make(lambda argv, cwd: FakeProc(), tmp_path)
    assert "не запущен" in service.status(worker=ReadyWorker(becomes_ready=False))
    assert "не ботом" in service.status(worker=ReadyWorker(ready=True))
