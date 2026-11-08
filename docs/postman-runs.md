# Postman: Runs (готовые последовательности запросов)

Коллекция: `postman/ask-code-api.postman_collection.json`. В конце добавлены две папки `Runs`. В Postman отдельного объекта «Run» в файле коллекции нет, поэтому каждый Run — это подпапка с запросами в нужном порядке. Запросы скопированы из этапных папок вместе с тестами.

## Что ещё есть в коллекции
- **Этапные папки** 1, 2A–2Е, 3А, 3Б: по одному запросу на маршрут сервера (порт 8737). Сверка маршрутов `lib/*.mjs` и `ask-code-server.mjs` с коллекцией на 8 ноября: недостающих маршрутов нет.
- **Папка «Прокси OpenAI (порт 8789)»**: `GET /healthz`, `GET /v1/models` (с токеном и без), `GET /v1/usage`, `POST /v1/chat/completions` (401, 400, ответ целиком, поток). Нужны запущенный прокси (`start_servers.ps1`) и переменная коллекции `proxyToken` со значением `PROXY_TOKEN` из `mcp/.env` (в файл коллекции токен не записывайте; в Postman задайте его в Current value). Адрес задаёт `proxyUrl` (по умолчанию `http://127.0.0.1:8789`). Два запроса `chat/completions` с ответом тратят по одному запросу аккаунта. Сама папка в автоматические Runs не входит. Два запроса с ответом вынесены в ручной **Run 11** (см. ниже).
- **Событие `tool` в `/execute`** теперь содержит `path` (если у вызова был путь): это описано у запроса `POST /execute (SSE)`.

Папку прокси добавил и при необходимости обновляет скрипт `postman/tools/add-proxy-folder.mjs` (из папки `project`: `node postman\tools\add-proxy-folder.mjs`). Он заменяет папку по имени, поэтому повторный запуск безопасен. После правки коллекции выполните `npm run postman:sync`, чтобы облачная копия совпала с файлом.

## Как запускать
Правый клик по подпапке → **Run folder** → **Run**. Папку `Runs · автоматические` целиком можно запустить одним Run: подпапки идут по порядку 01…10.

Перед запуском: `npm start` (с `ASK_KEY`, если нужен «ключ») и папка `workspaceDir` (для Run 04).

## Runs · автоматические
| Run | Что проверяет | Ключ ASK_KEY |
|---|---|---|
| 01 Smoke и ошибки маршрутов | health, me, 400/404/405 | нет |
| 02 Файлы и команды | write, read, edit, list, search, command; 403 для `.env`, `../`, `plan` | нет |
| 03 Заметки и память | remember, notes, memory, очистка; ошибки | нет |
| 04 Рабочая папка | смена корня, `already_current`, все 4xx, возврат корня | нет |
| 05 files в запросах | ошибки `files` (400/403/404/413); затем `/ask`, `/execute`, `/start` с `files` | для последних четырёх |
| 06 Жизненный цикл задачи | `/start`, ожидание `/status`, `/start` + `/stop` | да |
| 07 Сессии | создание, продолжение, `/start` в сессии, export, resume, ошибки | да |
| 08 Контекст, модели, диагностика | context, status, models, model, compact, doctor | да |
| 09 Наблюдатели и приложения | watches и apps | нет |
| 10 Браузер | open, read, click, screenshot, close, ошибки; `/execute` с browser | нужен Chrome |

Запрос «ждать завершения» повторяет сам себя каждые ~2 с, пока задача `running` (не больше 60 раз).

## Runs · ручные
- **M1 Капча handoff.** Окно Chrome откроется, капчу проходит человек, затем идёт `/browser/handoff/done`.
- **M2 `/bug`.** Отправляет отчёт на сайт.

- **Run 11 · Прокси.** Вся папка прокси, 8 запросов: `/healthz`, `/v1/models` (с токеном и без), `/v1/usage`, `chat/completions` с кодами 401 и 400, а также ответ без stream и stream. Два последних тратят по одному запросу аккаунта. Нужны запущенный прокси (порт 8789) и токен: в Postman задайте `proxyToken` в Current value, для `postman-cloud.mjs` — переменную окружения `PROXY_TOKEN` (при необходимости `PROXY_URL`). Нужны обе переменные: `POSTMAN_API_KEY` (ключ Postman, нужен любому запуску `postman-cloud.mjs`) и `PROXY_TOKEN` (токен локального прокси). Запускается только явно: PowerShell: `$env:POSTMAN_API_KEY="..."; $env:PROXY_TOKEN="..."; node postman\tools\postman-cloud.mjs run 11`; cmd: `set POSTMAN_API_KEY=... && set PROXY_TOKEN=... && node postman\tools\postman-cloud.mjs run 11`. Выбор `manual` его не включает, без `PROXY_TOKEN` скрипт останавливается.

Эти Runs не запускайте вместе с автоматическими.

## Связь с автотестами
Тесты `test/integration-files.mjs` и `mcp/tests/test_files_integration.py` (`.xlsx`, `.pdf`, `.py`, `report.xlsx`) идут на подставном сайте и новых эндпоинтов не добавляют, поэтому в коллекцию новых запросов не нужно. Run 05 проверяет те же эндпоинты на настоящем сайте, но с текстовым файлом `hello-postman.txt`. `.xlsx` и `.pdf` через Postman не проверяются.

## Заметки
- Run 04 меняет корень сервера и в конце возвращает его (`originalRoot`). Если Run оборвали, верните корень запросом `POST /workspace (вернуть исходный)` или перезапустите сервер.
- Run 02 и 05 создают `hello-postman.txt`. Повторный запуск даёт `409` на `/write`, тест это допускает.
- Run 03 в конце очищает память сервера (`DELETE /memory?mode=all`).
- Runs с ключом тратят запросы вашего аккаунта.

## Облако Postman + Postman CLI (результаты прогонов в Postman)
Результаты уходят в облако только если CLI запускает коллекцию **по UID из облака**, а не из локального файла. Поэтому скрипт `postman/tools/postman-cloud.mjs` сначала загружает файл в облако через Postman API, потом запускает каждый Run через Postman CLI.

**Один раз**
1. Установите Postman CLI ([установка](https://learning.postman.com/docs/postman-cli/postman-cli-installation/)). Команда `postman` из `WindowsApps` может быть настольным приложением, а не CLI. Скрипт это проверяет по `postman --version`. Путь можно задать так: `set POSTMAN_CLI=полный_путь`.
2. Создайте API-ключ: Postman → Settings → Account settings → API keys.
3. `set POSTMAN_API_KEY=ключ` (в файл ключ не записывайте). По желанию `set POSTMAN_WORKSPACE_ID=...` для нужного workspace.

**Команды** (из папки `project`)
```
npm run postman:sync                              загрузить/обновить коллекцию и окружение «ask-code local»
npm run postman:runs                              Runs без ключа ASK_KEY: 01 02 03 04 09
npm run postman:runs -- 01,04                     выбранные
npm run postman:all                               sync + runs
node postman\tools\postman-cloud.mjs list         список Runs
set ASK_KEY=настоящий_ключ & npm run postman:runs -- keyed     все автоматические, включая 05 06 07 08 10
```
Скрипт сам поднимает тестовый сервер на порту `RUN_PORT` (по умолчанию 8791) с корнем `.postman-root` и останавливает его в конце. `RUN_NO_SERVER=1` — использовать уже запущенный сервер по адресу `baseUrl`. Ручные Run M1 и M2 (`-- manual`; Run 11 в этот выбор не входит) запускайте с вашим сервером и `RUN_NO_SERVER=1`: там нужен человек.

После прогона откройте коллекцию в Postman → **Runs** или перейдите по ссылке «View on Postman» из вывода CLI.

**Важно**
- `sync` заменяет содержимое облачной коллекции содержимым файла (PUT). Правки, сделанные только в облаке, пропадут. Источник правды — файл.
- Идентификаторы сохраняются в `postman/.cloud.json` (в `.gitignore`).
- Это справочная реализация по документации Postman CLI и API. На вашем аккаунте я её не запускал.

## Командная строка (newman)
Newman у вас не установлен, глобально я его не ставил. Без установки:
```
npx newman run postman\ask-code-api.postman_collection.json --folder "Run 01 · Smoke и ошибки маршрутов (без ключа)"
```
Имя папки должно совпадать точно. Чтобы запустить все автоматические: `--folder "Runs · автоматические (запускать папкой: Run folder)"`.
