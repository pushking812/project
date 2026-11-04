# Postman: Runs (готовые последовательности запросов)

Коллекция: `postman/ask-code-api.postman_collection.json`. В конце добавлены две папки `Runs`. В Postman отдельного объекта «Run» в файле коллекции нет, поэтому каждый Run — это подпапка с запросами в нужном порядке. Запросы скопированы из этапных папок вместе с тестами.

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
Скрипт сам поднимает тестовый сервер на порту `RUN_PORT` (по умолчанию 8791) с корнем `.postman-root` и останавливает его в конце. `RUN_NO_SERVER=1` — использовать уже запущенный сервер по адресу `baseUrl`. Ручные Run M1 и M2 (`-- manual`) запускайте с вашим сервером и `RUN_NO_SERVER=1`: там нужен человек.

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
