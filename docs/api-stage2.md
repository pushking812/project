# ask-code-mcp — справочник API этапа 2

Краткий справочник по эндпоинтам этапа 2 с примерами `curl`. Подробности, коды ошибок и сценарии — в [../API.md](../API.md).
Этап 1 (`/health`, `/me`, `/ask`, `/execute`, `/start`, `/status/:taskId`, `/stop/:taskId`) описан там же.

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
- `folder` — необязательная папка внутри `ASK_ROOT`; вне проекта — `403 outside` (в query — `400 outside`).
- Секреты (`.env`, ключи) и папки сборки отклоняются во всех режимах (`403 secret`, `403 skipped_dir`).
- Примеры ниже коротко пишут `H='content-type: application/json'` и `U=http://127.0.0.1:8737`.

```bash
U=http://127.0.0.1:8737
H='content-type: application/json'
```

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

```bash
curl -s -X POST $U/read    -H "$H" -d '{"path":"README.md","limit":20}'
curl -s -X POST $U/list    -H "$H" -d '{"path":".","depth":2}'
curl -s -X POST $U/search  -H "$H" -d '{"pattern":"TODO","regex":false}'
curl -s -X POST $U/write   -H "$H" -d '{"path":"hello.txt","content":"Hello\n","overwrite":false}'
curl -s -X POST $U/edit    -H "$H" -d '{"path":"hello.txt","old_text":"Hello","new_text":"Hi"}'
curl -s -X POST $U/command -H "$H" -d '{"command":"node -v","timeout_sec":20}'
```

Ответ `/write` и `/edit`: `{ok, output, shown, diff[], diffTruncated?}`. Ответ `/command`: `{ok, output, shown, code, app?, url?}`.
Ошибки: `409 exists`, `409 old_text_not_found`, `409 old_text_ambiguous`, `403 secret_command`, `408 timeout`.

## 2B. Заметки и память

```bash
curl -s "$U/notes"
curl -s -X POST $U/remember -H "$H" -d '{"note":"tests run with npm test"}'
curl -s "$U/memory"
curl -s "$U/memory/stage2.md"
curl -s -X POST $U/memory -H "$H" -d '{"topic":"stage2.md","content":"# Notes\n"}'
curl -s -X DELETE "$U/memory?mode=all"
```

`note` — до 2000 знаков (`400 too_big`). Тема — простое имя `*.md` (`400 bad_topic`, `400 not_markdown`, `400 memory_full`).

## 2C. Сессии

```bash
SID=$(curl -s -X POST $U/sessions -H "$H" -d '{"title":"demo"}' | node -p "JSON.parse(require('fs').readFileSync(0)).session_id")
curl -N -X POST $U/execute -H "$H" -d "{\"prompt\":\"create a.txt with 1\",\"session_id\":\"$SID\"}"
curl -s $U/sessions
curl -s $U/sessions/$SID
curl -s -X POST $U/sessions/resume -H "$H" -d "{\"id\":\"$SID\"}"
curl -s -X POST $U/sessions/$SID/export -H "$H" -d '{"filename":"demo.md"}'
```

Ошибки: `400 bad_session_id`, `409 session_busy`, `409 already_current`, `409 file_exists`, `400 empty_session`.

## 2Г. Браузер

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

Действия: `open`, `read`, `screenshot`, `click`, `type`, `press`, `scroll`, `back`, `viewport`, `console`, `close`, `handoff`.
Ответ: `{ok, output, images, captcha, handoff_needed, private, note?}`. Ввод в поле пароля — `403 private`.
В режимах не `all` внешний сайт открывается только из `allowedSites` (`403 site_not_allowed`).

## 2Д. Наблюдения и приложения

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

Для наблюдения за страницей сначала откройте её в браузере (`400 browser_off`). Нечитаемый `spec` — `400 bad_spec`.

## 2Е. Контекст, сжатие, модель, диагностика

```bash
curl -s $U/context
curl -s $U/status
curl -N -X POST $U/compact -H "$H" -d '{"focus":"API details"}'
curl -s $U/models
curl -s -X POST $U/model -H "$H" -d '{"name":"sonnet"}'
curl -s $U/doctor
curl -s -X POST $U/bug -H "$H" -d '{"text":"What went wrong"}'
```

`/compact`: события `delta` → `usage` → `done {summary, requests, session_id}` или `error`; до потока — `400 too_short`,
`409 session_busy`. `/model`: `400 unknown_model`. `/doctor` всегда отвечает `200`, недоступный сайт — проверка `ask` с `ok: false`.

## Проверка

`npm test` запускает все наборы (интеграция, 2A–2Е, безопасность) на заглушке сайта. Безопасность (критерии 37–40):
сервер слушает только `127.0.0.1`, `plan` блокирует запись, секреты отклоняются в любом режиме, `ASK_KEY` не попадает
в ответы и в дочерние процессы. На настоящем сайте ask тесты не запускались.
