"""Long polling Telegram и маршрутизация обновлений.

Здесь только транспорт: доступ по user id, отправка Reply (текст, кнопки, снимки, файлы)
и цикл getUpdates. Логика команд — в commands.py.
"""

import asyncio

from . import config as bot_config
from . import format as fmt
from .commands import BotService
from .log import configure, error, info, set_secret, warn
from .mcp_client import McpWorker
from .service import McpProcess
from .tg import TgApi, TgError

COMMANDS = [
    ("help", "справка по командам"),
    ("status", "связь с MCP, сервер, папка, сессия"),
    ("exec", "выполнить задачу и дождаться"),
    ("plan", "план без изменений в папке"),
    ("task", "состояние задачи по id"),
    ("tasks", "последние задачи"),
    ("stop", "остановить задачу"),
    ("ask", "вопрос модели без действий"),
    ("mode", "режим задач: plan, edits, all"),
    ("ws", "рабочая папка"),
    ("tools", "инструменты MCP"),
    ("call", "вызвать инструмент с JSON"),
    ("svc", "процесс MCP: status, start, stop"),
    ("session", "текущая сессия"),
    ("sessions", "список сессий"),
    ("doctor", "проверки компьютера и сайта"),
]


class TelegramNotifier:
    """Отправка и правка сообщений: прогресс задачи и ответы."""

    def __init__(self, tg: TgApi, max_message: int = 3900):
        self.tg = tg
        self.max_message = max_message

    async def send(self, chat_id: int, text: str, keyboard=None, reply_to: int | None = None) -> int | None:
        chunks = fmt.split_text(text, self.max_message)
        message_id = None
        for index, chunk in enumerate(chunks):
            markup = self._markup(keyboard) if index == 0 and keyboard else None
            result = await self.tg.send_message(chat_id, chunk, reply_markup=markup, reply_to=reply_to if index == 0 else None)
            if index == 0:
                message_id = (result or {}).get("message_id")
        return message_id

    async def edit(self, chat_id: int, message_id: int, text: str) -> None:
        try:
            await self.tg.edit_message_text(chat_id, message_id, text)
        except TgError as e:
            # «message is not modified» — обычное дело, когда шаг не изменился
            if e.status == 400 and "not modified" in str(e):
                return
            raise

    @staticmethod
    def _markup(keyboard) -> dict:
        return {
            "inline_keyboard": [
                [{"text": label, "callback_data": data} for label, data in row]
                for row in keyboard
            ]
        }


class BotApp:
    """Цикл getUpdates: чужое игнорируем, своё отдаём сервису и отправляем ответ."""

    def __init__(self, cfg, tg: TgApi, service: BotService, worker=None):
        self.cfg = cfg
        self.tg = tg
        self.service = service
        self.worker = worker
        self.notifier = TelegramNotifier(tg, cfg.max_message)
        self._tasks: set[asyncio.Task] = set()

    def allowed(self, chat_id, user_id) -> bool:
        if self.cfg.allowed_users and user_id not in self.cfg.allowed_users:
            return False
        if self.cfg.allowed_chats and chat_id not in self.cfg.allowed_chats:
            return False
        return True

    async def handle_update(self, update: dict) -> None:
        message = update.get("message")
        if isinstance(message, dict):
            await self._message(message)
            return
        callback = update.get("callback_query")
        if isinstance(callback, dict):
            await self._callback(callback)

    async def _message(self, message: dict) -> None:
        chat_id = (message.get("chat") or {}).get("id")
        user_id = (message.get("from") or {}).get("id")
        if chat_id is None or not self.allowed(chat_id, user_id):
            warn("bot", f"чужое сообщение пропущено: user={user_id} chat={chat_id}")
            return
        text = (message.get("text") or "").strip()
        if not text:
            await self.notifier.send(chat_id, "Понимаю только текст. /help")
            return
        reply = await self.service.handle(chat_id, text)
        await self.send_reply(chat_id, reply, reply_to=message.get("message_id"))

    async def _callback(self, callback: dict) -> None:
        callback_id = callback.get("id")
        chat_id = ((callback.get("message") or {}).get("chat") or {}).get("id")
        user_id = (callback.get("from") or {}).get("id")
        if chat_id is None or not self.allowed(chat_id, user_id):
            warn("bot", f"чужая кнопка пропущена: user={user_id} chat={chat_id}")
            if callback_id:
                await self.tg.answer_callback_query(callback_id)
            return
        try:
            reply = await self.service.handle_callback(chat_id, callback.get("data") or "")
        finally:
            if callback_id:
                await self.tg.answer_callback_query(callback_id)
        if reply is not None:
            await self.send_reply(chat_id, reply)

    async def send_reply(self, chat_id: int, reply, reply_to: int | None = None) -> None:
        if reply.text or reply.keyboard:
            await self.notifier.send(chat_id, reply.text or "(пусто)", reply.keyboard, reply_to=reply_to)
        for data, mime in reply.images:
            name = "screen.png" if "png" in mime else "screen.jpg"
            try:
                if len(data) <= 5 * 1024 * 1024:
                    await self.tg.send_photo(chat_id, data, name, mime=mime)
                else:
                    await self.tg.send_document(chat_id, data, name, caption="Снимок больше 5 МБ")
            except TgError as e:
                await self.notifier.send(chat_id, f"Не удалось отправить снимок: {e}")
        for data, filename, caption in reply.documents:
            await self.tg.send_document(chat_id, data, filename, caption=caption or None)

    async def run(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        try:
            await self.tg.set_my_commands(COMMANDS)
        except TgError as e:
            warn("bot", f"меню команд не обновлено: {e}")
        info("bot", "long polling запущен")
        offset = None
        while not stop.is_set():
            try:
                updates = await self.tg.get_updates(offset=offset, timeout=self.cfg.poll_timeout)
            except TgError as e:
                if e.status == 401:
                    raise SystemExit(f"Telegram не принял токен: {e}") from e
                delay = e.retry_after or 3.0
                warn("bot", f"getUpdates: {e}; пауза {delay:.0f} c")
                await asyncio.sleep(delay)
                continue
            for update in updates or []:
                offset = int(update.get("update_id") or 0) + 1
                task = asyncio.create_task(self._guarded(update))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)

    async def _guarded(self, update: dict) -> None:
        try:
            await self.handle_update(update)
        except Exception as e:  # noqa: BLE001 — одно обновление не должно останавливать бота
            error("bot", f"обновление не обработано: {type(e).__name__}: {e}")

    async def close(self) -> None:
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


async def main() -> None:
    """Собирает бота из настроек и работает до Ctrl+C."""
    cfg = bot_config.load_config()
    configure(cfg.log_level)
    set_secret(cfg.token)

    worker = McpWorker(cfg.mcp_url)
    await worker.start()
    tg = TgApi(cfg.token, cfg.api_url, proxy=cfg.proxy)
    app = None
    try:
        me = await tg.get_me()
        info("bot", f"подключён как @{me.get('username')} (id {me.get('id')})")
        service = BotService(worker, cfg, service=McpProcess())
        app = BotApp(cfg, tg, service, worker)
        service.notifier = app.notifier  # прогресс задач идёт в чат
        await app.run()
    finally:
        if app is not None:
            await app.close()
        await worker.stop()
        await tg.close()
