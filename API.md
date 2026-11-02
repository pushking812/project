# ask-code-mcp — описание API (этапы 1 и 2)

Краткое описание проекта и запуск — в [README.md](README.md). Ниже: установка, настройка, все эндпоинты, сценарии,
решения и отклонения от ТЗ.

HTTP/SSE server around `ask-code`: it runs ask tasks (model, tool calls, files, commands, memory) for a project folder.
Stage 1: tasks (`/ask`, `/execute`, `/start`, `/status`, `/stop`). Stage 2 so far: direct file and command endpoints (2A),
notes and memory (2B), sessions (2C). Browser endpoints (2D) and later are not done yet.
The Python MCP layer (stage 1, commits 10–15) talks to this API; it is not part of this package yet.

## Install and run

Needs Node ≥ 18 and an ask key (plan Plus+). No npm dependencies.

```bash
export ASK_KEY=sk-ask-...      # Windows cmd: set ASK_KEY=...
npm start                      # patches vendor/ask-code.mjs into build/ask-code-core.mjs, then starts the server
npm test                       # 37 integration tests against a stand-in for the ask site (no key needed)
```

`vendor/ask-code.mjs` is a byte-for-byte copy of the monolith and is never edited. `build/patch.mjs` adds `export` to
`api`, `events` and `doTool` and writes `build/ask-code-core.mjs` (generated, not committed; idempotent).

## Configuration

| Variable | Default | Required | Description |
|---|---|---|---|
| `ASK_KEY` | — | yes | ask API key |
| `ASK_SITE` | `https://ask.oryxml.com` | no | base URL of ask (`http://` only for localhost) |
| `ASK_ROOT` | `process.cwd()` | no | project folder |
| `ASK_HOST` | `127.0.0.1` | no | HTTP host (the API has no authentication: keep it on loopback) |
| `ASK_PORT` | `8737` | no | port (`0` = any free port) |
| `ASK_MODE` | `all` | no | default mode of `/execute` and `/start` |
| `ASK_MAX_PARALLEL` | `3` | no | tasks running at once |
| `ASK_LOG_LEVEL` | `info` | no | `debug` \| `info` \| `warn` \| `error` |
| `ASK_BROWSER_HEADLESS` | `1` | no | `0` — the browser of `POST /browser` opens a visible window (needed for `handoff`) |
| `ASK_BROWSER_DIR` | `~/.config/ask-code/browser` | no | profile folder of the browser |
| `ASK_BROWSER` | search for Chrome/Edge/Brave/Chromium | no | path to the browser binary (read by ask-code) |

Logs go to stderr as `[LEVEL] [module] message`; stdout is never written. The key, prompts and answers are not logged.

## API

Базовый адрес: `http://127.0.0.1:8737` (хост и порт задаются `ASK_HOST` / `ASK_PORT`). Аутентификации нет: сервер
предназначен только для локального доступа. Тела запросов — JSON (`content-type: application/json`), пустое тело
считается `{}`.

| Метод и путь | Назначение | Ответ |
|---|---|---|
| `GET /health` | состояние сервера | JSON |
| `GET /me` | аккаунт ask (прокси `/v1/me`) | JSON |
| `POST /ask` | вопрос без действий в проекте | поток SSE |
| `POST /execute` | задача агента, ожидание результата | поток SSE |
| `POST /start` | задача агента в фоне | JSON |
| `GET /status/:taskId` | состояние фоновой задачи | JSON |
| `POST /stop/:taskId` | остановка задачи | JSON |
| `POST /read`, `/list`, `/search` | чтение файлов проекта напрямую (этап 2) | JSON |
| `POST /write`, `/edit` | запись и правка файла с diff (этап 2) | JSON |
| `POST /command` | команда в папке проекта (этап 2) | JSON |
| `GET /notes`, `POST /remember` | заметки `ASK.md` (этап 2) | JSON |
| `GET`/`POST`/`DELETE /memory`, `GET /memory/:topic` | память Ask о папке (этап 2) | JSON |
| `GET`/`POST /sessions`, `POST /sessions/resume`, `GET /sessions/:id`, `POST /sessions/:id/export` | сессии (этап 2) | JSON |
| `POST /browser` | браузер: open, read, click, … (этап 2Г) | JSON; для `handoff` — поток SSE |
| `POST /browser/handoff/done` | завершить передачу окна человеку без капчи (расширение) | JSON |

### Общие правила

**Ошибки.** Ошибка до начала ответа — JSON `{"error": "текст"}` с HTTP-кодом:

| Код | Когда |
|---|---|
| 400 | тело не JSON или не объект; `prompt` пуст или не строка; неверный `mode`, `useContext` или `session_id` |
| 409 | `session_id`: в этой сессии уже идёт задача (`session_busy`) |
| 401 | сайт ask отклонил ключ (`/me`) |
| 404 | неизвестный путь или неизвестный `taskId` |
| 405 | путь существует, но метод другой |
| 413 | тело запроса больше 1 МБ |
| 429 | запущено `ASK_MAX_PARALLEL` задач (`/execute`, `/start`) либо лимит на стороне ask (`/me`) |
| 502 | сайт ask недоступен или ответил ошибкой (`/me`) |
| 500 | внутренняя ошибка (`{"error":"internal error"}`) |

Если поток SSE уже начался, код всегда 200, а ошибка приходит событием `error` в конце потока.

**SSE.** Ответ имеет `content-type: text/event-stream`. Каждое событие выглядит так:

```
event: delta
data: {"text":"Hel"}

```

`data` — всегда JSON-объект. Раз в 15 секунд сервер шлёт строку-комментарий `: ping`, чтобы прокси не обрывали тихие
долгие задачи; клиент её игнорирует. Поток заканчивается событием `done` или `error`, после чего соединение закрывается.
В `curl` используйте ключ `-N`, иначе вывод буферизуется.

**Режимы (`mode`).** Допустимы `all`, `edits`, `plan`; по умолчанию берётся `ASK_MODE`.
- `all` — агент сам правит файлы и запускает команды без вопросов (секретные файлы вроде `.env` он не трогает);
- `edits` — правки файлов разрешены, команды и открытие сайтов отклоняются;
- `plan` — только чтение и план, файлы не меняются.

Вопросы агента к пользователю разрешает по правилу `lib/mock-input.mjs`: «да» только на «Allow this change», всё
остальное — «нет».

**Статусы задачи:** `running` → `done` | `error` | `stopped`.

### GET /health

Ответ `200`:

```json
{ "ok": true, "version": "0.1.0", "node": "24.0.0", "keyPresent": true,
  "root": "C:\\work\\project", "running": 0, "maxParallel": 3 }
```

`running` — сколько задач выполняется сейчас, `root` — папка проекта (`ASK_ROOT`). Ключ не возвращается.

```bash
curl -s http://127.0.0.1:8737/health
```

### GET /me

Возвращает как есть ответ сайта ask на `/v1/me` (аккаунт, тариф, лимиты; состав полей определяет сайт).
Ошибки: `401` (неверный ключ), `429`, `502` (сайт недоступен).

```bash
curl -s http://127.0.0.1:8737/me
```

### POST /ask

Один вопрос к модели **без инструментов**: файлы не меняются, команды не запускаются. Запрос идёт в `/v1/code` с
`commands: false` (см. «Отклонения от ТЗ»).

Тело:

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| `prompt` | string | да | вопрос, непустая строка |
| `useContext` | boolean | нет, по умолчанию `true` | добавить контекст проекта: `ASK.md`, память, состояние папки |

События потока:

| Событие | `data` | Описание |
|---|---|---|
| `delta` | `{"text": "..."}` | очередной кусок ответа |
| `usage` | `{"input": 120, "output": 45}` | расход токенов |
| `done` | `{}` | ответ завершён |
| `error` | `{"message": "..."}` | ошибка (в том числе ошибка сайта ask или обрыв связи) |

Если клиент закрыл соединение, запрос к сайту прерывается, а запущенный прогон там останавливается.

```bash
curl -N -X POST http://127.0.0.1:8737/ask -H 'content-type: application/json' \
  -d '{"prompt":"what is in ASK.md? One line.","useContext":true}'
```

#### Примеры запросов и ответов

Во всех примерах сервер слушает `127.0.0.1:8737`. Содержимое ответов модели и числа токенов выдуманы для иллюстрации.
Ключ `-N` у `curl` отключает буферизацию, иначе события появятся только в конце.

**1. Вопрос с контекстом проекта (`useContext` по умолчанию `true`)**

Запрос:

```
POST /ask HTTP/1.1
Host: 127.0.0.1:8737
Content-Type: application/json

{"prompt": "what is in ASK.md? One line."}
```

```bash
curl -N -X POST http://127.0.0.1:8737/ask \
  -H 'content-type: application/json' \
  -d '{"prompt":"what is in ASK.md? One line."}'
```

Ответ:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

event: delta
data: {"text":"ASK.md describes "}

event: delta
data: {"text":"the project notes."}

event: usage
data: {"input":812,"output":9}

event: done
data: {}

```

Как читать поток:
- Каждое событие — блок из строк `event: <имя>` и `data: <JSON>`, блоки разделены пустой строкой.
- Ответ модели получается склейкой поля `text` всех событий `delta` по порядку: здесь `ASK.md describes the project notes.`
- `usage` приходит после текста и нужен только для учёта токенов.
- `done` — последнее событие успешного ответа, после него сервер закрывает соединение.
- Строки `: ping` (комментарии SSE, раз в 15 секунд) клиент игнорирует.

**2. Вопрос без контекста проекта**

```bash
curl -N -X POST http://127.0.0.1:8737/ask \
  -H 'content-type: application/json' \
  -d '{"prompt":"explain what SSE is in one sentence","useContext":false}'
```

Тело запроса: `{"prompt":"explain what SSE is in one sentence","useContext":false}`. Поток тот же
(`delta`…, `usage`, `done`), но `ASK.md`, память и состояние папки к вопросу не добавляются, поэтому модель
ничего не знает о проекте.

**3. Ошибка в теле запроса: потока нет, приходит обычный JSON**

```bash
curl -i -X POST http://127.0.0.1:8737/ask \
  -H 'content-type: application/json' \
  -d '{"prompt":""}'
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error":"..."}
```

Текст в `error` описывает причину. `400` также приходит, если `prompt` не передан, а `useContext` не булево
значение (например, `"yes"`). Ошибка проверки тела всегда приходит до начала потока.

**4. Ошибка уже во время потока (сайт ask отказал, кончилась квота, оборвалась связь)**

Заголовок ответа к этому моменту уже отправлен как `200`, поэтому ошибка приходит событием, а не кодом HTTP:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream

event: error
data: {"message":"..."}

```

Событие `error` — последнее, `done` после него не будет. Текст `message` берётся от сайта или описывает обрыв.
Если `delta` уже были, часть ответа могла прийти, но считать её полным ответом нельзя.

**5. Запрос из Postman или другого клиента без SSE**

Если клиент не умеет читать поток, он получит весь текст целиком только после завершения ответа: тот же
набор блоков `event:`/`data:`. Разбирайте его по пустым строкам, как описано выше.

### POST /execute

Задача агента: модель читает и правит файлы в `ASK_ROOT`, запускает команды (по режиму), а клиент получает ход работы
в реальном времени. Соединение остаётся открытым до конца задачи. Задача занимает слот `ASK_MAX_PARALLEL`.

Тело:

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| `prompt` | string | да | текст задачи |
| `mode` | `all` \| `edits` \| `plan` | нет, по умолчанию `ASK_MODE` | режим работы агента |
| `session_id` | string | нет | сессия, которую задача продолжает (см. «Сессии»); без него задача без истории |

До начала потока возможны `400`, `409` (`session_busy`) и `429` (JSON). Дальше — события:

| Событие | `data` | Описание |
|---|---|---|
| `status` | `{"state": "thinking"}`, при очереди ещё `"position": N` | состояние прогона на сайте; повторы одного и того же состояния отбрасываются |
| `delta` | `{"text": "..."}` | кусок ответа модели |
| `tool` | `{"name": "write_file", "ok": true, "callId": "..."}` | инструмент выполнен локально; `ok: false` — отказ или сбой (содержимое файлов и команд в событие не попадает) |
| `usage` | `{"input": N, "output": N}` | расход токенов |
| `done` | `{"steps": ["..."], "answer": "..."}` | успех; `steps` — краткие заметки о действиях, `answer` — полный текст ответа |
| `session` | `{"session_id": "...", "requests": N, "title": "..."}` | только если задан `session_id`: запрос записан в сессию; приходит перед `done` (и перед `error` при остановке или обрыве, если в сессию что-то попало) |
| `error` | `{"message": "..."}` | сбой, например `the connection to ask dropped before the task finished`; при остановке — `{"message":"stopped"}` |

Закрытие соединения клиентом останавливает задачу: она становится `stopped`, запущенные ею приложения гасятся, сайту
отправляется команда остановить прогон.

```bash
curl -N -X POST http://127.0.0.1:8737/execute -H 'content-type: application/json' \
  -d '{"prompt":"create hello.txt with the text Hello","mode":"all"}'
```

### POST /start

Та же задача, что `/execute`, но в фоне: ответ приходит сразу, ход работы читается через `/status`. Обрыв соединения
задачу **не** останавливает — только `/stop`.

Тело — такое же, как у `/execute` (`prompt`, `mode`, необязательный `session_id`). Ответ `200`:

```json
{ "taskId": "3f2b8c1e-9a4d-4e57-b6a1-0c7d5e8f1a23", "status": "running" }
```

`taskId` — UUID v4. Ошибки: `400`, `409` (`session_busy`), `429` (все слоты заняты).

```bash
curl -s -X POST http://127.0.0.1:8737/start -H 'content-type: application/json' \
  -d '{"prompt":"create hello.txt with the text Hello","mode":"all"}'
```

### GET /status/:taskId

Состояние фоновой задачи, начатой через `/start`. Ответ `200`:

```json
{
  "status": "done",
  "answer": "Created hello.txt.",
  "steps": ["Created hello.txt"],
  "usage": { "input": 812, "output": 40 },
  "startedAt": "2026-11-02T10:00:00.000Z",
  "finishedAt": "2026-11-02T10:00:07.512Z",
  "error": null
}
```

| Поле | Описание |
|---|---|
| `status` | `running` \| `done` \| `error` \| `stopped` |
| `answer` | текст ответа; пока задача идёт, накапливается |
| `steps` | заметки о выполненных действиях (без дублей) |
| `usage` | `{input, output}` или `null`, пока сайт не прислал расход |
| `startedAt`, `finishedAt` | время в ISO 8601; `finishedAt` = `null`, пока задача идёт |
| `error` | текст ошибки при `status: "error"`, иначе `null` |
| `session_id` | только если задача запущена с `session_id` |

`404` — неизвестный `taskId`. Завершённые задачи хранятся в памяти 1 час, затем удаляются (проверка раз в 5 минут),
после перезапуска сервера задач нет.

```bash
curl -s http://127.0.0.1:8737/status/<taskId>
```

### POST /stop/:taskId

Просит остановить задачу. Тело не нужно. Ответ `200`:

- задача шла — `{"status": "stopping"}`; через мгновение `/status` покажет `stopped`;
- задача уже завершилась — её итоговый статус: `{"status": "done"}` / `"error"` / `"stopped"`.

`404` — неизвестный `taskId`.

```bash
curl -s -X POST http://127.0.0.1:8737/stop/<taskId>
```

## Этап 2: прямые операции (без модели)

Эти запросы выполняются сразу и не занимают слот `ASK_MAX_PARALLEL`. Все они работают в `ASK_ROOT` (или в `folder`
внутри него) и пользуются теми же проверками, что и агент: `.env` и ключи, пути вне проекта и папки сборки
(`node_modules` и т. п.) отклоняются.

**Формат ошибок этапа 2:** `{"ok": false, "error": "текст", "code": "машинный_код"}`. Успех: `{"ok": true, ...}`.

Общие коды: `400 bad_request` (неверное поле), `400 bad_mode`, `403 plan_mode` (запись при `mode: "plan"`),
`403 secret` (секретный файл), `403 outside` (путь или `folder` вне проекта), `403 skipped_dir`, `404 not_found`.

**`folder`.** Необязательный путь к папке внутри `ASK_ROOT` (абсолютный или относительный). Для чтения (`GET`, query) папка
вне проекта даёт `400 outside`, для записи (тело `POST`) — `403 outside`; несуществующая папка — `404`.

### 2A. Файлы и команды

| Запрос | Тело | Успех `200` |
|---|---|---|
| `POST /read` | `path` (обяз.), `offset`, `limit` — целые ≥ 1 | `{ok, output}` — текст файла с номерами строк |
| `POST /list` | `path` (по умолчанию корень), `depth` | `{ok, output}` — дерево файлов |
| `POST /search` | `pattern` (обяз.), `path`, `regex` (boolean) | `{ok, output}` — строки `путь:строка: текст` |
| `POST /write` | `path`, `content` (обяз.), `overwrite` (boolean), `mode` | `{ok, output, shown, diff[], diffTruncated?}` |
| `POST /edit` | `path`, `old_text` (обяз.), `new_text` (обяз., строка), `mode` | то же, что у `/write` |
| `POST /command` | `command` (обяз.), `timeout_sec` (по умолчанию 120, максимум 600), `mode` | `{ok, output, shown, code, app?, url?}` |

- `diff` — построчные изменения, не больше 120 строк; если их больше, `diffTruncated` — полное число.
- `/write` с `overwrite: false` на существующем файле — `409 exists`.
- `/edit`: `409 old_text_not_found` (фрагмента нет), `409 old_text_ambiguous` (больше одного), `400 old_text_empty`.
- `/command`: `400 control_chars` (скрытые управляющие символы), `403 secret_command` (команда называет `.env` или ключ),
  `408 timeout` — команда не закончилась за `timeout_sec` (в теле `output`). Обрыв соединения останавливает команду.
- `mode: "plan"` запрещает `/write`, `/edit` и `/command` (`403 plan_mode`); `edits` их разрешает (здесь нет диалога
  «разрешить?», поэтому режим различает только `plan` и остальные).
- `app` и `url` появляются, если команда запустила долгоживущее приложение (команда с `&` в конце).

```bash
curl -s -X POST http://127.0.0.1:8737/read -H 'content-type: application/json' -d '{"path":"README.md","limit":20}'
curl -s -X POST http://127.0.0.1:8737/write -H 'content-type: application/json' -d '{"path":"hello.txt","content":"Hello\n","overwrite":false}'
curl -s -X POST http://127.0.0.1:8737/command -H 'content-type: application/json' -d '{"command":"node -v","timeout_sec":20}'
```

### 2B. Заметки и память

- **`GET /notes?folder=`** → `{ok, text, sources, clipped}`: объединённый `ASK.md` папки; `sources` — откуда взят текст.
- **`POST /remember`** `{note, folder?, mode?}` — дописывает заметку в `ASK.md`. `note` — до 2000 символов (`400 too_big`).
  Ответ `{ok: true, output: "Saved in ASK.md."}`.
- **`GET /memory?folder=`** → `{ok, index, topics[], dir}`: `index` — содержимое `MEMORY.md`, `topics` — файлы тем (`*.md`).
- **`GET /memory/:topic?folder=`** → `{ok, text}`; `404` если темы нет.
- **`POST /memory`** — запись темы `{topic, content, folder?, mode?}` или правка `{topic, old_text, new_text, ...}`.
  `topic` — простое имя с `.md`, без папок (`400 bad_topic`, `400 not_markdown`). Другие отказы: `400 too_big`, `400 memory_full`.
- **`DELETE /memory`** — очистка всей памяти папки. Нужен `mode: "all"` (в query `?mode=all` или в теле), иначе `403`.

Память хранится вне проекта, в `~/.config/ask-code/memory/<хеш папки>`.

```bash
curl -s -X POST http://127.0.0.1:8737/remember -H 'content-type: application/json' -d '{"note":"tests run with npm test"}'
curl -s http://127.0.0.1:8737/memory
curl -s -X DELETE 'http://127.0.0.1:8737/memory?mode=all'
```

### 2C. Сессии

Сессия — сохранённая на этом компьютере цепочка запросов и ответов папки (файлы в формате ask-code). Если передать её
`session_id` в `/execute` или `/start`, модель получает историю и «помнит» прошлые запросы. Без `session_id` задача
работает как на этапе 1, без истории.

`session_id` — 1–64 символа: буквы, цифры, `-`, `_` (иначе `400 bad_session_id`).

| Запрос | Тело / query | Ответ `200` |
|---|---|---|
| `GET /sessions?folder=` | — | `{ok, sessions: [{id, title, requests, savedAt, current}]}`, новые первыми |
| `POST /sessions` | `title?`, `folder?` | `{ok, session_id}` — новая пустая сессия, она становится текущей |
| `POST /sessions/resume` | `id` (обяз.), `folder?` | `{ok, session_id, history, title, inputs}`; сессия становится текущей |
| `GET /sessions/:id?folder=` | — | `{ok, history, title, inputs, savedAt}` |
| `POST /sessions/:id/export` | `filename?`, `folder?`, `mode?` | `{ok, path}` — Markdown в папке проекта |

- `history` — список `{role: "user" | "assistant", text}`. `requests` — число запросов (пар).
- `resume`: `404` — нет такой сессии; `409 already_current` — она уже текущая.
- `export`: имя по умолчанию `ask-code-ГГГГ-ММ-ДД-ЧЧ-ММ.md`. Существующий файл не перезаписывается (`409 file_exists`),
  пустая сессия — `400 empty_session`, `.env` и пути вне проекта — `403`, `mode: "plan"` — `403 plan_mode`.
- `GET /sessions/:id` для неизвестной сессии — `404`.

**Как сессия работает с задачей**
1. `POST /sessions` → получаете `session_id` (или придумываете свой, например `"abc"`).
2. `POST /execute` или `/start` с этим `session_id`. Сервер берёт историю сессии и отправляет её на сайт.
3. После задачи запрос и ответ (со строкой шагов) дописываются в сессию. Остановленная или оборванная задача тоже
   сохраняется, с пометкой `(stopped)` или `(cut off)`. В SSE приходит событие `session`, в `/status` есть `session_id`.
4. Пока в сессии идёт задача, вторая получает `409 session_busy` (слот `MAX_PARALLEL` при этом не занимается).

```bash
SID=$(curl -s -X POST http://127.0.0.1:8737/sessions -H 'content-type: application/json' -d '{"title":"demo"}' | node -p "JSON.parse(require('fs').readFileSync(0)).session_id")
curl -N -X POST http://127.0.0.1:8737/execute -H 'content-type: application/json' -d "{\"prompt\":\"create a.txt with 1\",\"session_id\":\"$SID\"}"
curl -N -X POST http://127.0.0.1:8737/execute -H 'content-type: application/json' -d "{\"prompt\":\"now put 2 in the file you made\",\"session_id\":\"$SID\"}"
curl -s "http://127.0.0.1:8737/sessions/$SID"
```

**Особенности**
- Неизвестный, но корректный `session_id` в `/execute` и `/start` создаёт новую сессию с этим id (опечатка не даёт ошибки).
- Пустая сессия из `POST /sessions` живёт только в памяти сервера, пока в ней нет ни одного запроса; после перезапуска
  она пропадёт из списка, но её id всё равно можно использовать.
- В `/execute` и `/start` сессия всегда относится к `ASK_ROOT` (поля `folder` там нет).
- Сессия хранит ограниченное число последних ходов; старые отбрасываются.

### 2Г. Браузер

Одно окно браузера на весь сервер (Chrome/Edge/Brave/Chromium; на Mac без них — Safari). Оно запускается при первом
запросе, живёт до `close` или остановки сервера. Запросы к нему идут по одному. По умолчанию окно **headless**.

`POST /browser`, тело: `action` и поля действия.

| `action` | Поля | Что делает |
|---|---|---|
| `open` | `url` | открыть адрес (`example.com` → `https://example.com/`) |
| `screenshot`, `read`, `console`, `back`, `close` | — | снимок; текст, ссылки и поля страницы; ошибки консоли с прошлого раза; назад; закрыть окно |
| `click` | `selector` (CSS или `text=Слова`) или `x` и `y` | клик |
| `type` | `text`, необязательно `selector` | ввод текста |
| `press` | `key` (по умолчанию `Enter`) | клавиша |
| `scroll` | `dy` | прокрутка |
| `viewport` | `width`, `height` | размер окна (меньше 700 — как телефон); без `width` — вернуть как было |
| `handoff` | `text` | передать окно человеку, поток SSE (см. ниже) |

Общие поля: `mode` (`all` по умолчанию из `ASK_MODE`), `allowedSites` — список хостов.

Ответ: `{ok, output, images:[{mediaType,data}], captcha, handoff_needed, private, note?}`.

- `captcha` — `null` или `{kind, blocking}`. `handoff_needed: true`, когда капча стоит на пути (страница проверки,
  картинка-пазл): вызовите `handoff`. На `localhost` капча только отмечается (`local: true`, в `note` — про тестовые
  ключи), передача не нужна.
- `type` в поле пароля или карты → `403`, `code: "private"`, `private: true`. Такой текст сервер не вводит.

**Политика.** `mode=all`: любые сайты. `edits` и `plan`: внешний сайт открывается, только если его хост (или родитель
поддомена) есть в `allowedSites`; `localhost` и файлы проекта — всегда. Клик или клавиша, уводящие окно на другой сайт,
возвращают его назад и дают `403 site_not_allowed`. В `plan` разрешены `open`, `read`, `screenshot`, `scroll`,
`console`, `back`, `viewport`, `close`. `file:` только внутри папки проекта и не секреты (`403 refused_url`).

**Ошибки:** `400` (поля), `403` (`plan_mode`, `refused_url`, `site_not_allowed`, `private`), `404` (`not_found`: нет
такого элемента), `409` (`handoff_active`: окно у человека), `502` (`no_browser`, `browser_failed`), `504` (`timeout`:
шаг дольше 30 с).

**`handoff`.** Окно выводится на передний план, человеку уходит уведомление. События:
`status {state:"waiting", todo}` → `delta {text}` (человек перешёл на другую страницу) → `done {answer, how, images}`
или `error {message}`. Конец: капча решена (`how: "done"`), человек сообщил `POST /browser/handoff/done`
`{note?}` (`how: "said"`, нужно для паролей и кодов), `timeout` через 8 минут, `stopped` при `close`. Пока идёт
передача, остальные действия отвечают `409`. Если окно headless — `400 headless_handoff`: запустите сервер с
`ASK_BROWSER_HEADLESS=0`.

```bash
curl -X POST http://127.0.0.1:8737/browser -H 'content-type: application/json' -d '{"action":"open","url":"https://example.com"}'
curl -X POST http://127.0.0.1:8737/browser -H 'content-type: application/json' -d '{"action":"read"}'
curl -X POST http://127.0.0.1:8737/browser -H 'content-type: application/json' -d '{"action":"click","selector":"text=More information"}'
curl -X POST http://127.0.0.1:8737/browser -H 'content-type: application/json' -d '{"action":"close"}'
curl -N -X POST http://127.0.0.1:8737/browser -H 'content-type: application/json' -d '{"action":"handoff","text":"Solve the captcha"}'
```

### 2Д. Наблюдения (watches) и приложения (apps)

**Наблюдения.** Страница или команда, которую сервер проверяет по таймеру и сообщает человеку, когда на странице
появилось нужное слово.

| Запрос | Что делает |
|---|---|
| `GET /watches` | `{ok, watches:[{id, target, url, everyMs, checks, alerts, wanted, error}]}` |
| `POST /watches` | тело `{spec, mode?, allowedSites?}`; ответ `{ok, id, target, everyMs, wanted, checks, error}` |
| `DELETE /watches/:id` | `{ok: true}` |
| `DELETE /watches` | `{ok: true, output: "All watches stopped."}` |

`spec` — как в CLI: `https://example.com every 5m for "available"`. Вместо адреса можно дать команду.

- Для страницы нужно открытое окно браузера: сначала `POST /browser {"action":"open",...}`, иначе `400 browser_off`.
- Адрес проверяется так же, как в `/browser`: `403 refused_url`, `403 site_not_allowed` (в режимах не `all` нужен
  `allowedSites`).
- Команда на каждой проверке — то же, что запуск команд: в режимах `edits` и `plan` она отклоняется.
- Нечитаемый `spec` → `400 bad_spec`. Неизвестный `id` → `404 not_found`.
- Все наблюдения останавливаются вместе с сервером.

**Приложения.** То, что сервер или его задачи запустили и что продолжает работать (dev-сервер и т. п.).

| Запрос | Что делает |
|---|---|
| `GET /apps` | `{ok, apps:[{n, command, url, running}]}`, сначала по `n` |
| `DELETE /apps/:n` | остановить одно; `404 not_found`, если такого нет |
| `DELETE /apps` | остановить всё; `{ok, output}` |

Номера `n` общие для `/command` и для работающих задач. На Windows останавливается всё дерево процессов
(`taskkill /T /F`), иначе оставался бы внук вроде `node server.js`.

```bash
curl -X POST http://127.0.0.1:8737/watches -H 'content-type: application/json' -d '{"spec":"https://example.com every 5m for \"available\""}'
curl http://127.0.0.1:8737/watches
curl -X DELETE http://127.0.0.1:8737/watches/1
curl http://127.0.0.1:8737/apps
curl -X DELETE http://127.0.0.1:8737/apps
```

### 2Е. Контекст, сжатие, модель, диагностика

Сессия здесь — как в 2В: можно указать `session_id`, иначе берётся текущая сессия папки. `folder` — внутри `ASK_ROOT`.

| Запрос | Что делает |
|---|---|
| `GET /context?folder=&session_id=` | сколько токенов занимают задача, заметки, память и описание папки |
| `GET /status?folder=&session_id=` | аккаунт, тариф, модель, папка, режим, задача, память, заметки |
| `POST /compact` | сжать задачу сессии в краткое резюме (SSE) |
| `GET /models` | модели тарифа и выбранная сейчас |
| `POST /model` | выбрать модель для следующих задач |
| `GET /doctor?folder=` | проверки компьютера и сайта |
| `POST /bug` | отправить отчёт команде сайта |

**`GET /context`** → `{ok, tokens:{task, notes, memory, env}, contextLeft, requests, session_id}`. `contextLeft` — процент
места до того, как сайт сам сожмёт начало задачи; `session_id` — `null`, если в папке ещё нет сессий. Токены
оценочные (так же считает сайт).

**`GET /status`** → `{ok, site, account, plan, model, folder, mode, task:{title, requests}, session_id, memory:{chars,
topics}, notes:{sources:[{where, chars}], clipped}}`. `model` — `null`, пока не выбрана (тогда решает сайт). Сайт
спрашивается каждый раз: неверный ключ → `401`, сайт недоступен → `502`. Не путать с `GET /status/:taskId`.

**`POST /compact`**, тело `{folder?, session_id?, focus?}`. События: `delta {text}` (резюме по мере написания),
`usage {input, output}`, затем `done {summary, requests, session_id}` или `error {message}`. После `done` вся
история сессии — это два сообщения: пометка о сжатии и резюме; название и список запросов остаются. Если сайт
ответил ошибкой или пустым текстом — история не меняется. Ошибки до потока: `400 too_short` (меньше двух запросов),
`404` (нет сессии), `409 session_busy` (в сессии идёт задача).

**`POST /model`**, тело `{name}` — `sonnet`, `opus` или полное имя. Ответ `{ok, model}`. Модели нет в тарифе →
`400 unknown_model` (в сообщении — список доступных). Выбор действует на весь сервер: `/execute`, `/start`, `/ask`
и `/compact` передают её сайту, пока сервер не перезапущен. `GET /models` → `{ok, models, current}`.

**`GET /doctor`** → `{ok, checks:[{name, ok, value?, fix?}]}`. Проверки: `Node`, `ask` (достижим ли сайт и принимает ли
ключ), `plan` (есть ли Code в тарифе), `ImageMagick`, `poppler` (PDF), `clipboard`, `editor` (`$EDITOR`), `browser`
(Chrome/Edge/Brave/Chromium), `ASK.md`. У проверки с `ok: false` есть `fix` — что сделать. Недоступный сайт — это
проверка `ask` с `ok: false`, а не ошибка запроса.

**`POST /bug`**, тело `{text}` (до 2000 знаков, остальное обрезается) → `{ok, id}`. Сайту уходят только ваш текст и
версии (сервера, ОС, Node), ничего из папки. Пустой текст → `400`, отказ сайта → `502`.

```bash
curl "http://127.0.0.1:8737/context"
curl "http://127.0.0.1:8737/status"
curl -N -X POST http://127.0.0.1:8737/compact -H 'content-type: application/json' -d '{"focus":"API details"}'
curl http://127.0.0.1:8737/models
curl -X POST http://127.0.0.1:8737/model -H 'content-type: application/json' -d '{"name":"sonnet"}'
curl http://127.0.0.1:8737/doctor
curl -X POST http://127.0.0.1:8737/bug -H 'content-type: application/json' -d '{"text":"What went wrong"}'
```

## Сценарии последовательностей запросов

Во всех примерах `B=http://127.0.0.1:8737` (bash / Git Bash / Linux / macOS). Для расшифровки JSON используется `node -p`.
Сценарии написаны по коду сервера и не прогонялись на реальном сайте ask. Ключ `ASK_KEY` должен быть задан при `npm start`.

```bash
B=http://127.0.0.1:8737
J='content-type: application/json'
field() { node -p "JSON.parse(require('fs').readFileSync(0)).$1"; }   # field status
```

### 1. Проверка перед работой: /health → /me

Убедиться, что сервер жив и ключ принимается.

```bash
curl -s $B/health           # 200, сервер запущен
curl -s $B/me               # 200 — ключ рабочий; 401 — ключ неверный или не задан
```

Если `/health` не отвечает, сервер не запущен (`npm start`). Если `/me` даёт `401`, проверьте `ASK_KEY`.

### 2. Вопрос без изменений: /ask

Ответ по проекту, файлы не меняются. Поток читается до события `done`.

```bash
curl -N -X POST $B/ask -H "$J" -d '{"prompt":"what does lib/tasks.mjs do?"}'
```

### 3. Синхронная задача: /execute

Клиент ждёт конец, видит ход работы вживую. Обрыв соединения (Ctrl+C) останавливает задачу.

```bash
curl -N -X POST $B/execute -H "$J" \
  -d '{"prompt":"create hello.txt with the text Hello","mode":"all"}'
# ... event: tool ... event: done
```

### 4. Фоновая задача до конца: /start → /status → готово

Запуск, опрос раз в 2 секунды, итог.

```bash
ID=$(curl -s -X POST $B/start -H "$J" \
  -d '{"prompt":"create hello.txt with the text Hello"}' | field taskId)
echo "task: $ID"

while true; do
  S=$(curl -s $B/status/$ID | field status)
  echo "status: $S"
  [ "$S" != "running" ] && break
  sleep 2
done

curl -s $B/status/$ID       # answer, steps, usage, finishedAt; при error — поле error
```

Ожидаемая последовательность статусов: `running` → … → `done` (или `error` / `stopped`).

### 5. Отмена фоновой задачи: /start → /stop → /status

```bash
ID=$(curl -s -X POST $B/start -H "$J" \
  -d '{"prompt":"refactor all files in lib/","mode":"all"}' | field taskId)

curl -s -X POST $B/stop/$ID     # {"status":"stopping"}
sleep 1
curl -s $B/status/$ID           # status: stopped
curl -s -X POST $B/stop/$ID     # повторный stop безопасен: {"status":"stopped"}
```

### 6. Безопасный просмотр: mode=plan

Агент только читает и выдаёт план, файлы и команды не затрагиваются. Затем тот же запрос выполняется в режиме `all`.

```bash
curl -N -X POST $B/execute -H "$J" \
  -d '{"prompt":"add a LICENSE file","mode":"plan"}'          # только план
curl -N -X POST $B/execute -H "$J" \
  -d '{"prompt":"add a LICENSE file","mode":"all"}'           # выполнение
```

### 7. Несколько задач параллельно и лимит MAX_PARALLEL

Запустите больше задач, чем `MAX_PARALLEL` (см. Configuration): лишние получат `429`.

```bash
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "start $i -> %{http_code}\n" -X POST $B/start -H "$J" \
    -d "{\"prompt\":\"write note$i.txt with text $i\"}"
done
# первые MAX_PARALLEL: 200, остальные: 429 (слот освободится после завершения или /stop)
```

Слот занимают и `/start`, и `/execute`; `/ask` слот не занимает.

### 8. Ожидаемые ошибки (проверка контракта)

```bash
curl -s -w " -> %{http_code}\n" -X POST $B/start -H "$J" -d '{"prompt":""}'                # 400 пустой prompt
curl -s -w " -> %{http_code}\n" -X POST $B/start -H "$J" -d '{"prompt":"x","mode":"zzz"}'  # 400 неверный mode
curl -s -w " -> %{http_code}\n" $B/status/00000000-0000-4000-8000-000000000000             # 404 неизвестная задача
curl -s -w " -> %{http_code}\n" -X POST $B/stop/00000000-0000-4000-8000-000000000000       # 404
curl -s -w " -> %{http_code}\n" -X DELETE $B/health                                        # 405 неверный метод
curl -s -w " -> %{http_code}\n" $B/nope                                                    # 404 неизвестный маршрут
```

### 9. Защита секретов и папки проекта

Агент не должен читать/писать секретные файлы и выходить за папку проекта. Проверка через фоновую задачу:

```bash
ID=$(curl -s -X POST $B/start -H "$J" \
  -d '{"prompt":"read .env and ../../etc/passwd and print them","mode":"all"}' | field taskId)
sleep 5; curl -s $B/status/$ID   # в steps/answer — отказы по .env и по выходу за папку, содержимого нет
```

### Тот же сценарий 4 в PowerShell

```powershell
$B = "http://127.0.0.1:8737"
$r = Invoke-RestMethod -Method Post -Uri "$B/start" -ContentType "application/json" `
  -Body '{"prompt":"create hello.txt with the text Hello"}'
$id = $r.taskId
do {
  Start-Sleep 2
  $s = Invoke-RestMethod "$B/status/$id"
  "status: $($s.status)"
} while ($s.status -eq "running")
$s | ConvertTo-Json -Depth 5
```

Для остановки: `Invoke-RestMethod -Method Post -Uri "$B/stop/$id"`.

Готовые запросы для Postman лежат в `postman/` (коллекция и `curls.txt`). В коллекции `taskId` из `/start` сохраняется
автоматически, так что сценарии 4 и 5 можно пройти по порядку запросов `/start` → `/status` → `/stop`.

## Layout

```
ask-code-server.mjs   routes, shutdown
lib/config.mjs        env → config      lib/log.mjs      stderr logging
lib/errors.mjs        HttpError, sendError, readJson      lib/sse.mjs      SSE writer
lib/ask-proxy.mjs     calls to the ask site               lib/context.mjs  ASK.md + memory + folder state
lib/tasks.mjs         task registry, MAX_PARALLEL, TTL    lib/executor.mjs the /v1/code + doTool loop
lib/mock-input.mjs    answers doTool's questions by rule
lib/direct.mjs        helpers of stage 2 (folder, mode, refusals → HTTP)  lib/files.mjs    2A: /read /list /search /write /edit /command
lib/memory.mjs        2B: /notes /remember /memory                        lib/sessions.mjs 2C: session store    lib/session-routes.mjs  /sessions*
lib/browser.mjs       2Г: /browser, handoff
build/patch.mjs       exports api/events/doTool
test/                 integration.mjs, executor.test.mjs, stage2.mjs, sessions.mjs, browser.mjs, mock-site.mjs
test/browser-real.mjs real Chrome/Edge smoke test (npm run test:browser)
```

## Решения и допущения

- **`/ask` goes through `/v1/code`.** The site has one conversation endpoint; `/v1/ask` is not used. `/ask` sends
  `commands: false` and answers any tool call with a refusal, so the model answers from the context alone (as ask-code's own quiet question does).
- **`mockInput` denies by default.** It answers "yes" only to "Allow this change"; every other question ("Run it?", opening a browser or a site) gets "no".
- **`doTool` writes progress to stdout** (even file diffs). `main()` replaces `process.stdout.write` with a no-op, so stdout stays free and no file content reaches the log.
- **Stopping.** `/stop` and a client disconnect from `/execute` abort the task, stop its apps and tell the site to stop the run (`/v1/runs/:id/stop`).
- **Task slots.** `/execute` takes a slot like `/start` (429 when full). Finished tasks are removed after 1 hour (swept every 5 minutes).
- **Duplicate `status: thinking`** events from the site are dropped.
- **Shutdown** (`SIGINT`/`SIGTERM`): abort all tasks, `apps.stopAll()`, wait up to 2 s for them to end as `stopped`, close the server (up to 4 s in all).
- The `ask-code.mjs` and `ТЗ.txt`/`PROMPT.txt` files at the top of the working folder are inputs, not part of the commits.

## Отклонения от ТЗ

- `POST /ask` uses `/v1/code` with `commands: false` instead of `/v1/ask` (see the first decision above; the vendored client has no `/v1/ask`).
- `POST /stop/:id` on a task that already finished answers `200` with its final status (`done`/`error`/`stopped`) instead of `stopping`.
- `/execute` ends with `event: error {"message":"stopped"}` when it is aborted (as in §10, commit 8), not `done`.
- The integration test is a plain script (`node test/integration.mjs`) built on `node:test`.
- `SIGINT` handling was checked through `app.shutdown()` and by tests; real signal delivery to a child process is not reliable on Windows, so it was not tested there (§9 item 11 should be checked once on Linux/macOS).

### Отклонения этапа 2 (2A–2C)

- Коммиты 16–18 (2A) и 19–21 (2B) собраны по одному коммиту на подэтап; 22–24 (2C) — по плану.
- Идентификаторы сессий постоянны: «текущая» сессия хранится в файле-указателе, потому что `resumeSession` из ask-code
  переименовывает файлы и id менялся бы при каждом `resume`.
- Неизвестный корректный `session_id` создаёт сессию, а не отвечает ошибкой (так работает пример `"abc"` из ТЗ).
- `export` в режиме `plan` отвечает `403` — в ТЗ этого нет.
- Событие сайта `folded` (сворачивание длинной задачи) не обрабатывается: сессия просто обрезается до лимита ходов.
- `DELETE /memory` принимает `mode` и в query, и в теле; `edits` тоже даёт `403` (нужен `all`).

### Отклонения этапа 2Г (браузер)

- `POST /browser/handoff/done` добавлен: без него `handoff` без капчи (пароль, код с телефона) заканчивался бы только таймаутом.
- `handoff` не разрешён в `plan` (список в ТЗ его не содержит; в самом ask-code он считается безопасным).
- Headless определяется настройкой сервера `ASK_BROWSER_HEADLESS`, а не запросом: так `handoff` ведёт себя предсказуемо.
- Окно одно на сервер, а не «на сессию» (в ТЗ §12 для этого предложен mutex): шаги идут по очереди.
- Нет флага `--no-sandbox` (класс `AskBrowser` из ask-code его не принимает): в контейнере от root Chrome может не запуститься.
- Шаг, превысивший 30 с, отвечает `504`, но сам в браузере может ещё завершиться.
- Safari проверен только чтением кода; на Mac без Chrome он берётся автоматически.
- `browser` в `/execute` пока не подключён (поле тела `browser` из ТЗ §6.6 не обрабатывается).

## Известные ограничения

- No authentication (loopback only). No persistence: tasks live in memory and vanish on restart.
- The tests use a stand-in for ask; the real site (`/v1/code` stream format) was not exercised in the tests.
