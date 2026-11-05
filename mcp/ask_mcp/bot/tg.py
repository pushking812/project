"""Минимальный клиент Telegram Bot API на httpx: только методы, которые нужны боту.

Токен хранится в адресе запроса и никогда не попадает в тексты ошибок и логи.
Разметка (parse_mode) не используется: ответы инструментов — обычный текст, и экранировать его не нужно.
"""

import re
from typing import Any

import httpx

from .config import DEFAULT_API_URL, redact_proxy


def _redact(text: str, proxy: str | None) -> str:
    """Убрать из текста ошибки логин и пароль прокси: httpx может показать адрес целиком."""
    if proxy:
        text = text.replace(proxy, redact_proxy(proxy))
    return re.sub(r"(://)[^/@\s]+@", r"\1***@", text)


class TgError(Exception):
    """Ошибка Bot API: код, описание и (для 429) сколько секунд ждать."""

    def __init__(self, message: str, *, status: int | None = None, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.status == 429 or (self.status or 0) >= 500


class TgApi:
    """Один httpx-клиент на все запросы. transport — для тестов (httpx.MockTransport)."""

    def __init__(
        self,
        token: str,
        api_url: str = DEFAULT_API_URL,
        *,
        timeout: float = 30.0,
        proxy: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._token = token
        self._base = f"{api_url.rstrip('/')}/bot{token}"
        self._timeout = timeout
        self._proxy = proxy
        client_kwargs: dict[str, Any] = {"base_url": self._base, "timeout": timeout, "transport": transport}
        if proxy:
            # Явный прокси сильнее HTTPS_PROXY/ALL_PROXY и NO_PROXY из окружения.
            client_kwargs["proxy"] = proxy
            client_kwargs["trust_env"] = False
        self._client = httpx.AsyncClient(**client_kwargs)

    async def close(self) -> None:
        await self._client.aclose()

    async def call(
        self,
        method: str,
        payload: dict | None = None,
        *,
        files: dict | None = None,
        read_timeout: float | None = None,
    ) -> Any:
        """Один вызов метода. Возвращает поле result или бросает TgError."""
        kwargs: dict[str, Any] = {}
        if files is not None:
            kwargs["data"] = {k: str(v) for k, v in (payload or {}).items() if v is not None}
            kwargs["files"] = files
        else:
            kwargs["json"] = payload or {}
        try:
            response = await self._client.post(method, timeout=read_timeout or self._timeout, **kwargs)
        except httpx.HTTPError as e:
            raise TgError(_redact(f"Telegram недоступен: {type(e).__name__}: {e}", self._proxy)) from e
        try:
            body = response.json()
        except ValueError:
            raise TgError(f"Telegram вернул не JSON (HTTP {response.status_code})", status=response.status_code) from None
        if not body.get("ok"):
            code = body.get("error_code") or response.status_code
            # описание Telegram приходит без токена; адрес запроса в текст не попадает
            raise TgError(
                f"{code} {body.get('description') or 'ошибка Telegram'}",
                status=code,
                retry_after=(body.get("parameters") or {}).get("retry_after"),
            )
        return body.get("result")

    async def get_me(self) -> dict:
        return await self.call("getMe")

    async def get_updates(self, offset: int | None = None, timeout: int = 25) -> list[dict]:
        payload: dict[str, Any] = {"timeout": int(timeout), "allowed_updates": ["message", "callback_query"]}
        if offset is not None:
            payload["offset"] = offset
        return await self.call("getUpdates", payload, read_timeout=float(timeout) + 15.0) or []

    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        reply_markup: dict | None = None,
        reply_to: int | None = None,
        disable_preview: bool = True,
    ) -> dict:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "link_preview_options": {"is_disabled": disable_preview},
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        if reply_to:
            payload["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
        return await self.call("sendMessage", payload) or {}

    async def edit_message_text(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        *,
        reply_markup: dict | None = None,
        disable_preview: bool = True,
    ) -> dict:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "link_preview_options": {"is_disabled": disable_preview},
        }
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        return await self.call("editMessageText", payload) or {}

    async def send_photo(self, chat_id: int, data: bytes, filename: str = "screen.png", *, caption: str | None = None, mime: str = "image/png") -> dict:
        payload = {"chat_id": chat_id, "caption": caption}
        return await self.call("sendPhoto", payload, files={"photo": (filename, data, mime)}) or {}

    async def send_document(self, chat_id: int, data: bytes, filename: str, *, caption: str | None = None) -> dict:
        payload = {"chat_id": chat_id, "caption": caption}
        return await self.call("sendDocument", payload, files={"document": (filename, data, "text/plain")}) or {}

    async def answer_callback_query(self, callback_query_id: str, text: str | None = None) -> None:
        payload: dict[str, Any] = {"callback_query_id": callback_query_id}
        if text:
            payload["text"] = text
        await self.call("answerCallbackQuery", payload)

    async def set_my_commands(self, commands: list[tuple[str, str]]) -> None:
        await self.call(
            "setMyCommands",
            {"commands": [{"command": name, "description": description} for name, description in commands]},
        )
