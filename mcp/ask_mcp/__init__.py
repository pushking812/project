"""MCP-слой Ask: инструменты для клиентов MCP.

Пакет разбит на модули:
  config      настройки из окружения и .env, разбор флагов запуска
  errors      AskError и внутренние ошибки
  sse         разбор потока Server-Sent Events
  api_client  вызовы HTTP API нашего сервера (ask-code-server, 127.0.0.1:8737)
  tools/      инструменты по группам, работающие через api_client (бэкенд «api»)
  legacy/     прежние инструменты ask, get_usage, code: прямые вызовы сайта Ask (бэкенд «legacy»)
"""
