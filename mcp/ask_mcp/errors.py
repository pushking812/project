"""Ошибки MCP-слоя."""


class AskError(Exception):
    """Понятная ошибка, которую увидит клиент MCP."""


class StreamError(AskError):
    """Ошибка из event: error; retryable — флаг сервера."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable
