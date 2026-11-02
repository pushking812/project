# ask-code-mcp — описание API этапа 2

Полное описание эндпоинтов этапа 2 с примерами `curl`, кодами ошибок и отклонениями от ТЗ. Этап 1 (`/health`, `/me`,
`/ask`, `/execute`, `/start`, `/status/:taskId`, `/stop/:taskId`), настройка и сценарии — в [api-stage1.md](api-stage1.md).

## Установка и запуск

Нужны Node ≥ 18 и ключ ask (тариф Plus и выше). Зависимостей npm нет.

```bash
cd project
export ASK_KEY=sk-ask-...        # Windows cmd: set ASK_KEY=...
npm start                        # http://127.0.0.1:8737
npm test                         # тесты на заглушке сайта, ключ не нужен
curl http://127.0.0.1:8737/health
```

Для `POST /browser` нужен Chrome, Edge, Brave или Chromium (на Mac допускается Safari). Для `handoff` запустите сервер
с `ASK_BROWSER_HEADLESS=0`. Реальный браузер проверяет `npm run test:browser`.

## Общие правила

- Адрес `http://127.0.0.1:8737`, тела — JSON, аутентификации нет (только локальный доступ).
- Успех: `{"ok": true, ...}`. Ошибка: `{"ok": false, "error": "текст", "code": "код"}`.
- Поле `mode`: `all` | `edits` | `plan`. `plan` запрещает любую запись и команды (`403 plan_mode`).
- Секреты (`.env`, ключи) и папки сборки отклоняются во всех режимах (`403 secret`, `403 skipped_dir`).
- Примеры ниже коротко пишут `H='content-type: application/json'` и `U=http://127.0.0.1:8737`.

```bash
U=http://127.0.0.1:8737
H='content-type: application/json'
```

Эти запросы выполняются сразу и не занимают слот `ASK_MAX_PARALLEL`. Все они работают в `ASK_ROOT` (или в `folder`
внутри него) и пользуются теми же проверками, что и агент: `.env` и ключи, пути вне проекта и папки сборки
(`node_modules` и т. п.) отклоняются.

Общие коды: `400 bad_request` (неверное поле), `400 bad_mode`, `403 plan_mode` (запись при `mode: "plan"`),
`403 secret` (секретный файл), `403 outside` (путь или `folder` вне проекта), `403 skipped_dir`, `404 not_found`.

**`folder`.** Необязательный путь к папке внутри `ASK_ROOT` (абсолютный или относительный). Для чтения (`GET`, query) папка
вне проекта даёт `400 outside`, для записи (тело `POST`) — `403 outside`; несуществующая папка — `404`.

## Все эндпоинты этапа 2

| # | Запрос | Подэтап | Назначение |
|---|---|---|---|
| 1 | `POST /read` | 2A | прочитать файл с номерами строк |
| 2 | `POST /list` | 2A | дерево файлов |
| 3 | `POST /search` | 2A | поиск по файлам |
| 4 | `POST /write` | 2A | записать файл, ответ с diff |
| 5 | `POST /edit` | 2A | заменить фрагмент в файле |
| 6 | `POST /command` | 2A | выполнить команду |
| 7 | `GET /notes` | 2B | заметки `ASK.md` |
| 8 | `POST /remember` | 2B | дописать заметку |
| 9 | `GET /memory` | 2B | индекс и темы памяти |
| 10 | `GET /memory/:topic` | 2B | одна тема |
| 11 | `POST /memory` | 2B | записать или поправить тему |
| 12 | `DELETE /memory` | 2B | очистить память |
| 13 | `GET /sessions` | 2C | список сессий |
| 14 | `POST /sessions` | 2C | новая сессия |
| 15 | `POST /sessions/resume` | 2C | сделать сессию текущей |
| 16 | `GET /sessions/:id` | 2C | история сессии |
| 17 | `POST /sessions/:id/export` | 2C | выгрузка в Markdown |
| 18 | `POST /browser` | 2Г | действия браузера, `handoff` — SSE |
| 19 | `POST /browser/handoff/done` | 2Г | завершить передачу окна (расширение) |
| 20 | `GET /watches` | 2Д | список наблюдений |
| 21 | `POST /watches` | 2Д | создать наблюдение |
| 22 | `DELETE /watches/:id` | 2Д | остановить одно |
| 23 | `DELETE /watches` | 2Д | остановить все |
| 24 | `GET /apps` | 2Д | запущенные приложения |
| 25 | `DELETE /apps/:n` | 2Д | остановить одно |
| 26 | `DELETE /apps` | 2Д | остановить все |
| 27 | `GET /context` | 2Е | токены и остаток контекста |
| 28 | `GET /status` | 2Е | аккаунт, модель, папка, память |
| 29 | `POST /compact` | 2Е | сжать историю сессии (SSE) |
| 30 | `GET /models` | 2Е | модели тарифа |
| 31 | `POST /model` | 2Е | выбрать модель |
| 32 | `GET /doctor` | 2Е | диагностика |
| 33 | `POST /bug` | 2Е | отчёт об ошибке |

Кроме того, `/execute` и `/start` принимают `session_id` (см. 2C), `browser` (булево: у задачи своё окно браузера) и `allowedSites` (см. 2Г).

## 2A. Файлы и команды

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
curl -s -X POST $U/read    -H "$H" -d '{"path":"README.md","limit":20}'
curl -s -X POST $U/list    -H "$H" -d '{"path":".","depth":2}'
curl -s -X POST $U/search  -H "$H" -d '{"pattern":"TODO","regex":false}'
curl -s -X POST $U/write   -H "$H" -d '{"path":"hello.txt","content":"Hello\n","overwrite":false}'
curl -s -X POST $U/edit    -H "$H" -d '{"path":"hello.txt","old_text":"Hello","new_text":"Hi"}'
curl -s -X POST $U/command -H "$H" -d '{"command":"node -v","timeout_sec":20}'
```

## 2B. Заметки и память

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
curl -s $U/notes
curl -s -X POST $U/remember -H "$H" -d '{"note":"tests run with npm test"}'
curl -s $U/memory
curl -s $U/memory/stage2.md
curl -s -X POST $U/memory -H "$H" -d '{"topic":"stage2.md","content":"# Notes\n"}'
curl -s -X DELETE "$U/memory?mode=all"
```

## 2C. Сессии

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
SID=$(curl -s -X POST $U/sessions -H "$H" -d '{"title":"demo"}' | node -p "JSON.parse(require('fs').readFileSync(0)).session_id")
curl -N -X POST $U/execute -H "$H" -d "{\"prompt\":\"create a.txt with 1\",\"session_id\":\"$SID\"}"
curl -N -X POST $U/execute -H "$H" -d "{\"prompt\":\"now put 2 in the file you made\",\"session_id\":\"$SID\"}"
curl -s $U/sessions
curl -s $U/sessions/$SID
curl -s -X POST $U/sessions/resume -H "$H" -d "{\"id\":\"$SID\"}"
curl -s -X POST $U/sessions/$SID/export -H "$H" -d '{"filename":"demo.md"}'
```

**Особенности**
- Неизвестный, но корректный `session_id` в `/execute` и `/start` создаёт новую сессию с этим id (опечатка не даёт ошибки).
- Пустая сессия из `POST /sessions` живёт только в памяти сервера, пока в ней нет ни одного запроса; после перезапуска
  она пропадёт из списка, но её id всё равно можно использовать.
- В `/execute` и `/start` сессия всегда относится к `ASK_ROOT` (поля `folder` там нет).
- Сессия хранит ограниченное число последних ходов; старые отбрасываются.

## 2Г. Браузер

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
curl -s -X POST $U/browser -H "$H" -d '{"action":"open","url":"https://example.com"}'
curl -s -X POST $U/browser -H "$H" -d '{"action":"read"}'
curl -s -X POST $U/browser -H "$H" -d '{"action":"click","selector":"text=More information"}'
curl -s -X POST $U/browser -H "$H" -d '{"action":"screenshot"}'
curl -s -X POST $U/browser -H "$H" -d '{"action":"close"}'
# передача окна человеку (SSE), нужен ASK_BROWSER_HEADLESS=0
curl -N -X POST $U/browser -H "$H" -d '{"action":"handoff","text":"Solve the captcha"}'
curl -s -X POST $U/browser/handoff/done -H "$H" -d '{"note":"logged in"}'
```

## 2Д. Наблюдения (watches) и приложения (apps)

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
curl -s -X POST $U/browser -H "$H" -d '{"action":"open","url":"https://example.com"}'
curl -s -X POST $U/watches -H "$H" -d '{"spec":"https://example.com every 5m for \"available\""}'
curl -s $U/watches
curl -s -X DELETE $U/watches/1
curl -s -X POST $U/command -H "$H" -d '{"command":"node serve.mjs &"}'
curl -s $U/apps
curl -s -X DELETE $U/apps/1
curl -s -X DELETE $U/apps
```

## 2Е. Контекст, сжатие, модель, диагностика

Сессия здесь — как в 2C: можно указать `session_id`, иначе берётся текущая сессия папки. `folder` — внутри `ASK_ROOT`.

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
проверка `ask` с `ok: false`, а не ошибка запроса (всегда `200`).

**`POST /bug`**, тело `{text}` (до 2000 знаков, остальное обрезается) → `{ok, id}`. Сайту уходят только ваш текст и
версии (сервера, ОС, Node), ничего из папки. Пустой текст → `400`, отказ сайта → `502`.

```bash
curl -s $U/context
curl -s $U/status
curl -N -X POST $U/compact -H "$H" -d '{"focus":"API details"}'
curl -s $U/models
curl -s -X POST $U/model -H "$H" -d '{"name":"sonnet"}'
curl -s $U/doctor
curl -s -X POST $U/bug -H "$H" -d '{"text":"What went wrong"}'
```

## Отклонения от ТЗ этапа 2

**2A–2C**
- Коммиты 16–18 (2A) и 19–21 (2B) собраны по одному коммиту на подэтап; 22–24 (2C) — по плану.
- Идентификаторы сессий постоянны: «текущая» сессия хранится в файле-указателе, потому что `resumeSession` из ask-code
  переименовывает файлы и id менялся бы при каждом `resume`.
- Неизвестный корректный `session_id` создаёт сессию, а не отвечает ошибкой (так работает пример `"abc"` из ТЗ).
- `export` в режиме `plan` отвечает `403` — в ТЗ этого нет.
- Событие сайта `folded` (сворачивание длинной задачи) не обрабатывается: сессия просто обрезается до лимита ходов.
- `DELETE /memory` принимает `mode` и в query, и в теле; `edits` тоже даёт `403` (нужен `all`).

**2Г (браузер)**
- `POST /browser/handoff/done` добавлен: без него `handoff` без капчи (пароль, код с телефона) заканчивался бы только таймаутом.
- `handoff` не разрешён в `plan` (список в ТЗ его не содержит; в самом ask-code он считается безопасным).
- Headless определяется настройкой сервера `ASK_BROWSER_HEADLESS`, а не запросом: так `handoff` ведёт себя предсказуемо.
- Окно одно на сервер, а не «на сессию» (в ТЗ §12 для этого предложен mutex): шаги идут по очереди.
- Нет флага `--no-sandbox` (класс `AskBrowser` из ask-code его не принимает): в контейнере от root Chrome может не запуститься.
- Шаг, превысивший 30 с, отвечает `504`, но сам в браузере может ещё завершиться.
- Safari проверен только чтением кода; на Mac без Chrome он берётся автоматически.
- `browser` в `/execute` и `/start` подключён, но окно у каждой задачи своё, а не общее с `POST /browser`. Проверено на подставных сайте и браузере; с настоящим сайтом и Chrome вручную не пробовалось.

## Проверка

`npm test` запускает все наборы (интеграция, 2A–2Е, безопасность) на заглушке сайта. Безопасность (критерии 37–40):
сервер слушает только `127.0.0.1`, `plan` блокирует запись, секреты отклоняются в любом режиме, `ASK_KEY` не попадает
в ответы и в дочерние процессы. Тест `npm run test:live` с настоящим сайтом ask (нужен `ASK_KEY`) проходит 7 из 7;
`/bug`, браузер и `browser` в `/execute` на настоящем сайте не проверялись.
