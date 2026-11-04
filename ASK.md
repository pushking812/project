# Заметки проекта ask-code-mcp

- Клиент (Cline, Claude Desktop) и сервер ask MCP работают на одном компьютере и видят одну файловую систему. Содержимое файлов передавать не нужно: инструментам ask MCP достаточно абсолютного пути (например, `C:\Users\...\project\vor.xlsx`).
- Код, текст, терминал, git, сборка и тесты: инструменты Cline (`execute_command`, `write_to_file`, `replace_in_file`). `run_command` из ask MCP только если пользователь попросил именно его.
- `.xlsx` / `.xlsm` / `.docx` / `.docm`: `read_excel`, `write_excel`, `read_word`, `edit_word` из ask MCP. Через `write_to_file` и `replace_in_file` их править нельзя: файл будет испорчен.
- `.xlsm` / `.docm` (макросы VBA): `list_vba`, `read_vba`, `write_vba(path, module, code)`, `edit_vba`, `run_vba(path, macro, save)`. Без `save=true` в `run_vba` изменения не сохраняются. Файл должен быть закрыт в Office.
- Office-файлы (xlsx, xlsm, docx, docm): передавай инструменту только абсолютный путь Windows. Не читай файл целиком, не вставляй его данные в чат, не используй для них `execute_command`. Читай только нужный диапазон (`cell_range`). Ответ инструмента сообщай кратко.
- Перед ответом «инструментов нет» проверь каталог инструментов и вызови `health`.
- Если неясно, чем действовать (Cline или ask MCP), коротко спроси пользователя один раз и дальше не переспрашивай.
- Браузер: после работы вызови `browser_close` (профиль и входы в аккаунты сохраняются). Если окно ждёт человека (капча, вход), сначала `browser_handoff_done`, потом `browser_close`. Состояние смотри через `browser_state`.
- Чтение и поиск спрашивать не нужно.
- postman check: tests run with npm test
