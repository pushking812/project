"""Офлайн-проверка транспорта бота: доступ, разбиение, снимки, файлы, long polling."""

import asyncio

from ask_mcp.bot.app import COMMANDS, BotApp
from ask_mcp.bot.commands import BotService
from ask_mcp.bot.mcp_client import ToolImage
from bot_fakes import FakeWorker, make_config, result


class FakeTg:
    def __init__(self):
        self.updates = []
        self.sent = []
        self.edits = []
        self.photos = []
        self.documents = []
        self.commands = None
        self.callback_answers = []
        self._message_id = 10

    async def set_my_commands(self, commands):
        self.commands = commands

    async def get_updates(self, offset=None, timeout=25):
        await asyncio.sleep(0)
        batch, self.updates = self.updates, []
        return batch

    async def send_message(self, chat_id, text, **kw):
        self._message_id += 1
        self.sent.append((chat_id, text, kw.get("reply_markup")))
        return {"message_id": self._message_id}

    async def edit_message_text(self, chat_id, message_id, text, **kw):
        self.edits.append((chat_id, message_id, text))
        return {}

    async def send_photo(self, chat_id, data, filename="screen.png", mime="image/png", caption=None):
        self.photos.append((chat_id, data, filename, mime))

    async def send_document(self, chat_id, data, filename, caption=None):
        self.documents.append((chat_id, filename, caption))

    async def answer_callback_query(self, callback_query_id, text=None):
        self.callback_answers.append((callback_query_id, text))

    async def get_me(self):
        return {"id": 1, "username": "test_bot"}


def build_app(**env):
    cfg = make_config(**env)
    tg = FakeTg()
    worker = FakeWorker({"ask": result({"text": "ответ"})})
    service = BotService(worker, cfg)
    app = BotApp(cfg, tg, service, worker)
    service.notifier = app.notifier
    return app, tg, worker


def message(update_id=1, text="/help", user_id=1, chat_id=1):
    return {
        "update_id": update_id,
        "message": {"message_id": 5, "text": text, "from": {"id": user_id}, "chat": {"id": chat_id}},
    }


def run(coro):
    return asyncio.run(coro)


def test_stranger_is_ignored():
    app, tg, worker = build_app()
    run(app.handle_update(message(user_id=999)))
    assert tg.sent == [] and worker.calls == []


def test_help_is_sent_to_allowed_user():
    app, tg, _ = build_app()
    run(app.handle_update(message(text="/help")))
    assert len(tg.sent) == 1 and "/exec" in tg.sent[0][1]


def test_plain_text_goes_to_ask():
    app, tg, worker = build_app()
    run(app.handle_update(message(text="привет")))
    assert worker.calls == [("ask", {"prompt": "привет"})]
    assert tg.sent and "ответ" in tg.sent[0][1]


def test_non_text_message_gets_hint():
    app, tg, _ = build_app()
    run(app.handle_update({"update_id": 1, "message": {"message_id": 2, "from": {"id": 1}, "chat": {"id": 1}}}))
    assert tg.sent and "только текст" in tg.sent[0][1]


def test_long_reply_is_split_into_several_messages():
    app, tg, worker = build_app(TELEGRAM_MAX_MESSAGE="500")
    worker.answers["ask"] = result({"text": "я" * 1200})
    run(app.handle_update(message(text="/ask вопрос")))
    assert len(tg.sent) == 3
    assert all(len(text) <= 500 for _, text, _ in tg.sent)


def test_callback_executes_and_is_answered():
    app, tg, worker = build_app(TELEGRAM_ALLOW_DANGEROUS="1")
    worker.answers["write_file"] = result({"ok": True})
    run(app.handle_update(message(text='/call write_file {"path":"a","content":"b"}')))
    markup = tg.sent[-1][2]
    data = markup["inline_keyboard"][0][0]["callback_data"]
    update = {
        "update_id": 2,
        "callback_query": {
            "id": "cb1",
            "data": data,
            "from": {"id": 1},
            "message": {"message_id": 11, "chat": {"id": 1}},
        },
    }
    run(app.handle_update(update))
    assert tg.callback_answers == [("cb1", None)]
    assert ("write_file", {"path": "a", "content": "b"}) in worker.calls


def test_callback_from_stranger_is_answered_but_not_executed():
    app, tg, worker = build_app()
    update = {
        "update_id": 3,
        "callback_query": {
            "id": "cb2",
            "data": "cf:12345678:yes",
            "from": {"id": 7},
            "message": {"message_id": 11, "chat": {"id": 7}},
        },
    }
    run(app.handle_update(update))
    assert tg.callback_answers == [("cb2", None)]
    assert worker.calls == []


def test_image_reply_is_sent_as_photo():
    app, tg, worker = build_app()
    worker.answers["browser_screenshot"] = result({"ok": True}, images=[ToolImage(b"\x89PNG", "image/png")])
    run(app.handle_update(message(text="/browser shot")))
    assert tg.photos and tg.photos[0][1] == b"\x89PNG"


def test_run_registers_commands_and_processes_updates():
    app, tg, _ = build_app()
    tg.updates = [message(update_id=1, text="/help")]
    run(_run_once(app, tg))
    assert tg.commands == COMMANDS
    assert tg.sent and "/exec" in tg.sent[0][1]


async def _run_once(app, tg):
    stop = asyncio.Event()

    async def stop_soon():
        await asyncio.sleep(0.02)
        stop.set()

    asyncio.create_task(stop_soon())
    await app.run(stop)
    await asyncio.sleep(0.02)
    await app.close()
