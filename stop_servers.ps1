# stop_servers.ps1
# Останавливает сами серверы (по портам). Оболочки во вкладках, запущенные
# через "cmd /c ... & exit 0", завершаются с кодом 0, и вкладки закрываются сами.
$ErrorActionPreference = 'SilentlyContinue'
$projectMarker = 'code-ask-api'
$ports = 8737, 8000, 8789   # ASK HTTP, MCP, OpenAI Proxy

function Stop-Tree {
    param([int]$ProcessId)
    if ($ProcessId -and $ProcessId -ne $PID) {
        & taskkill.exe /PID $ProcessId /T /F *> $null
    }
}

# 1. Процессы, слушающие порты серверов
foreach ($port in $ports) {
    Get-NetTCPConnection -LocalPort $port -State Listen |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Stop-Tree $_ }
}

# 2. Запасной вариант: процессы по командной строке
Get-CimInstance Win32_Process |
    Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -and
        $_.CommandLine -match 'openai_proxy\.py|run_server\.ps1|ask-code-server|telegram_bot\.py' -and
        $_.Name -notmatch '^(cmd|powershell|WindowsTerminal)\.exe$'
    } |
    ForEach-Object { Stop-Tree $_.ProcessId }

# 3. Node из папки проекта
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object {
        ($_.ExecutablePath -like "*$projectMarker*") -or
        ($_.CommandLine -like "*$projectMarker*")
    } |
    ForEach-Object { Stop-Tree $_.ProcessId }

Write-Host 'Серверы остановлены, вкладки закроются автоматически.' -ForegroundColor Green
