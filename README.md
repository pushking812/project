# ask-code-mcp

Локальный HTTP/SSE-сервер на Node.js вокруг `ask-code`: запускает задачи ask (модель, файлы, команды, память, сессии)
для папки проекта.

Запуск (Node ≥ 18, нужен ключ ask):

```bash
set ASK_KEY=sk-ask-...   # Linux/macOS: export ASK_KEY=...
npm start                # сервер на http://127.0.0.1:8737
npm test                 # тесты на заглушке сайта, ключ не нужен
```

Подключение Claude Desktop, VS Code Copilot и Cline к MCP-серверу и прокси (со скриптами `register_mcp.ps1`,
`register_proxy.ps1`): **[docs/clients-setup.md](docs/clients-setup.md)**.

Полное описание API (эндпоинты, настройки, примеры, сценарии, отклонения от ТЗ): **[docs/api-stage1.md](docs/api-stage1.md)**.
Telegram-бот для управления MCP-сервером с телефона: **[docs/telegram-bot.md](docs/telegram-bot.md)**.
Справочник этапа 2 с примерами `curl`: **[docs/api-stage2.md](docs/api-stage2.md)**.
