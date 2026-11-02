# MCP-инструменты и устройство модулей

MCP-сервер (`server.py`) — тонкая обёртка. Бэкенд выбирается переменной `MCP_BACKEND`:

| Значение | Что подключено | Что нужно |
|---|---|---|
| `api` (по умолчанию) | 52 инструмента, которые вызывают HTTP API нашего сервера `ask-code-server` | запущенный `npm start` (`ASK_LOCAL_URL`, по умолчанию `http://127.0.0.1:8737`); ключ сайта у самого `ask-code-server` (`ASK_KEY`) |
| `legacy` | прежние `ask`, `get_usage`, `code` (прямые вызовы сайта Ask) | `ASK_API_KEY` (`sk-ask-...`), `ASK_BASE_URL` по желанию |
| `both` | новые инструменты и прежние под именами `legacy_ask`, `legacy_get_usage`, `legacy_code` | оба набора |

Неизвестное значение — сообщение и код выхода 2.

## Модули

```
server.py                  точка входа: флаги, FastMCP, выбор бэкенда; реэкспорт прежних имён для openai_proxy.py и тестов
ask_mcp/config.py          .env, MCP_BACKEND, ASK_LOCAL_URL, BASE_URL, разбор --http/--host/--port
ask_mcp/errors.py          AskError, StreamError
ask_mcp/sse.py             разбор Server-Sent Events (общий для обоих бэкендов)
ask_mcp/api_client.py      call(): один запрос к нашему API (JSON или SSE), ошибки, fold_stream()
ask_mcp/tools/             бэкенд api: tasks, files, memory, sessions, browser, watches, service
ask_mcp/legacy/remote.py   прежние ask и get_usage (ретраи, дочитывание обрыва)
ask_mcp/legacy/code.py     прежний code и его локальные инструменты
```

Новый инструмент: функция с понятным докстрингом в нужной группе `tools/*.py`, имя в списке `TOOLS` модуля. Имя функции
становится именем инструмента, докстринг — его описанием для модели.
Прежний код не удалён: его можно дорабатывать в `ask_mcp/legacy/`, включая `MCP_BACKEND=legacy|both`. `openai_proxy.py`
по-прежнему берёт `_ask_stream`, `_headers` и другое из `server.py`.

## Соответствие инструментов эндпоинтам

Параметры пишутся в snake_case, на сервер уходят в его именах (`allowed_sites` → `allowedSites`, `use_context` →
`useContext`). Необязательные параметры, которые не заданы, в запрос не попадают. Тексты ошибок: `статус код: сообщение`
(например `403 plan_mode: ...`). Если сервер API не запущен, ошибка говорит об этом и подсказывает `npm start`.

| Группа | Инструмент | Эндпоинт |
|---|---|---|
| задачи | `ask(prompt, use_context)` | `POST /ask` (SSE) |
| | `execute(prompt, mode, session_id, browser, allowed_sites, headless, captcha)` | `POST /execute` (SSE, ждёт конца) |
| | `start_task(...)` | `POST /start` |
| | `task_status(task_id)` | `GET /status/:taskId` |
| | `stop_task(task_id)` | `POST /stop/:taskId` |
| | `health()`, `me()` | `GET /health`, `GET /me` |
| файлы | `read_file(path, offset, limit)` | `POST /read` |
| | `list_files(path, depth)` | `POST /list` |
| | `search(pattern, path, regex)` | `POST /search` |
| | `write_file(path, content, overwrite, mode)` | `POST /write` |
| | `edit_file(path, old_text, new_text, mode)` | `POST /edit` |
| | `run_command(command, timeout_sec, mode)` | `POST /command` |
| память | `get_notes`, `remember`, `list_memory`, `read_memory`, `write_memory` | `GET /notes`, `POST /remember`, `GET /memory`, `GET /memory/:topic`, `POST /memory` |
| | `clear_memory(confirm)` | `DELETE /memory?mode=all`; без `confirm=true` запрос не уходит |
| сессии | `list_sessions`, `new_session`, `resume_session`, `get_session`, `export_session` | `GET /sessions`, `POST /sessions`, `POST /sessions/resume`, `GET /sessions/:id`, `POST /sessions/:id/export` |
| браузер | `browser_open`, `browser_read`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_console`, `browser_back`, `browser_viewport`, `browser_close` | `POST /browser` с `action` |
| | `browser_state` | `GET /browser` |
| | `browser_handoff(text, headless)` | `POST /browser` `action: handoff` (SSE, до 8 минут) |
| | `browser_handoff_done(note)` | `POST /browser/handoff/done` |
| наблюдения, приложения | `list_watches`, `add_watch`, `remove_watch`, `remove_all_watches` | `/watches` |
| | `list_apps`, `stop_app`, `stop_all_apps` | `/apps` |
| служебные | `get_context`, `get_status`, `compact`, `list_models`, `set_model`, `doctor`, `report_bug` | `/context`, `/status`, `/compact` (SSE), `/models`, `/model`, `/doctor`, `/bug` |

Ответы инструментов — JSON-текст (`{"ok": ..., "output": ...}` как у API); `execute` и `ask` сворачивают поток SSE в
`{text, tools, usage, session, done}`. Снимки страницы браузера приходят отдельными блоками-картинками, не base64 в тексте.
Значения пути (`task_id`, `topic`, `id`) кодируются, поэтому `../x` не меняет адрес запроса.

## Что учесть

- **Безопасность.** У HTTP API нет аутентификации. `ASK_LOCAL_URL` с чужим адресом отклоняется без `ASK_ALLOW_REMOTE=1`.
  Режим `mode` берёт на себя API (`plan` запрещает запись и команды); MCP-слой его только передаёт.
  Клиент MCP, которому доступны эти инструменты, может запускать команды в папке проекта на сервере API (`run_command`,
  `execute` в режиме `all`). Подключайте его только тем клиентам, которым это можно.
- **Расход лимита.** Тратят лимит тарифа `ask`, `execute`, `start_task`, `compact`.
- **Долгие вызовы.** `execute` и `browser_handoff` не возвращаются до конца (минуты). Отмена вызова клиентом закрывает
  соединение, и сервер API останавливает задачу. Промежуточных событий (прогресс) клиент MCP пока не получает: это можно
  добавить через `ctx.report_progress`.
- **Капча.** Её решает человек: `browser_handoff`, `captcha: "handoff"` в `browser_open` и `execute`.

## Тесты

```
.venv\Scripts\python -m pytest
```

`tests/test_api_tools.py` проверяет бэкенд api на подставном HTTP API (маршруты, тела запросов, ошибки, изображения,
регистрацию бэкендов), остальные файлы — прежние инструменты и прокси. Сквозная проверка с настоящим `ask-code-server`:
запустите `npm start` и выполните `.venv\Scripts\python smoke_test.py` (вызывает `health`, `list_files`, `browser_state`).
