# Отчёт по этапу 1 (Node.js-часть ask-code-mcp)

Дата: 2026-11-02. Ветка `main`, 9 коммитов. Проверка на момент отчёта: `npm test` → 18 passed, 0 failed.

Область отчёта: коммиты 1–9 из §10 ТЗ. По `PROMPT.txt` Python MCP (коммиты 10–15) в мою часть не входит.

## 1. Коммиты

| # | Хэш | Сообщение | Статус |
|---|---|---|---|
| 1 | `7ee7a00` | chore: scaffold project, vendor ask-code, build patch | сделан |
| 2 | `dddf81a` | feat(server): HTTP skeleton, config, /health, graceful shutdown | сделан |
| 3 | `453d734` | feat(server): GET /me proxy | сделан |
| 4 | `2bc0047` | feat(server): SSE helper and POST /ask with project context | сделан (с отклонением) |
| 5 | `d126017` | feat(server): task registry and executeTask core | сделан |
| 6 | `c18628b` | feat(server): POST /execute (synchronous task) | сделан |
| 7 | `a18ee8d` | feat(server): POST /start, GET /status, POST /stop | сделан (с отклонением) |
| 8 | `f097026` | feat(server): error handling, MAX_PARALLEL guard, cleanup | сделан |
| 9 | `489bbfb` | test(server): integration tests | сделан (в коммит вошёл и `README.md`) |
| 10–15 | — | Python MCP, документация Cline | не входят в мою часть |

Сообщения коммитов совпадают с §10 ТЗ. Коммит 6 был сделан при одном упавшем unit-тесте (я не заметил сбоя). Тест исправил и сделал `--amend` в локальном коммите, наружу ничего не уходило.

## 2. Что сделано

- **Каркас.** `package.json` без зависимостей, `.gitignore`, `.gitattributes`, `vendor/ask-code.mjs` без изменений, `build/patch.mjs` (идемпотентный, добавляет `export` к `api`, `events`, `doTool`).
- **Сервер** `ask-code-server.mjs` на `node:http`, 7 эндпоинтов: `/health`, `/me`, `/ask`, `/execute`, `/start`, `/status/:id`, `/stop/:id`. Слушает только `127.0.0.1`.
- **Модули `lib/`:** `config`, `log`, `errors`, `sse`, `ask-proxy`, `context`, `tasks`, `executor`, `mock-input`.
- **Реестр задач:** `MAX_PARALLEL`, 429 при переполнении, очистка по TTL (1 час, проверка раз в 5 минут).
- **Остановка:** `/stop`, обрыв клиента на `/execute` и shutdown отменяют задачу и останавливают apps.
- **Graceful shutdown** по `SIGINT`/`SIGTERM`.
- **Логи** в stderr в формате `[LEVEL] [module] message`; ключ, prompt и ответы не логируются.
- **Тесты:** `test/integration.mjs`, `test/executor.test.mjs` (8), `test/mock-site.mjs` (имитация сайта ask).
- **README.md:** установка, таблица env, curl для каждого эндпоинта, «Решения и допущения», «Отклонения от ТЗ».
- **Сверх плана** (не коммитилось): набор для Postman в `postman/` (коллекция на 12 запросов и `curls.txt`).

## 3. Что не сделано или не проверено

- **Python MCP, коммиты 10–15** и критерии приёмки 12–17 — вне моей части.
- **Критерий 11 (SIGINT, завершение <5 с)** проверен только через `app.shutdown()` (около 60 мс) на Windows. Реальную доставку сигнала нужно один раз проверить на Linux или macOS.
- **Реальный сайт ask** в тестах не участвовал. Формат потока `/v1/code` сверялся только по коду монолита. Без этого пункты 2–6 приёмки подтверждены лишь на mock-сайте.
- **Скрипт `.ps1` для MCP Inspector** не сделан: Python MCP-слоя пока нет, запускать в Inspector нечего.
- **Postman-коллекция** не импортировалась и не запускалась.
- **Не в git:** `PROMPT.txt`, `ТЗ.txt`, `ask-code.mjs` в корне проекта (входные файлы) и `postman/`. Решите, коммитить ли `postman/`.

## 4. Отклонения от ТЗ

| Пункт ТЗ | Что в ТЗ | Что сделано | Причина |
|---|---|---|---|
| §4.3, коммит 4 | `POST /ask` использует `/v1/ask` | Используется `/v1/code` с `commands: false`, любой вызов инструмента получает отказ | В вендорном клиенте `/v1/ask` нет (проверено поиском) |
| §4.7 | `/stop` отвечает `{"status":"stopping"}` | Для уже завершённой задачи отвечает её итоговым статусом (`done`/`error`/`stopped`) | Ответ «stopping» для завершённой задачи был бы неверным |
| §4.4 | `event: status {"state":"thinking"}` | Дубли `thinking` от сайта отбрасываются | Событие приходило дважды (наше и от сайта) |
| §10, коммит 8 | `/execute` синхронный | Занимает слот `MAX_PARALLEL` и может вернуть 429 | Так сказано в коммите 8, §4.4 этого не упоминает |
| §4.4, коммит 8 | `done` в конце | При abort `/execute` заканчивается `event: error {"message":"stopped"}` | Следует коммиту 8 |
| §10, коммит 9 | интеграционный тест | Простой скрипт на `node:test`, запуск `node test/integration.mjs` | Практичность |
| §4.8 | Нет `console.log` | `doTool` пишет в stdout; `process.stdout.write` в `main()` заменён на no-op | Иначе в stdout попадали бы диффы файлов. Монолит не правился (требование PROMPT) |
| §6.1 `ASK_SITE` | любой URL | `http://` разрешён только для localhost | Ограничение, которого в ТЗ нет (по README) |

Остальные решения (`mockInput` отвечает «yes» только на «Allow this change», остальное «no») описаны в README, раздел «Решения и допущения».

## 5. Чек-лист критериев приёмки (§9)

Обозначения: [x] выполнено и проверено тестом на mock-сайте; [~] выполнено частично или не проверено на реальной системе; [ ] не выполнено; [—] вне моей части.

### Node API

- [x] 1. `GET /health` → `{ok: true, ...}`
- [x] 2. `GET /me` проксирует JSON; 401 и 502 обрабатываются (mock-сайт, ключ реальный не проверялся) [~ реальный сайт]
- [x] 3. `POST /ask` с `useContext=true` → SSE `delta`/`done`, контекст из `ASK.md` попадает в запрос [~ реальный сайт, `/v1/code` вместо `/v1/ask`]
- [x] 4. `POST /execute` «создай hello.txt» → файл создан, `done.steps` содержит `wrote hello.txt` [~ реальный сайт]
- [x] 5. `POST /execute` «прочитай .env» → отказ виден модели
- [x] 6. `POST /execute` «прочитай ../../../etc/passwd» → отказ `inside()`
- [x] 7. `POST /start` ×2 → два `taskId`, `running`, завершаются независимо
- [x] 8. `POST /start` × (MAX_PARALLEL+1) → 429
- [x] 9. `POST /stop/:id` → `stopping`, затем `stopped`
- [x] 10. `GET /status/unknown` → 404
- [~] 11. `SIGINT` → abort, `apps.stopAll()`, выход <5 с: проверено через `app.shutdown()` (~60 мс); реальный сигнал не проверен (Windows)

### Python MCP (вне моей части)

- [—] 12. `mcp_server.py` запускается, Cline видит 5 tools
- [—] 13. `ask_ask("что в ASK.md?")`
- [—] 14. `ask_execute("создай hello.txt")` + progress
- [—] 15. `ask_start` ×2, `ask_status`, `ask_stop`
- [—] 16. `ASK_AUTO_START=true`
- [—] 17. `ASK_AUTO_START=false` и Node не запущен → понятная ошибка

### Безопасность

- [x] 18. `.env` не читается через `/execute`
- [x] 19. `run_command` не видит `ASK_KEY`
- [x] 20. Node слушает только `127.0.0.1`

### Definition of Done (§12), Node-часть

- [~] Все 15 коммитов в `main`: смёржены 9 из 9 в моей части, 10–15 — вне моей части
- [x] `npm test` зелёный (18/18)
- [x] Нет `console.log` в Node, только stderr через `lib/log.mjs`
- [x] `ASK_KEY` не появляется в логах (проверено тестом)
- [x] Node слушает только `127.0.0.1`
- [~] Graceful shutdown Node: проверен через `app.shutdown()`, реальный сигнал не проверен
- [ ] Python MCP, smoke через Inspector, Cline видит 5 tools — вне моей части
- [ ] README позволяет поднять систему за ≤15 минут — для Node-части есть; Cline-конфиг и Python (коммит 15) отсутствуют

### Требования PROMPT.txt

- [x] Все 9 коммитов в `main`, история читается как прогресс
- [x] `vendor/ask-code.mjs` не изменён и закоммичен; `build/ask-code-core.mjs` в `.gitignore`
- [x] Нулевые зависимости в Node-части
- [x] Ошибки через `sendError`, формат `{"error": "..."}`
- [x] README: установка, таблица env, curl для всех эндпоинтов, «Решения и допущения», «Отклонения от ТЗ»
- [x] Критерии для Node API 1–11 и 18–20 (с оговорками выше)

## 6. Риски и что проверить дальше

1. Прогнать `/ask`, `/execute`, `/me` с реальным `ASK_KEY` на настоящем сайте. Это главный непроверенный риск.
2. Один раз проверить SIGINT на Linux или macOS.
3. Решить судьбу `postman/` и входных файлов (коммит или `.gitignore`).
4. Передать Python-разработчику контракт из README: события SSE, коды ошибок, поведение `/stop` на завершённой задаче.

## 7. Готово для этапа 2

`createApp(config)` и `app.route()` позволяют добавлять эндпоинты. `TaskRegistry` и `executeTask` с подменяемыми зависимостями (`deps`) переиспользуются.
