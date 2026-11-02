# ask-code-mcp

Локальный HTTP/SSE-сервер на Node.js вокруг `ask-code`: запускает задачи ask (модель, файлы, команды, память, сессии)
для папки проекта.

Запуск (Node ≥ 18, нужен ключ ask):

```bash
set ASK_KEY=sk-ask-...   # Linux/macOS: export ASK_KEY=...
npm start                # сервер на http://127.0.0.1:8737
npm test                 # тесты на заглушке сайта, ключ не нужен
```

Полное описание API (эндпоинты, настройки, примеры, сценарии, отклонения от ТЗ): **[docs/api-stage1.md](docs/api-stage1.md)**.
Справочник этапа 2 с примерами `curl`: **[docs/api-stage2.md](docs/api-stage2.md)**.
