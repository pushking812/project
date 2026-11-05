"""Офлайн-проверка команд бота: разбор, вызовы инструментов, подтверждения, задачи."""

import asyncio
import json

from ask_mcp.bot import format as fmt
from ask_mcp.bot.commands import HELP, BotService, parse_command
from ask_mcp.bot.mcp_client import McpNotConnected, ToolImage
from bot_fakes import FakeClock, FakeNotifier, FakeWorker, make_config, result


def build(answers=None, *, notifier=None, service=None, **env):
    cfg = make_config(**env)
    clock = FakeClock()
    notifier = notifier if notifier is not None else FakeNotifier()
    worker = FakeWorker(answers)
    bot = BotService(
        worker,
        cfg,
        notifier=notifier,
        service=service,
        sleep=clock.sleep,
        clock=clock.monotonic,
        now=clock.now,
    )
    return bot, worker, notifier, clock, cfg


def ask(bot, text, chat=1):
    return asyncio.run(bot.handle(chat, text))


def token_of(reply):
    """Токен из первой кнопки подтверждения."""
    return reply.keyboard[0][0][1].split(":")[1]


# --- разбор и справка -------------------------------------------------------------------------


def test_parse_command():
    assert parse_command("/exec@my_bot исправь тест") == ("exec", "исправь тест")
    assert parse_command("  /HELP  ") == ("help", "")
    assert parse_command("просто вопрос") is None
    assert parse_command("/") is None
    assert parse_command("") is None


def test_help_lists_core_commands():
    bot, *_ = build()
    reply = ask(bot, "/help")
    assert reply.text == HELP
    for word in ("/exec", "/plan", "/ask", "/stop", "/tools", "/call", "/svc"):
        assert word in reply.text


def test_unknown_command():
    bot, *_ = build()
    assert "Неизвестная команда" in ask(bot, "/nope").text


def test_plain_text_is_a_question():
    bot, worker, notifier, *_ = build({"ask": result({"text": "ответ", "usage": {"input": 1}})})
    reply = ask(bot, "что такое MCP?")
    assert worker.calls == [("ask", {"prompt": "что такое MCP?"})]
    assert "ответ" in reply.text and "usage: input=1" in reply.text
    assert notifier.sent == []  # обычный ответ отправляет app.py, а не сервис


def test_ask_hints_when_prompt_is_an_action():
    bot, *_ = build({"ask": result({"text": "не смог создать файл: инструмент записи недоступен"})})
    reply = ask(bot, "создай файл hello world.txt")
    assert "/exec" in reply.text and "/mode edits" in reply.text


def test_ask_question_has_no_action_hint():
    bot, *_ = build({"ask": result({"text": "MCP — это протокол"})})
    reply = ask(bot, "/ask что такое MCP?")
    assert "ℹ️" not in reply.text


def test_mode_changes_mode_of_this_chat():
    bot, *_ = build()
    assert "plan" in ask(bot, "/mode").text
    assert ask(bot, "/mode edits").text.startswith("Режим задач: edits")
    assert ask(bot, "/mode").text.startswith("Режим задач: edits")
    assert ask(bot, "/mode act").text.startswith("Допустимо")


def test_exec_uses_mode_of_the_chat():
    answers = {"start_task": result({"taskId": "t1"}), "task_status": result({"status": "done", "answer": "ok"})}
    bot, worker, *_ = build(answers)
    ask(bot, "/mode edits")
    ask(bot, "/exec задача")
    assert ("start_task", {"prompt": "задача", "mode": "edits"}) in worker.calls


# --- инструменты и /call ----------------------------------------------------------------------


def test_tools_list_and_filter():
    bot, *_ = build()
    reply = ask(bot, "/tools browser")
    assert "browser_screenshot" in reply.text
    assert "ask —" not in reply.text
    assert "Инструменты MCP: 2" in reply.text


def test_tool_details_and_suggestion():
    bot, *_ = build()
    assert "start_task" in ask(bot, "/tool start_task").text
    reply = ask(bot, "/tool start_tak")
    assert "Похожие" in reply.text and "start_task" in reply.text
    assert "Формат" in ask(bot, "/tool").text


def test_call_runs_tool_and_pretty_prints():
    bot, worker, *_ = build({"health": result({"ok": True, "running": 0})})
    reply = ask(bot, '/call health {}')
    assert worker.calls[-1] == ("health", {})
    assert '"running": 0' in reply.text


def test_call_rejects_bad_json():
    bot, worker, *_ = build()
    reply = ask(bot, "/call health {oops}")
    assert "JSON" in reply.text and not worker.calls
    reply = ask(bot, "/call health [1, 2]")
    assert "JSON-объектом" in reply.text
    assert "Формат" in ask(bot, "/call").text


def test_call_unknown_tool_suggests():
    bot, *_ = build()
    reply = ask(bot, "/call healt {}")
    assert "Нет инструмента" in reply.text and "health" in reply.text


def test_dangerous_tool_refused_by_default():
    bot, worker, *_ = build()
    reply = ask(bot, '/call write_file {"path":"a","content":"b"}')
    assert "запрещён" in reply.text and "TELEGRAM_ALLOW_DANGEROUS" in reply.text
    assert not worker.calls


def test_dangerous_tool_needs_confirmation():
    bot, worker, *_ = build({"write_file": result({"ok": True})}, TELEGRAM_ALLOW_DANGEROUS="1")
    reply = ask(bot, '/call write_file {"path":"a.txt","content":"b"}')
    assert reply.keyboard and reply.keyboard[0][0][0] == "Да, выполнить"
    assert not worker.calls  # до нажатия кнопки ничего не выполнено
    done = asyncio.run(bot.handle_callback(1, f"cf:{token_of(reply)}:yes"))
    assert worker.calls == [("write_file", {"path": "a.txt", "content": "b"})]
    assert done is not None and "ok" in done.text


def test_confirmation_cancel_and_stale_click():
    bot, worker, *_ = build({"write_file": result({"ok": True})}, TELEGRAM_ALLOW_DANGEROUS="1")
    reply = ask(bot, '/call write_file {"path":"a","content":"b"}')
    token = token_of(reply)
    assert asyncio.run(bot.handle_callback(1, f"cf:{token}:no")).text == "Отменено."
    assert not worker.calls
    stale = asyncio.run(bot.handle_callback(1, f"cf:{token}:yes"))
    assert stale is not None and "устарела" in stale.text


def test_foreign_callback_is_ignored():
    bot, *_ = build()
    assert asyncio.run(bot.handle_callback(1, "tools:1:x")) is None
    assert asyncio.run(bot.handle_callback(1, "cf:deadbeef:yes")).text.startswith("Кнопка устарела")


# --- задачи: start_task + опрос ---------------------------------------------------------------


def test_exec_starts_task_and_waits_for_done():
    answers = {
        "session_info": result({"session_id": "s1", "requests": 0}),
        "start_task": result({"taskId": "t1", "status": "running"}),
        "task_status": [
            result({"status": "running", "steps": [{"tool": "read_file"}]}),
            result(
                {
                    "status": "done",
                    "answer": "готово",
                    "steps": [{"tool": "read_file"}, {"tool": "write_file"}],
                    "outputFiles": ["report.md"],
                    "usage": {"output_tokens": 10},
                }
            ),
        ],
    }
    bot, worker, notifier, *_ = build(answers)
    reply = ask(bot, "/exec добавь файл")
    assert ("start_task", {"prompt": "добавь файл", "mode": "plan", "session_id": "s1"}) in worker.calls
    assert "готово" in reply.text and "report.md" in reply.text
    assert notifier.sent and "Задача t1 запущена" in notifier.sent[0][1]
    assert notifier.edits  # итоговая карточка заменила сообщение о запуске


def test_plan_forces_plan_mode():
    answers = {"start_task": result({"taskId": "t1"}), "task_status": result({"status": "done", "answer": "ok"})}
    bot, worker, *_ = build(answers)
    ask(bot, "/mode edits")
    ask(bot, "/plan посмотри проект")
    assert ("start_task", {"prompt": "посмотри проект", "mode": "plan"}) in worker.calls
    assert not any(args.get("mode") == "edits" for name, args in worker.calls if name == "start_task")


def test_exec_reports_long_task():
    answers = {
        "start_task": result({"taskId": "t1"}),
        "task_status": lambda name, args: result({"status": "running", "steps": []}),
    }
    bot, *_ = build(answers, TELEGRAM_TASK_TIMEOUT="10", TELEGRAM_POLL_INTERVAL="2")
    reply = ask(bot, "/exec долго")
    assert "идёт дольше" in reply.text and "/stop t1" in reply.text


def test_plan_task_explains_that_nothing_changed():
    answers = {
        "start_task": result({"taskId": "t1"}),
        "task_status": result({"status": "done", "answer": "план готов"}),
    }
    bot, *_ = build(answers)
    reply = ask(bot, "/plan создай файл hello.txt")
    assert "Режим plan" in reply.text and "/mode edits" in reply.text


def test_exec_retries_without_session_when_busy():
    calls = {"n": 0}

    def start(name, args):
        calls["n"] += 1
        if "session_id" in args:
            return result({"error": "409 session_busy: занята"}, is_error=True)
        return result({"taskId": "t1"})

    answers = {
        "session_info": result({"session_id": "s1"}),
        "start_task": start,
        "task_status": result({"status": "done", "answer": "ok"}),
    }
    bot, worker, *_ = build(answers)
    reply = ask(bot, "/exec задача")
    assert calls["n"] == 2
    assert ("task_status", {"task_id": "t1"}) in worker.calls
    assert "ok" in reply.text


def test_exec_refuses_second_task_in_same_chat():
    bot, *_ = build({"start_task": result({"taskId": "t1"})})
    bot._state(1).last_task = "t0"
    lock = bot._locks.setdefault(1, asyncio.Lock())
    asyncio.run(_acquire_and_ask(bot, lock))


async def _acquire_and_ask(bot, lock):
    await lock.acquire()
    try:
        reply = await bot.handle(1, "/exec вторая")
        assert "Уже идёт задача t0" in reply.text
    finally:
        lock.release()


def test_stop_uses_last_task():
    answers = {
        "start_task": result({"taskId": "t7"}),
        "task_status": result({"status": "done", "answer": "ok"}),
        "stop_task": result({"status": "stopped"}),
    }
    bot, worker, *_ = build(answers)
    ask(bot, "/plan задача")
    reply = ask(bot, "/stop")
    assert worker.calls[-1] == ("stop_task", {"task_id": "t7"})
    assert "stopped" in reply.text
    assert "Нечего останавливать" in ask(bot, "/stop", chat=2).text


def test_tasks_and_task_commands():
    answers = {"start_task": result({"taskId": "t1"}), "task_status": result({"status": "done", "answer": "ok"})}
    bot, *_ = build(answers)
    ask(bot, "/exec задача")
    assert "t1: done" in ask(bot, "/tasks").text
    assert "Задача t1: done" in ask(bot, "/task t1").text
    assert "Формат: /task" in ask(bot, "/task").text
    assert "задач не было" in ask(bot, "/tasks", chat=3).text


def test_mcp_connection_error_is_shown():
    bot, *_ = build()
    bot.worker = FakeWorker(error=McpNotConnected("MCP-сервер не отвечает: запустите run_server.ps1"))
    reply = ask(bot, "/status")
    assert "MCP-сервер не отвечает" in reply.text


def test_status_collects_server_and_workspace():
    answers = {
        "health": result(
            {"ok": True, "version": "0.1.0", "running": 0, "maxParallel": 3, "keyPresent": True, "root": "C:\\p"}
        ),
        "get_workspace": result({"root": "C:\\p", "allowedRoots": ["C:\\"], "sessionId": None}),
        "get_status": result({"model": "claude-sonnet-5-5", "mode": "all"}),
    }
    bot, *_ = build(answers)
    text = ask(bot, "/status").text
    assert "версия 0.1.0" in text and "Ключ ask: есть" in text and "C:\\p" in text
    assert "claude-sonnet-5-5" in text


# --- папка, сессии, браузер -------------------------------------------------------------------


def test_cd_needs_confirmation_and_calls_set_workspace():
    bot, worker, *_ = build({"set_workspace": result({"ok": True, "root": "D:\\work"})}, TELEGRAM_ALLOW_DANGEROUS="1")
    reply = ask(bot, "/cd D:\\work")
    assert reply.keyboard
    asyncio.run(bot.handle_callback(1, f"cf:{token_of(reply)}:yes"))
    assert ("set_workspace", {"path": "D:\\work"}) in worker.calls

    strict, strict_worker, *_ = build()  # по умолчанию опасные действия запрещены
    assert "запрещён" in ask(strict, "/cd D:\\other").text
    assert not strict_worker.calls


def test_ws_and_ls():
    bot, worker, *_ = build(
        {"get_workspace": result({"root": "C:\\p", "allowedRoots": ["C:\\p"]}), "list_files": result({"files": ["a"]})}
    )
    assert "Папка: C:\\p" in ask(bot, "/ws").text
    ask(bot, "/ls docs")
    assert ("list_files", {"path": "docs"}) in worker.calls
    ask(bot, "/ls")
    assert worker.calls[-1] == ("list_files", {})


def test_cat_and_find():
    bot, worker, *_ = build(
        {
            "read_file": result({"ok": True, "output": "строка 1\nстрока 2"}),
            "search": result({"ok": True, "matches": []}),
        }
    )
    assert "строка 1" in ask(bot, "/cat README.md").text
    assert "Формат" in ask(bot, "/cat").text
    ask(bot, "/find MCP")
    assert ("search", {"pattern": "MCP"}) in worker.calls


def test_session_commands():
    answers = {
        "list_sessions": result({"sessions": [{"id": "s1", "title": "Тест", "requests": 2, "current": True}]}),
        "new_session": result({"session_id": "s2"}),
        "resume_session": result({"session_id": "s1", "requests": 2}),
        "session_info": result({"session_id": "mcp-auto", "requests": 1}),
    }
    bot, *_ = build(answers)
    assert "s1: Тест" in ask(bot, "/sessions").text
    assert "s2" in ask(bot, "/new Работа").text
    assert bot._state(1).session_id == "s2"
    assert "s1" in ask(bot, "/use s1").text
    text = ask(bot, "/session").text
    assert "mcp-auto" in text and "s1" in text


def test_browser_screenshot_returns_image():
    image = ToolImage(data=b"\x89PNG", mime="image/png")
    bot, worker, *_ = build({"browser_screenshot": result({"ok": True}, images=[image])})
    reply = ask(bot, "/browser shot")
    assert reply.images == [(b"\x89PNG", "image/png")]
    ask(bot, "/browser open example.com")
    assert worker.calls[-1] == ("browser_open", {"url": "example.com", "mode": "plan"})
    assert "Подкоманды" in ask(bot, "/browser zzz").text


def test_apps_stop_needs_confirmation():
    bot, worker, *_ = build({"stop_all_apps": result({"ok": True})}, TELEGRAM_ALLOW_DANGEROUS="1")
    reply = ask(bot, "/apps stop all")
    assert reply.keyboard
    asyncio.run(bot.handle_callback(1, f"cf:{token_of(reply)}:yes"))
    assert ("stop_all_apps", {}) in worker.calls
    assert "Формат" in ask(bot, "/apps stop два").text


def test_remember_needs_confirmation():
    bot, worker, *_ = build({"remember": result({"ok": True})}, TELEGRAM_ALLOW_DANGEROUS="1")
    reply = ask(bot, "/remember проект использует ESM")
    assert reply.keyboard
    asyncio.run(bot.handle_callback(1, f"cf:{token_of(reply)}:yes"))
    assert ("remember", {"note": "проект использует ESM"}) in worker.calls
    assert "Формат" in ask(bot, "/remember").text


# --- процесс MCP ------------------------------------------------------------------------------


class FakeService:
    def __init__(self):
        self.calls = []

    def status(self, worker=None):
        return "MCP-сервер не запущен. Запустить: /svc start"

    async def start(self, worker=None):
        self.calls.append("start")
        return "MCP-сервер запущен."

    async def stop(self):
        self.calls.append("stop")
        return "MCP-сервер остановлен."


def test_svc_status_start_and_stop_with_confirmation():
    service = FakeService()
    bot, *_ = build(service=service)
    assert "не запущен" in ask(bot, "/svc").text
    assert ask(bot, "/svc start").text == "MCP-сервер запущен."
    reply = ask(bot, "/svc stop")
    assert reply.keyboard
    asyncio.run(bot.handle_callback(1, f"cf:{token_of(reply)}:yes"))
    assert service.calls == ["start", "stop"]
    assert "Формат" in ask(bot, "/svc zzz").text


def test_svc_without_service():
    bot, *_ = build()
    assert "недоступно" in ask(bot, "/svc").text


# --- формат -----------------------------------------------------------------------------------


def test_split_text_keeps_limit_and_fences():
    text = "```\n" + "\n".join(f"строка {i}" for i in range(500)) + "\n```"
    chunks = fmt.split_text(text, 200)
    assert len(chunks) > 1
    assert all(len(chunk) <= 260 for chunk in chunks)
    assert all(chunk.count("```") % 2 == 0 for chunk in chunks)


def test_split_short_text_is_one_chunk():
    assert fmt.split_text("привет", 100) == ["привет"]
    assert fmt.split_text("", 100) == [""]


def test_clip_marks_truncation():
    out = fmt.clip("x" * 5000, 100)
    assert "обрезано" in out and len(out) < 200


def test_long_answer_becomes_document():
    bot, *_ = build({"ask": result({"text": "я" * 12000})}, TELEGRAM_MAX_MESSAGE="300")
    reply = ask(bot, "/ask вопрос")
    assert reply.documents and reply.documents[0][1] == "ask.txt"
    assert "файлом" in reply.text
