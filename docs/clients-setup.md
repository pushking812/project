# Подключение клиентов: Claude Desktop, VS Code Copilot, VS Code Cline

В проекте два компонента, которые подключаются к клиентам:

| Компонент | Что это | Как подключается | Порт |
|---|---|---|---|
| **MCP-сервер** `mcp/server.py` | инструменты ask для агента | клиент сам запускает его по stdio | — |
| **OpenAI Proxy** `mcp/openai_proxy.py` | OpenAI-совместимый шлюз к ask (`/v1/chat/completions`, `/v1/models`) | клиент ходит по HTTP | 8789 |

Инструменты MCP обращаются к Node-серверу ASK HTTP (`http://127.0.0.1:8737`), поэтому перед работой
запустите серверы: `.\start_servers.ps1` (или `npm start`).

Что умеет каждый клиент:

| Клиент | MCP-сервер | Прокси (свой OpenAI-эндпоинт) |
|---|---|---|
| Claude Desktop | да | нет, такой настройки в приложении нет |
| VS Code Copilot | да | да, через Custom Endpoint |
| VS Code Cline | да | да, провайдер «OpenAI Compatible» |

## Быстрый путь: скрипты

Выполняйте из папки `project` в PowerShell.

```powershell
.\init_app.ps1                      # .venv и переменные среды (один раз)
.\register_mcp.ps1                  # MCP-сервер во все три клиента
.\register_proxy.ps1 -CopyToken     # проверка прокси + параметры; токен в буфер обмена
```

### `register_mcp.ps1`

Добавляет запись `ask` в конфиг клиента. Другие серверы в конфиге не затрагиваются, перед записью
рядом создаётся копия `*.bak-<дата-время>`. Ключей и токенов в конфиги не пишет.

| Параметр | Значение |
|---|---|
| `-Client claude\|vscode\|cline\|all` | какой клиент настроить (по умолчанию `all`) |
| `-Backend api\|legacy\|both` | значение `MCP_BACKEND` (по умолчанию `api`) |
| `-LocalUrl <url>` | адрес Node-сервера, по умолчанию `http://127.0.0.1:8737` |
| `-VSCodeUser` | для VS Code писать в пользовательский `%APPDATA%\Code\User\mcp.json` с абсолютными путями, а не в `.vscode\mcp.json` проекта |
| `-Remove` | удалить запись `ask` |

Примеры:

```powershell
.\register_mcp.ps1 -Client cline
.\register_mcp.ps1 -Client claude -Backend both
.\register_mcp.ps1 -Client vscode -VSCodeUser
.\register_mcp.ps1 -Remove
```

Скрипт проверяет, что есть `mcp\.venv\Scripts\python.exe` и `mcp\server.py`. Если `.venv` нет, запустите
`.\init_app.ps1`. Комментарии в JSON-конфигах скрипт не поддерживает: файл с комментариями он не тронет
и сообщит об ошибке.

### `register_proxy.ps1`

Токен провайдера Cline и Copilot хранят в защищённом хранилище VS Code, записать его файлом нельзя.
Поэтому скрипт не пишет настройки, а:

1. читает `PROXY_PORT`, `PROXY_HOST`, `PROXY_MODEL`, `PROXY_TOKEN` из переменных среды и `mcp\.env`;
2. проверяет `/healthz` и `/v1/models` с токеном (401 значит, что токен не тот или прокси не перезапущен);
3. печатает Base URL, Model ID и подсказку, куда что вставить;
4. с ключом `-CopyToken` кладёт `PROXY_TOKEN` в буфер обмена. На экран токен не выводится.

Параметры подключения по умолчанию:

- **Base URL:** `http://127.0.0.1:8789/v1`
- **Model ID:** `claude-sonnet-5-5`
- **API Key:** значение `PROXY_TOKEN` (не `ASK_API_KEY`)

## Claude Desktop

Только MCP-сервер.

1. Выполните `.\register_mcp.ps1 -Client claude`.
2. Файл конфига: `%APPDATA%\Claude\claude_desktop_config.json`, запись `mcpServers.ask`.
3. Полностью закройте Claude Desktop, включая значок в трее, и откройте снова.
4. Settings → Developer: сервер `ask` должен быть в состоянии running.
5. Лог при ошибках: `%APPDATA%\Claude\logs\mcp-server-ask.log`.

Если приложение установлено из Microsoft Store, конфиг может лежать в другой папке. Тогда откройте его через
Settings → Developer → Edit Config и скопируйте запись `ask` из `%APPDATA%\Claude\claude_desktop_config.json`.

Вручную запись выглядит так (пути ваши):

```json
{
  "mcpServers": {
    "ask": {
      "command": "C:\\...\\project\\mcp\\.venv\\Scripts\\python.exe",
      "args": ["C:\\...\\project\\mcp\\server.py"],
      "env": { "MCP_BACKEND": "api", "ASK_LOCAL_URL": "http://127.0.0.1:8737" }
    }
  }
}
```

## VS Code Copilot

### MCP-сервер

1. Выполните `.\register_mcp.ps1 -Client vscode`. Запись попадёт в `project\.vscode\mcp.json`
   (пути через `${workspaceFolder}`, поэтому папку `project` нужно открывать в VS Code как корневую).
   Для работы в любой папке используйте `-VSCodeUser`.
2. Откройте `.vscode/mcp.json` и нажмите **Start** над сервером `ask`.
3. В чате Copilot выберите режим **Agent** и включите инструменты `ask` (значок инструментов).
4. Не используйте оба варианта сразу, иначе сервер появится дважды.

### Прокси (свои модели)

Нужна версия VS Code с поддержкой Custom Endpoint; в более старых версиях провайдер OpenAI Compatible доступен
только в Insiders.

1. Запустите прокси (`start_servers.ps1`) и выполните `.\register_proxy.ps1 -CopyToken`.
2. Command Palette → **Chat: Manage Language Models** → **Add** → **Custom Endpoint** (или OpenAI Compatible).
3. Введите Base URL, Model ID и вставьте токен из буфера обмена в поле ключа. VS Code сохранит его в секретах,
   а в JSON запишет ссылку на секрет. Не вставляйте токен прямо в JSON.
4. Выберите модель в списке моделей чата.

Точный формат записей в `chatLanguageModels.json` меняется между версиями VS Code, поэтому скрипт его не пишет.

## VS Code Cline

### MCP-сервер

1. Выполните `.\register_mcp.ps1 -Client cline`.
2. Скрипт пишет во все известные файлы настроек Cline (создаёт недостающие):
   - `%USERPROFILE%\.cline\data\settings\cline_mcp_settings.json` (новые версии Cline читают его);
   - `%APPDATA%\Code\User\globalStorage\.cline\...` и
   - `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` (старый путь).
3. В Cline: значок MCP Servers → вкладка **Installed**. У `ask` должен быть зелёный индикатор.
   В этом конфиге Cline пути абсолютные, подстановки вроде `${workspaceFolder}` он не поддерживает.

### Прокси

1. Запустите прокси и выполните `.\register_proxy.ps1 -CopyToken`.
2. В окне Cline нажмите шестерёнку и задайте:
   - **API Provider:** `OpenAI Compatible`
   - **Base URL:** `http://127.0.0.1:8789/v1`
   - **API Key:** токен из буфера обмена (`PROXY_TOKEN`)
   - **Model ID:** `claude-sonnet-5-5`
3. Нажмите Done и отправьте тестовое сообщение.

## Инструменты Excel и Word (ask MCP)

Модуль `mcp/ask_mcp/tools/office.py`. Нужны `openpyxl` и `python-docx` (есть в `requirements.txt`).

- `read_excel`: читает лист или диапазон (`cell_range`, `max_rows`); `values_only=true` даёт сохранённые значения формул.
- `write_excel`: создаёт или правит файл; ячейки через `cells={"C2": "=B2*3"}` или блок строк `rows` от `start_cell`.
- `read_word`: абзацы с номером и стилем, таблицы.
- `edit_word`: замена текста, вставка абзацев (`insert_after`), заголовки (`heading_level`), таблицы; создаёт файл, если его нет.

Пути могут быть относительными или абсолютными (например `C:\Users\...\project\vor.xlsx`). Клиент и ask MCP работают на одном компьютере, поэтому содержимое файла передавать не нужно, достаточно пути. Корень задаёт `ASK_OFFICE_ROOT` (затем `ASK_CODE_ROOT`) в блоке `env` конфига клиента. Абсолютный путь допускается внутри корня; вне корня он отклоняется, пока не задано `ASK_OFFICE_ALLOW_ANY_PATH=1`. Папки `.env`, `.git` и `.venv` закрыты всегда. Ограничения: диаграммы и картинки в `.xlsx` теряются, формулы не вычисляются, `.xls` и `.doc` не поддерживаются. Перед правкой сложных файлов делайте копию.

## Инструменты VBA-макросов (ask MCP)

Модуль `mcp/ask_mcp/tools/vba.py`. Работает через COM (`pywin32`, есть в `requirements.txt`). Нужны Windows и установленный Microsoft Office. Файлы: `.xlsm`, `.docm`.

- `list_vba`: модули файла (имя, тип, число строк).
- `read_vba`: код модуля; окно задают `start_line` и `max_lines`.
- `write_vba`: создаёт модуль или заменяет его код (`standard` или `class`; `append` дописывает в конец). Если файла нет, он создаётся. Подходит и для `ThisWorkbook` / `ThisDocument`.
- `edit_vba`: замена кусков кода парами `old` → `new`; каждый `old` должен встретиться в модуле ровно один раз, иначе правка не применяется.
- `run_vba`: запуск макроса (например `Module1.Main`) с аргументами; для `Function` возвращает результат. Изменения файла по умолчанию отбрасываются, `save=true` их сохраняет.

Каждый вызов запускает скрытый Excel или Word и закрывает его после работы. Пути (относительные или абсолютные) и запретные папки те же, что у Excel/Word-инструментов (`ASK_OFFICE_ROOT`, `ASK_OFFICE_ALLOW_ANY_PATH`).

Правила для Cline (когда использовать ask MCP, а когда встроенные инструменты Cline) лежат в шаблоне `.clinerules` в корне проекта. Cline читает его из открытой папки: если открыта другая папка, скопируйте файл в её корень.

### Настройка безопасности Office (обязательно)

Без неё Office запрещает программный доступ к коду макросов, и `list_vba`, `read_vba`, `write_vba`, `edit_vba` не работают. Настройка меняет безопасность Office, поэтому скрипты проекта её сами не включают.

Через интерфейс (отдельно для Excel и для Word):

1. Файл → Параметры → Центр управления безопасностью → Параметры центра управления безопасностью.
2. Параметры макросов.
3. Включите «Доверять доступ к объектной модели проектов VBA» и нажмите OK.

Через реестр (для текущего пользователя):

```
reg add HKCU\Software\Microsoft\Office\16.0\Excel\Security /v AccessVBOM /t REG_DWORD /d 1 /f
reg add HKCU\Software\Microsoft\Office\16.0\Word\Security /v AccessVBOM /t REG_DWORD /d 1 /f
```

Номер `16.0` подходит для Office 2016, 2019, 2021 и 365; для других версий он другой. Проверить значение:

```
reg query HKCU\Software\Microsoft\Office\16.0\Excel\Security /v AccessVBOM
```

Если политика организации задаёт параметр принудительно, изменение не сработает: обратитесь к администратору. Чтобы отключить доступ, поставьте значение `0`.

Риски и ограничения:

- Включённый доступ разрешает любой программе под вашей учётной записью читать и менять код макросов. Включайте его только на доверенной машине.
- `run_vba` выполняет макрос с вашими правами, как `run_command`. Запускайте только понятный вам код.
- Файл не должен быть открыт в другом окне Office. Макрос с `MsgBox` или `InputBox` в автоматическом режиме зависнет.
- `UserForm` создаётся только пустой. Обычный `.xlsx` в `.xlsm` инструмент не конвертирует.
- Клиенты увидят новые инструменты после перезапуска.

## Если что-то не работает

| Симптом | Причина и действие |
|---|---|
| Сервер `ask` не стартует в клиенте | нет `.venv`: `.\init_app.ps1`; смотрите лог клиента |
| Инструменты есть, но возвращают ошибку соединения | не запущен Node-сервер на 8737: `.\start_servers.ps1` |
| Прокси отвечает 401 | в клиенте указан не `PROXY_TOKEN` или прокси не перезапущен после смены токена |
| Прокси не отвечает | `curl.exe http://127.0.0.1:8789/healthz`; если порт другой, он в `PROXY_PORT` |
| Для `legacy`/`both` нет ответа | задайте `ASK_API_KEY` в `mcp\.env`, не в конфиге клиента |
| Изменения не видны | Claude Desktop перезапустите полностью; в VS Code выполните Developer: Reload Window |

Переменные среды и `.venv` проверяет `.\init_app.ps1`. Убрать регистрацию: `.\register_mcp.ps1 -Remove`.
