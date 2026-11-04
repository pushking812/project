# Ask MCP server (v1)

MCP-сервер Ask. С версии 2 по умолчанию (`MCP_BACKEND=api`) его инструменты работают через HTTP API нашего сервера
`ask-code-server` (`http://127.0.0.1:8737`, задачи, файлы, память, сессии, браузер, наблюдения, диагностика, 69 инструментов: 60 через API и 9 локальных Office/VBA).
Список инструментов, соответствие эндпоинтам и устройство модулей — в [MCP_TOOLS.md](MCP_TOOLS.md). Прежние инструменты
ниже остались рабочими и включаются `MCP_BACKEND=legacy` (или `both`: тогда они называются `legacy_ask`, `legacy_get_usage`,
`legacy_code`).

## Прежние инструменты (MCP_BACKEND=legacy), прямые вызовы https://ask.oryxml.com

- `ask(prompt, model?, system?)` — вопрос модели, возвращает полный текст ответа.
- `get_usage()` — текущие лимиты (`GET /v1/usage`), не расходует лимит.
- `code(task, model?, max_steps?)` — Ask правит файлы проекта по вашему указанию через `/v1/code` (читает, ищет, пишет, правит; команды не запускает), возвращает JSON с итогом. Запись и чтение ограничены корнем проекта (`ASK_CODE_ROOT`, по умолчанию папка `server.py`); `.env`, `.git`, `.venv` закрыты. Расходует лимит тарифа.

## Файлы проекта

| Файл | Назначение |
|---|---|
| `server.py` | тонкая точка входа MCP-сервера: выбирает бэкенд и подключает инструменты. Без аргументов работает через stdio, с `--http` как HTTP-сервер |
| `ask_mcp/` | модули: `config`, `errors`, `sse`, `api_client`, `tools/` (бэкенд api), `legacy/` (прежние инструменты) |
| `MCP_TOOLS.md` | инструменты бэкенда api, их эндпоинты и устройство модулей |
| `client.py` | минимальный клиент: подключается к уже запущенному `server.py --http`, сам сервер не запускает |
| `check_mcp.py` | проверка работоспособности с `[OK]`/`[FAIL]` по шагам, тоже требует запущенный `server.py --http` |
| `smoke_test.py` | сам запускает сервер через stdio и вызывает безопасные инструменты (`health`, `list_files`, `browser_state`; при `MCP_BACKEND=legacy` — `get_usage`), печатает результат |
| `run_server.ps1`, `run_client.ps1`, `run_check.ps1` | запуск `server.py --http`, `client.py`, `check_mcp.py` с нужными переменными окружения |
| `run_inspector.ps1` | запуск MCP Inspector в режиме stdio (`npx -y @modelcontextprotocol/inspector`), Inspector сам стартует `server.py` |
| `openai_proxy.py`, `run_proxy.ps1` | OpenAI-совместимый прокси для Cline/Continue (см. раздел «Прокси») |
| `.env.example` | образец файла `.env` с ключом и настройками прокси |
| `requirements.txt` | зависимости (`mcp>=1.2,<2`, `httpx`, `starlette`, `uvicorn`) |

## Установка (Windows)

```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
notepad .env
```

В `.env` одна строка без кавычек: `ASK_API_KEY=sk-ask-...`. Не публикуйте этот файл; если проект попадёт в git, добавьте `.env` в `.gitignore`.

## Быстрый старт (ps1-скрипты)

Нужны два окна PowerShell. Если запуск скриптов запрещён политикой выполнения, один раз выполните в окне `Set-ExecutionPolicy -Scope Process Bypass` или запускайте так: `powershell -ExecutionPolicy Bypass -File .\run_server.ps1`.

Окно 1, сервер (оставьте открытым, остановка: Ctrl+C):
```
.\run_server.ps1
.\run_server.ps1 8100
```
Необязательный аргумент задаёт порт (по умолчанию `8000`, хост `127.0.0.1`). Без `ASK_API_KEY` и без `.env` скрипт выведет предупреждение, но сервер всё равно запустится.

Окно 2, проверка:
```
.\run_check.ps1
.\run_check.ps1 --ask
.\run_client.ps1
.\run_client.ps1 get_usage
.\run_client.ps1 "Что такое MCP?"
.\run_client.ps1 ask "Что такое MCP?"
```
- `run_check.ps1` печатает `[OK]`/`[FAIL]` по шагам; код выхода 0 при успехе, 1 при ошибке. С `--ask` добавляется короткий вызов `ask` (тратит немного лимита).
- `run_client.ps1` без аргументов показывает инструменты и вызывает `get_usage`. Первый аргумент `get_usage` делает то же самое явно (лимит не тратится). Любой другой текст уходит в `ask` как вопрос (тратит лимит); слово `ask` в начале отбрасывается, поэтому `ask Что такое MCP?` и `Что такое MCP?` равнозначны. Вопрос, который должен начинаться со слова `ask` или `get_usage`, этим способом не отправить.
- `ASK_URL` по умолчанию собирается из `ASK_HOST` и `ASK_PORT`. Для другого порта достаточно `$env:ASK_PORT = '8100'` перед запуском.

Скрипты переходят в свою папку, поэтому их можно запускать из любого места. Ключ в них не записан.

Если клиент пишет `ConnectError: All connection attempts failed`, сервер не запущен. Если подключение проходит, а `get_usage` возвращает ошибку про `ASK_API_KEY`, у сервера нет ключа: задайте его в `.env` или `set ASK_API_KEY=...` перед запуском сервера и перезапустите его. Ключ нужен только серверу, а не клиенту.

## Подключение

Ключ `sk-ask-...` задаётся переменной окружения `ASK_API_KEY` или файлом `.env` рядом с `server.py`.

Claude Code:

```
claude mcp add ask --env ASK_API_KEY=sk-ask-ВАШ_КЛЮЧ -- C:\Users\user\ask-project\.venv\Scripts\python.exe C:\Users\user\ask-project\server.py
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ask": {
      "command": "C:\\Users\\user\\ask-project\\.venv\\Scripts\\python.exe",
      "args": ["C:\\Users\\user\\ask-project\\server.py"],
      "env": { "ASK_API_KEY": "sk-ask-ВАШ_КЛЮЧ" }
    }
  }
}
```

## Настройки MCP в Cline

Cline хранит подключённые MCP-серверы и их переменные окружения (`env`) в файле:

`C:\Users\user\.cline\data\settings\cline_mcp_settings.json`

(в самом Cline: MCP Servers → Installed → Configure MCP Servers). Если в `env` блока нашего сервера задан `ASK_OFFICE_ROOT`, он сильнее рабочей папки сервера для `read_excel`, `write_excel`, `read_word`, `edit_word`. После правки файла перезапустите MCP-сервер в Cline. Ключи из этого файла не копируйте в заметки и чат.

## Параметры запуска server.py

Аргумент командной строки у `server.py` один: `--http`. Остальное задаётся переменными окружения.

| Запуск | Режим |
|---|---|
| `.venv\Scripts\python server.py` | stdio (по умолчанию): сервер запускает MCP-клиент (Claude Desktop, Claude Code, Inspector) как дочерний процесс. Порт не открывается. |
| `.venv\Scripts\python server.py --http` | постоянный HTTP-сервер (Streamable HTTP) на `http://127.0.0.1:8000/mcp`. К нему подключаются `client.py`, `check_mcp.py` и Inspector в режиме Streamable HTTP. Остановка: Ctrl+C. |

Переменные окружения:

| Переменная | Где нужна | Значение по умолчанию |
|---|---|---|
| `ASK_API_KEY` | серверу, обязательна | нет. Если не задана, ключ читается из файла `.env` рядом с `server.py` (образец: `.env.example`) |
| `ASK_BASE_URL` | серверу | `https://ask.oryxml.com` |
| `ASK_HOST` | серверу, только с `--http` | `127.0.0.1` |
| `ASK_PORT` | серверу, только с `--http` | `8000` |
| `ASK_URL` | `client.py` и `check_mcp.py` (адрес сервера) | `http://127.0.0.1:8000/mcp` |

Пример с другим портом (cmd):
```
set ASK_PORT=8100
.venv\Scripts\python server.py --http
set ASK_URL=http://127.0.0.1:8100/mcp
.venv\Scripts\python check_mcp.py
```
(`ASK_URL` задаётся во втором окне, где запускается клиент.)

Параметры `model` и `system` относятся не к запуску, а к вызову инструмента `ask`.

## Примеры запуска

Ключ задаётся переменной `ASK_API_KEY` (или файлом `.env`). Необязательная `ASK_BASE_URL` меняет адрес API (по умолчанию `https://ask.oryxml.com`).

Запуск сервера вручную (он говорит по протоколу MCP через stdin/stdout, поэтому в терминале просто ждёт ввода; остановка: Ctrl+C):

cmd:
```
set ASK_API_KEY=sk-ask-ВАШ_КЛЮЧ
.venv\Scripts\python server.py
```

PowerShell:
```
$env:ASK_API_KEY = "sk-ask-ВАШ_КЛЮЧ"
.venv\Scripts\python server.py
```

Проверка через MCP Inspector: см. раздел «MCP Inspector» ниже.

Проверка Claude Code:

```
claude mcp list
claude mcp get ask
claude mcp remove ask
```

В Claude Code (или Desktop) после подключения просто пишите запросы обычным языком:

- «Покажи мои лимиты Ask» — вызовет `get_usage`.
- «Спроси через ask: объясни разницу между TCP и UDP» — вызовет `ask` с одним `prompt`.
- «Спроси через ask с моделью claude-haiku-5-5: переведи на английский "добрый день"» — `ask` с параметром `model`.
- «Спроси через ask с system "отвечай одним предложением": что такое MCP?» — `ask` с параметром `system`.

Аргументы инструментов в JSON (так их видно в Inspector):

```json
{ "prompt": "Объясни разницу между TCP и UDP" }
```
```json
{ "prompt": "Что такое MCP?", "model": "claude-haiku-5-5", "system": "Отвечай одним предложением" }
```

Каждый вызов `ask` расходует лимит тарифа, `get_usage` — нет.

## MCP Inspector

Inspector — веб-интерфейс для ручного вызова инструментов MCP-сервера. Нужен Node.js. Устанавливать пакет отдельно не требуется: `npx` скачает его сам (флаг `-y` отвечает «да» на вопрос об установке).

### Минимальная проверка

Самый короткий способ убедиться, что MCP-сервер работает (ключ для этого не нужен):

1. Запустите Inspector: `npx -y @modelcontextprotocol/inspector .venv\Scripts\python.exe server.py`.
2. Нажмите **Connect**: статус должен стать Connected. Значит, сервер стартует и говорит по протоколу MCP.
3. **Tools** → **List Tools**: в списке есть `ask` и `get_usage`. Значит, инструменты зарегистрированы.
4. По желанию `get_usage` → **Run Tool**. С ключом придёт JSON с лимитами (лимит не тратится), без ключа — понятная ошибка про `ASK_API_KEY`. Ошибка без ключа тоже означает, что сервер отвечает.

Без браузера то же самое делает `check_mcp.py` (нужен запущенный `server.py --http`):
```
.venv\Scripts\python check_mcp.py
```
Он печатает `[OK]` или `[FAIL]` по каждому шагу, код выхода 0 при успехе и 1 при ошибке.

### Режим stdio (рекомендуется)

Сервер запускайте без `--http`: Inspector сам стартует его, как это делает Claude Desktop.

1. Откройте cmd в папке проекта и задайте ключ в том же окне, где будет `npx`:
   ```
   cd C:\Users\user\ask-project
   set ASK_API_KEY=sk-ask-ВАШ_КЛЮЧ
   ```
2. Запустите Inspector:
   ```
   npx -y @modelcontextprotocol/inspector .venv\Scripts\python.exe server.py
   ```
3. Дождитесь адреса вида `http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=...`. Если браузер не открылся сам, откройте адрес целиком, вместе с токеном.
4. В левой панели проверьте: Transport Type — **STDIO**, Command — `.venv\Scripts\python.exe`, Arguments — `server.py`. Нажмите **Connect**, статус должен стать Connected.
5. Вкладка **Tools** → **List Tools**: должны появиться `ask` и `get_usage`.
6. Выберите `get_usage` → **Run Tool**. Придёт JSON с лимитами, лимит вызов не тратит.
7. По желанию выберите `ask` и в `prompt` введите `ответь одним словом: pong`. Этот вызов расходует немного лимита.

### Режим Streamable HTTP

Если подключение через Command и Arguments не работает:

1. В одном окне запустите сервер:
   ```
   set ASK_API_KEY=sk-ask-ВАШ_КЛЮЧ
   .venv\Scripts\python server.py --http
   ```
2. В Inspector выберите Transport Type **Streamable HTTP**, URL `http://127.0.0.1:8000/mcp`, нажмите **Connect**.

Сервер в этом режиме слушает только `127.0.0.1` и не имеет аутентификации, не открывайте его в сеть.

### Примеры вызова инструментов

#### `ask`

Через поля формы:

1. Подключитесь (**Connect**), откройте **Tools** → **List Tools** и выберите `ask`.
2. Справа заполните поля:
   - `prompt` — `Переведи на английский: добрый день` (обязательное);
   - `model` — `claude-haiku-5-5` (необязательное, пустое поле оставьте как есть);
   - `system` — `Отвечай одним предложением.` (необязательное);
   - `history` — предыдущие сообщения диалога `[{"role": "user", "text": "…"}]`, до 400: уточняющий вопрос без пересказа контекста (необязательное). Если сервер сжал историю, в результате будет поле `folded` (`{summary, count}`).
3. Нажмите **Run Tool**. В блоке результата появится текст ответа. Вызов расходует лимит.

То же в виде JSON. В новых версиях Inspector у инструмента есть переключатель на JSON-ввод; если его нет, значения по полям соответствуют этим аргументам:
```json
{
  "prompt": "Переведи на английский: добрый день",
  "model": "claude-haiku-5-5",
  "system": "Отвечай одним предложением."
}
```
Минимальный запрос, только с обязательным полем:
```json
{ "prompt": "ответь одним словом: pong" }
```

Так выглядит запрос протокола MCP, который Inspector отправляет серверу (его видно во вкладке History):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "ask",
    "arguments": { "prompt": "ответь одним словом: pong" }
  }
}
```
#### `get_usage`

Инструмент без параметров, лимит не расходует, поэтому подходит для первой проверки с ключом.

Через поля формы:

1. Подключитесь (**Connect**), откройте **Tools** → **List Tools** и выберите `get_usage`.
2. Полей для заполнения нет: оставьте форму пустой.
3. Нажмите **Run Tool**. В блоке результата появится JSON с лимитами (без ключа — ошибка про `ASK_API_KEY`).

Аргументы в виде JSON (пустой объект):
```json
{}
```

Запрос протокола MCP (вкладка History):
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_usage",
    "arguments": {}
  }
}
```

Структура ответа зависит от API (`GET /v1/usage`); точный вид полей зависит от вашего тарифа.

### Как понять результат

- Connected и два инструмента в списке — MCP-сервер работает.
- Ошибка про `ASK_API_KEY` — у процесса сервера нет ключа: задайте его в `.env`, в окне, где запущен `npx` (или сервер `--http`), либо в Inspector в панели **Environment Variables**, затем нажмите Disconnect и Connect.
- Ошибка `unauthenticated` — ключ неверный.
- Если порт 8000 уже занят старым процессом, `netstat -ano | findstr :8000` покажет его PID, закрыть можно через `taskkill /PID <pid> /F`.

## Прокси: Base URL для Cline/Continue

`openai_proxy.py` — OpenAI-совместимый вход поверх Ask (`/v1/chat/completions`, `/v1/models`, `/v1/usage`, `/healthz`). Тот же ключ Ask и тот же лимит; запрос, ретраи и дочитывание обрыва делает ядро `server.py`.

1. В `.env` задайте `PROXY_TOKEN` — пароль прокси для агента. Он обязателен и не должен совпадать с `ASK_API_KEY`: токен попадает в конфиг Cline/Continue, ключ Ask там быть не должен. Иначе прокси не стартует (код выхода 2).
2. Запуск: `.\run_proxy.ps1` — порт `127.0.0.1:8789`; второй экземпляр — `.\run_proxy.ps1 -Port 8790` (адрес — `-ProxyHost`). Остановка: Ctrl+C. Порт и хост задаёт скрипт: `-Port` важнее переменной `PROXY_PORT`, оставшейся в окне от прошлого запуска, и умолчание важнее её тоже. Напрямую (`.venv\Scripts\python openai_proxy.py`) порт берётся только из `PROXY_PORT`, иначе `8789`. Два экземпляра делят `.env` и `PROXY_TOKEN`, а счётчики `get_usage` у каждого процесса свои.
3. В клиенте: Base URL `http://127.0.0.1:8789/v1`, API key — значение `PROXY_TOKEN`, модель — любая из `GET /v1/models` (`ask` и незнакомые имена обслуживает `PROXY_MODEL`).

| Переменная | Значение по умолчанию |
|---|---|
| `PROXY_TOKEN` | нет, обязательна |
| `PROXY_HOST` | `127.0.0.1` (внешний адрес запрещён) |
| `PROXY_PORT` | `8789` (`-Port` у `run_proxy.ps1`; параметр и умолчание важнее переменной) |
| `PROXY_MODEL` | `claude-sonnet-5-5` |
| `PROXY_TOOLS_BLOCK` | `60000` — знаков в каталоге инструментов, который прокси кладёт в промпт. Инструменты добавляются по одному, не влезшие пропускаются (в логе `tools_dropped`, `tools_dropped_names`). При прежних `25000` Cline видел 35 из 69 инструментов `ask__*` |
| `PROXY_TOOL_FIRST` | `ask__` — префиксы имён, которые идут в каталог первыми (через запятую) |
| `PROXY_TOOL_EXCLUDE` | `craft` — подстроки имён серверов, исключаемых из каталога (через запятую) |
| `PROXY_TOOL_POLICY` | `ask` — `ask`, `native`, `mcp` или `off`: чем пользоваться для действий, родными инструментами клиента или MCP |

Прокси отвечает не больше чем на два запроса одновременно. Слишком большой вход обрезается (system 20 000 символов, история 400 сообщений, промпт 100 000, результат инструмента 8 000) с пометкой в ответе и `truncated: true` в логе. На каждый ход в `stderr` пишется одна строка JSON (длины, статус, usage, limits; без ключей и текста промпта). Каждый запрос расходует лимит тарифа, `/v1/models` и `/healthz` — нет.

## Проверка

Варианты (подробности в разделах выше):

- `run_check.ps1` (при запущенном `run_server.ps1`) — проверка с `[OK]`/`[FAIL]`.
- `run_client.ps1` — простой клиент к запущенному серверу.
- `smoke_test.py` — сам запускает сервер через stdio:
  ```
  set ASK_API_KEY=sk-ask-...
  .venv\Scripts\python smoke_test.py
  ```

Без ключа проверки покажут ошибку про `ASK_API_KEY`, с неверным ключом — `unauthenticated`.

Источник: https://ask.oryxml.com/v1/docs
