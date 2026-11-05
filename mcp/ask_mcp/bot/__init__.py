"""Telegram-бот поверх MCP-сервера Ask.

Слои:
  config      настройки из mcp/.env и переменных окружения (fail-closed)
  log         строки [INFO] [bot] ... в stderr, без токена
  tg          минимальный клиент Telegram Bot API на httpx
  mcp_client  MCP по Streamable HTTP: одна сессия, очередь, переподключение
  format      обрезка и разбиение сообщений, читаемый JSON
  commands    команды бота и подтверждения (Telegram здесь нет — тестируется офлайн)
  service     запуск и остановка локального MCP-сервера
  app         long polling, доступ по user id, маршрутизация обновлений
"""
