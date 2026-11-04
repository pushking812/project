# Этап 3: принятые решения и поправки после проверки кода

Основа: `Ответ на замечания по ТЗ 3.txt`, `docs/Ask API docs.txt`, чтение кода (2026-11-03).

## 1. Принято (по ответу пользователя)

- Называем «этап 3». Нумерацию коммитов продолжаем текущую в репозитории (не с 45).
- Имена инструментов MCP — нативные, без дублей `ask_*`; префикс `ask_` только при конфликте.
- Занятая сессия (409 `lockSession`): повтор без сессии. `start_task` автосессию не использует.
- Порог сессии: 20 запросов или 50 000 токенов, затем автоматический `/compact`.
- `POST /workspace` в режиме `plan`: `403 plan_mode`.
- Файл автосессии: `%APPDATA%\ask-code\mcp-session.json`, запасной `~/.config/ask-code/`.
- 3В (`ask_market`, `ask_diff_review`, `ask_test_plan`) отложен.
- Повторная смена на текущий корень: `200 {ok:true, already_current:true}`.

## 2. Проверено в коде

| Блокер | Результат |
|---|---|
| Функции ask-code | В `build/ask-code-core.mjs` экспортируются `inside`, `pictureOf`, `readPdf`, `officeText`, `isSecret` (строка 431). `readOne` (строка 942) **не экспортируется**: нужен патч в `build/patch.mjs`. |
| `/ask` с `files` | Сейчас `files` **игнорируется** (ваш пример с `sec.log`: модель «не увидела» файл). Это и есть задача 3Б, а не ошибка. |
| `output_files` и Office | `write_excel`, `write_word`, `edit_word` в коде **нет**. Инструменты модели: `list_files`, `read_file`, `search`, `write_file`, `edit_file`, `run_command`, `browser` (по `Ask API docs.txt`). Значит `.xlsx` модель может создать только через `run_command` (скрипт). `output_files` строим по `write_file`/`edit_file`; для Office — только если файл появился после `run_command` (сравнение списка файлов до/после). Это надо решить отдельно. |
| `app.browser`, `app.watches` | **Таких полей нет.** Браузер — `app.browserState.b`, приложения — `app.apps`, наблюдатели — переменная `watches` внутри замыкания `lib/watches.mjs`. Общий хук один: `app.onShutdown`. |
| Корень захвачен при создании | `new AskBrowser(config.root, …)` (`lib/browser.mjs:22`) и `root: config.root` в `lib/watches.mjs:17` запоминают корень **один раз**. Присвоить `config.root = newRoot` мало: нужно закрыть окно браузера и сбросить `watches`, иначе они продолжат работать в старой папке. Это поправка к пункту 1 ответа. |

## 3. Поправки к плану коммитов

- Коммит 2: добавить `app.onWorkspaceChange: []` (по образцу `onShutdown`); `lib/browser.mjs` закрывает окно и обнуляет `browserState.b`, `lib/watches.mjs` вызывает `stopAll()` и обнуляет `watches`, `lib/apps.mjs` вызывает `apps.stopAll()`. Тест 5 проверяет все три.
- Коммит 4: счётчик `activeRequests` — в `ask-code-server.mjs` рядом с `app.running()`.
- Блокер 11: вместо `grep` — патч `build/patch.mjs`, экспортирующий `readOne`.
- Блокер 12 закрыт выводом из п. 2 (решить способ для Office).
- Порядок проверок в `POST /workspace` в ответе внутренне противоречив: в п. 3.2 `plan_mode` стоит последним, но сказано «проверять до всех, кроме 400». Принимаю второе: `400` → `403 plan_mode` → `system_path` → `home_forbidden` → `not_allowed` → `404` → `409`.
- Формат `files` подтверждён документацией сайта: `{kind:"text",name,text}` и `{kind:"image",name,mediaType,data}`; PDF — `data` в base64. До 5 файлов, текст до 200 000 символов, картинка до 5 000 000 символов base64, PDF до 10 000 000, запрос до 30 МБ. Наш `/ask` принимает в `files` **пути** (как в вашем примере) — их мы читаем локально и собираем объекты сами.
- Тест 7 из ответа (`fixtures/hello.txt`, регулярка `hello`) годится, но нужен ещё офлайн-тест с поддельным сайтом: проверять, что в запрос ушёл `files` с нужным `text`, не полагаясь на модель.

## 4. Не проверено

- Как Cline передаёт массив `files` (инспектор MCP не запускался).
- Формат `GET /v1/me` → `browser` на живом сайте.
- Поиск `search` инструмента в этой сессии возвращал «No matches» там, где совпадения есть; проверял через `findstr`.
