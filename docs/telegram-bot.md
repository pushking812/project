# Telegram-бот: управление локальным MCP-сервером

Бот — ещё один клиент MCP, как Cline или Claude Desktop, только команды приходят из Telegram.
Он подключается по Streamable HTTP к `mcp/server.py --http` (`http://127.0.0.1:8000/mcp`) и вызывает
те же 69 инструментов. Сам MCP-сервер остаётся локальным и без аутентификации: наружу не открывается
ничего, бот работает через long polling (исходящие запросы к `api.telegram.org`).

```
Telegram  ──getUpdates──▶  mcp/telegram_bot.py  ──MCP Streamable HTTP──▶  mcp/server.py --http
   ▲                              │                                              │
   └────sendMessage/edit──────────┘                                     ask-code-server 127.0.0.1:8737
```

## Быстрый старт

1. Получите токен у [@BotFather](https://t.me/BotFather): `/newbot`, имя и адрес → строка вида `123456789:AA...`.
2. Узнайте свой числовой id (например, у [@userinfobot](https://t.me/userinfobot)).
3. Положите в `mcp\.env` (файл в `.gitignore`; в чат и заметки токен не копируйте):

   ```
   TELEGRAM_BOT_TOKEN=123456789:AA...
   TELEGRAM_ALLOWED_USER_IDS=123456789
   ```

4. Запустите MCP-сервер: `mcp\run_server.ps1` (или `start_servers.ps1`, или `/svc start` из самого бота).
5. Запустите бота: `mcp\run_bot.ps1`.
6. В Telegram: `/help`, `/status`.

Проверка без отправки сообщений (токен и связь с MCP):

```
cd mcp
.venv\Scripts\python.exe check_bot.py
```

`[OK] токен` и `[OK] MCP` — всё готово. Без токена бот не стартует (код выхода 2 и понятный текст).

## Переменные

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | нет, **обязательна** | токен от @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | нет, **обязательна** | `123, 456` — кому можно писать боту |
| `TELEGRAM_ALLOWED_CHAT_IDS` | = список пользователей | чаты (нужно для групп) |
| `TELEGRAM_ALLOW_ANY` | `0` | `1` — разрешить всех (только осознанно) |
| `TELEGRAM_MCP_URL` | `ASK_URL` → `http://127.0.0.1:8000/mcp` | адрес MCP; не loopback без `TELEGRAM_ALLOW_REMOTE=1` запрещён |
| `TELEGRAM_PROXY` | нет | прокси для Bot API: `http://…`, `https://…`, `socks5://…`, `socks5h://…` |
| `TELEGRAM_PROXY_USERNAME` / `TELEGRAM_PROXY_PASSWORD` | нет | логин и пароль прокси; подставляются в адрес с экранированием |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | адрес Bot API или свой relay (Cloudflare Worker и подобные); `http://` только для loopback |
| `TELEGRAM_DEFAULT_MODE` | `plan` | режим `/exec`: `plan` ничего не меняет |
| `TELEGRAM_ALLOW_DANGEROUS` | `0` | `1` — разрешить запись файлов, команды, очистку памяти (с подтверждением) |
| `TELEGRAM_TASK_TIMEOUT` | `900` | сколько секунд бот ждёт фоновую задачу |
| `TELEGRAM_POLL_INTERVAL` | `2.0` | как часто спрашивать `task_status` |
| `TELEGRAM_ASK_TIMEOUT` | `600` | таймаут `/ask` и `/compact` |
| `TELEGRAM_MAX_MESSAGE` | `3900` | размер куска сообщения (лимит Telegram — 4096) |
| `TELEGRAM_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`; лог только в stderr |

Все переменные читаются из `mcp\.env` и окружения; уже заданная переменная окружения сильнее `.env`.

## Прокси: если `api.telegram.org` блокируется

Прокси нужен только для запросов к Telegram. MCP-сервер и Node API остаются локальными: бот ходит к ним
напрямую (`trust_env=False`), поэтому системный `HTTPS_PROXY` их не ломает.

```ini
# mcp\.env — вариант 1: прокси без пароля
TELEGRAM_PROXY=http://127.0.0.1:8080

# вариант 2: SOCKS5 (типичный локальный клиент)
TELEGRAM_PROXY=socks5://127.0.0.1:1080

# вариант 3: логин и пароль отдельными строками (экранирование делает бот)
TELEGRAM_PROXY=http://proxy.example.com:3128
TELEGRAM_PROXY_USERNAME=user
TELEGRAM_PROXY_PASSWORD=p@ss:word
```

- Поддерживаются `http`, `https`, `socks5`, `socks5h`. Для SOCKS нужен пакет `socksio` — он добавлен
  в `requirements.txt`, при обновлении окружения поставьте заново:
  `.venv\Scripts\python.exe -m pip install -r requirements.txt`.
- Если `TELEGRAM_PROXY` не задан, `httpx` сам возьмёт `HTTPS_PROXY` / `ALL_PROXY` из окружения
  (и `NO_PROXY`, если задан). Явный `TELEGRAM_PROXY` сильнее переменных окружения.
- **MTProto-прокси Telegram (tg://proxy) не подходит**: Bot API работает по HTTPS, ему нужен обычный
  HTTP/SOCKS-прокси. Если есть только MTProto, поднимите локальный HTTP/SOCKS-прокси или используйте
  локальный Bot API server (см. ниже).
- Пароль прокси не попадает в логи и тексты ошибок: `check_bot.py` печатает адрес как `http://***@host:port`.
- Вместо прокси можно поднять свой Bot API server и указать `TELEGRAM_API_URL=http://127.0.0.1:8081`
  (по `http://` разрешён только loopback — токен иначе ушёл бы открытым).

Проверка после настройки:

```
cd mcp
.venv\Scripts\python.exe check_bot.py
```

Строка `[OK] настройки … прокси http://***@127.0.0.1:8080` и `[OK] токен @your_bot` означают, что прокси работает.

### Вместо прокси: свой relay к Bot API (Cloudflare Worker и подобные)

Если раньше вы поднимали «воркер» на иностранном сервисе (например, Cloudflare Workers с адресом
`https://<имя>.<аккаунт>.workers.dev`), его можно использовать и сейчас — не как прокси, а как адрес API:

```ini
TELEGRAM_API_URL=https://tg.example.workers.dev
```

Бот обращается к `<TELEGRAM_API_URL>/bot<токен>/<метод>` — ровно те же пути, что у `api.telegram.org`.
Поэтому подходит любой relay, который просто пересылает запрос:

```js
// Cloudflare Worker: пересылает всё в Bot API
export default {
  async fetch(request) {
    const url = new URL(request.url);
    return fetch("https://api.telegram.org" + url.pathname + url.search, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  },
};
```

Важно:

- `https://` для внешнего адреса обязателен: по `http://` разрешён только loopback, иначе токен ушёл бы открытым.
- Токен проходит через этот сервис — используйте только **свой** worker (не публичные relay).
- `TELEGRAM_API_URL` и `TELEGRAM_PROXY` независимы: relay не требует прокси, а прокси не требует relay.
- Long polling (`getUpdates` с таймаутом 25 с) — это один запрос на цикл, лимитов бесплатного тарифа Cloudflare
  (100 000 запросов в сутки) хватает с запасом.
- `check_bot.py` печатает выбранный адрес: `[OK] настройки … API https://tg.example.workers.dev …`.
- Вместо Cloudflare подойдут Vercel, Deno Deploy, Netlify Functions или nginx на VPS — важно лишь,
  чтобы путь и тело POST доходили до Bot API без изменений.

## Команды

| Команда | Что делает |
|---|---|
| `/help`, `/start` | справка |
| `/status` | MCP, версия сервера, папка, модель, сессия |
| `/health`, `/me`, `/doctor`, `/context` | диагностика (`health` — наш сервер, `me` — аккаунт Ask) |
| `/mode [plan\|edits\|all]` | режим задач для этого чата |
| `/exec <задача>` | `start_task` в режиме `/mode`, опрос до конца |
| `/plan <задача>` | то же принудительно в `plan` |
| `/run <команда>` | выполнить команду в папке (`run_command`, без модели): нужен режим `all`/`edits` и подтверждение |
| `/run <секунды> <команда>` | то же со своим таймаутом (до 600 с) |
| `/task <id>`, `/tasks`, `/stop [id]` | состояние, последние, остановка |
| `/ask <вопрос>` | вопрос модели **без действий** (ничего не меняет); текст без «/» — тоже вопрос |
| `/tools [фильтр]`, `/tool <имя>` | список и описание инструментов |
| `/call <имя> {json}` | вызвать любой инструмент (опасные — с подтверждением) |
| `/ws`, `/cd <путь>` | рабочая папка и её смена (с подтверждением) |
| `/ls [путь]`, `/cat <файл>`, `/find <текст>` | файлы и поиск |
| `/sessions`, `/new [заголовок]`, `/use <id>`, `/session` | сессии |
| `/model`, `/model <имя>`, `/compact [focus]` | модель и сжатие истории |
| `/notes`, `/remember <текст>` | заметки ASK.md |
| `/browser`, `open <url>`, `read`, `shot`, `close`, `handoff`, `done` | браузер (снимок придёт картинкой) |
| `/apps`, `/apps stop <номер\|all>` | приложения, запущенные командами с `&` |
| `/watch`, `/watch add <spec>`, `/watch stop <id\|all>` | наблюдения |
| `/svc [status\|start\|stop\|restart]` | процесс MCP-сервера |

Примеры:

```
/exec добавь в README раздел про запуск тестов и прогони npm test
/plan посмотри lib/executor.mjs и предложи, что упростить
/run npm test
/run 300 npm run build
/ask чем отличается edits от plan?
/call read_file {"path": "lib/config.mjs", "limit": 40}
/browser open example.com
/svc status
```

## Как выполняется `/exec`

1. Бот вызывает `start_task` (не `execute`): долгий MCP-вызов не держится минутами.
2. Каждые 2 секунды спрашивает `task_status`: статус, число шагов, `outputFiles`.
3. Сообщение «Задача … запущена» правится по ходу (не чаще раза в 10 секунд), в конце заменяется карточкой:
   ответ, файлы, `usage`, ошибка.
4. `/stop <id>` вызывает `stop_task` — Node-сервер действительно прерывает работу.
5. Если задача идёт дольше `TELEGRAM_TASK_TIMEOUT`, бот возвращает управление: `/task <id>` и `/stop <id>` работают и дальше.

История: бот подставляет автосессию MCP (`session_info`), чтобы следующие задачи видели контекст. Если сессию занял
другой клиент (`409 session_busy`), задача повторяется без сессии. `/new` и `/use <id>` задают сессию явно.

## Подтверждения и опасные действия

По умолчанию (`TELEGRAM_ALLOW_DANGEROUS=0`) запрещены: `write_file`, `edit_file`, `run_command`, `remember`,
`write_memory`, `clear_memory`, `write_excel`, `edit_word`, `write_vba`, `edit_vba`, `run_vba`, `set_workspace`,
`export_session`, `stop_app`, `stop_all_apps`, `remove_watch`, `remove_all_watches`.

С `TELEGRAM_ALLOW_DANGEROUS=1` они доступны, но каждый вызов показывает кнопки «Да, выполнить» / «Отмена».
Подтверждение живёт 60 секунд и одноразовое. `/exec` и `/plan` не обходят `mode`: права проверяет Node-сервер.

`/run` тоже требует подтверждения и режима `all` или `edits`: в `plan` команды запрещены. Команда с `&` в конце
запускает приложение в фоне — бот покажет номер и адрес, дальше `/apps` и `/apps stop <номер>`. Вывод и код
возврата приходят в ответ; длинный вывод уходит файлом `.txt`.

## Процесс MCP: `/svc`

- `/svc status` — отвечает ли сервер и кто его запустил.
- `/svc start` — запускает `mcp\.venv\Scripts\python.exe server.py --http` без нового окна и ждёт подключения (до 25 с).
- `/svc stop`, `/svc restart` — только для процесса, который запустил сам бот (с подтверждением).
  Экземпляр, поднятый `run_server.ps1`, Cline или `start_servers.ps1`, бот не трогает: для него есть `stop_servers.ps1`.

После остановки бот теряет соединение и переподключается сам (backoff до 15 с), когда сервер вернётся.

## Безопасность

- Только long polling: входящих портов нет, webhook не используется.
- Первым делом проверяются `user_id` и `chat_id`; чужие сообщения и кнопки игнорируются (факт пишется в лог).
- Токен не попадает в логи (`log.set_secret` заменяет его на `***`) и в тексты ошибок.
- `TELEGRAM_MCP_URL` по умолчанию только этот компьютер; внешний адрес требует `TELEGRAM_ALLOW_REMOTE=1`.
- Токен Bot API по `http://` разрешён только для loopback (нужно тестам).
- `parse_mode` не используется: текст инструментов не может сломать разметку.
- Бот не читает `.env`, `.git`, `.venv`: это запрещает сам API/MCP.

## Проверка и тесты

```
cd mcp
.venv\Scripts\python.exe -m pytest -q                      # офлайн, без сети и токена
.venv\Scripts\python.exe check_bot.py                      # getMe + список инструментов
.venv\Scripts\python.exe -m pytest -q -m live -o addopts=  # живой server.py --http
```

`pytest` не входит в `requirements.txt`: для тестов он ставится отдельно (`.venv\Scripts\python.exe -m pip install pytest`).

## Ограничения

- Бот видит только HTTP-экземпляр (`server.py --http`). Экземпляр stdio, который запустил Cline или Claude Desktop, недоступен.
- Прогресс инструментов MCP не присылает, поэтому «шагов N» — это длина `steps` из `task_status`, а не поток событий.
- Отмена `/ask` и `/compact` не гарантирована (в MCP-клиенте нет отмены отдельного запроса); у задач отмена полноценная через `/stop`.
- Ответы длиннее 4096 символов делятся на несколько сообщений; совсем длинные (`/ask`, `/task`) уходят файлом `.txt`.
- Снимок браузера отправляется как фото до 5 МБ, больший — документом.
- Список задач хранится в памяти бота: после перезапуска `/tasks` пуст, но `/task <id>` и `/stop <id>` работают по id.
- `/svc` и локальные инструменты Office/VBA — Windows-специфичны (VBA ещё требует Office и `AccessVBOM`).

## Диагностика

| Симптом | Причина и действие |
|---|---|
| `TELEGRAM_BOT_TOKEN не задан` | добавьте токен в `mcp\.env`, перезапустите бота |
| `Telegram недоступен: ConnectError: All connection attempts failed` | нет доступа к `api.telegram.org`: задайте `TELEGRAM_PROXY` (см. раздел «Прокси») |
| `Using SOCKS proxy, but the 'socksio' package is not installed` | обновите зависимости: `.venv\Scripts\python.exe -m pip install -r requirements.txt` |
| `Telegram не принял токен: 401` | токен отозван или скопирован с пробелом |
| `MCP-сервер не отвечает на http://127.0.0.1:8000/mcp` | не запущен `server.py --http`: `run_server.ps1` или `/svc start` |
| Инструменты возвращают «Сервер API не отвечает на http://127.0.0.1:8737» | не запущен `npm start` (Node-сервер) |
| Бот молчит в ответ на сообщения | ваш id не в `TELEGRAM_ALLOWED_USER_IDS`; смотрите лог с `[WARN] [bot] чужое сообщение` |
| Бот ответил «не смог создать файл, инструмент записи недоступен» | текст без «/» — это `/ask` (вопрос, ничего не меняет), либо режим `plan`. Сделайте `/mode edits` (или `/mode all`) и повторите через `/exec <задача>` |
| `/exec` отвечает «Уже идёт задача» | дождитесь конца или `/stop <id>` |
| `403 plan_mode` в ответе задачи | режим `plan`: `/mode edits` или `/mode all` |

## Файлы

| Файл | Назначение |
|---|---|
| `mcp/telegram_bot.py` | точка входа: настройки → long polling |
| `mcp/ask_mcp/bot/config.py` | переменные, проверки fail-closed |
| `mcp/ask_mcp/bot/tg.py` | минимальный клиент Bot API на httpx |
| `mcp/ask_mcp/bot/mcp_client.py` | MCP по Streamable HTTP: сессия, очередь, переподключение |
| `mcp/ask_mcp/bot/commands.py` | команды, подтверждения, опрос задач (без Telegram — тестируется офлайн) |
| `mcp/ask_mcp/bot/app.py` | getUpdates, доступ по id, отправка ответов |
| `mcp/ask_mcp/bot/service.py` | `/svc`: запуск и остановка своего процесса MCP |
| `mcp/check_bot.py` | проверка токена и связи с MCP |
| `mcp/run_bot.ps1` | запуск бота с `.venv` |
| `mcp/tests/test_bot_*.py` | офлайн-тесты; `test_bot_live.py` — по маркеру `live` |
