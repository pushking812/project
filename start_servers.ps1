# start_servers.ps1
if ((Get-ExecutionPolicy -Scope Process) -ne 'Bypass') {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
    exit
}

$ErrorActionPreference = 'Stop'
$currentDir = (Get-Location).Path
$mcpDir = Join-Path $currentDir 'mcp'

if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) {
    throw 'wt.exe не найден. Установлен ли Windows Terminal?'
}
if (-not (Test-Path $mcpDir)) {
    throw "Не найдена папка: $mcpDir"
}

$initScript = Join-Path $currentDir 'init_app.ps1'
if (Test-Path $initScript) {
    Write-Host 'Проверка окружения (init_app.ps1)...' -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $initScript
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Проверка окружения не пройдена, серверы не запущены.' -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host 'init_app.ps1 не найден, проверка окружения пропущена.' -ForegroundColor Yellow
}
$Host.UI.RawUI.WindowTitle = 'START'
Write-Host 'Инициализация запуска серверов...' -ForegroundColor Cyan

function Test-Server($url, $any) {
    $code = (& curl.exe -s -o NUL -w '%{http_code}' --connect-timeout 2 $url) -as [int]
    if ($any) { return ($code -gt 0) } else { return ($code -eq 200) }
}

function Show-ServerStatus($name, $url, $any, $timeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $ok = $false
    do {
        $ok = Test-Server $url $any
        if (-not $ok) { Start-Sleep -Seconds 1 }
    } while (-not $ok -and (Get-Date) -lt $deadline)
    Write-Host "$name " -NoNewline
    if ($ok) { Write-Host '[OK]' -ForegroundColor Green }
    else { Write-Host '[FAIL]' -ForegroundColor Red }
}

Write-Host 'Запуск серверов:' -ForegroundColor Cyan

wt -w 0 new-tab -p 'Windows PowerShell' -d $currentDir --title 'NPM Server' cmd /c 'npm start & exit 0'
Show-ServerStatus 'Сервер ASK HTTP' 'http://127.0.0.1:8737/health' $false

wt -w 0 new-tab -p 'Windows PowerShell' -d $mcpDir --title 'MCP Server' cmd /c 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run_server.ps1 -Part main & exit 0'
Show-ServerStatus 'Сервер MCP (ask)' 'http://127.0.0.1:8000/mcp' $true

wt -w 0 new-tab -p 'Windows PowerShell' -d $mcpDir --title 'MCP ask-extra' cmd /c 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run_server.ps1 -Part office & exit 0'
Show-ServerStatus 'Сервер MCP (ask-extra)' 'http://127.0.0.1:8001/mcp' $true

wt -w 0 new-tab -p 'Windows PowerShell' -d $mcpDir --title 'OpenAI Proxy' cmd /c '.\.venv\Scripts\python.exe openai_proxy.py & exit 0'
Show-ServerStatus 'Сервер OpenAI Proxy' 'http://127.0.0.1:8789/healthz' $false

# Telegram-бот запускается, только если токен уже задан: иначе вкладка закрылась бы с ошибкой.
$dotEnvPath = Join-Path $mcpDir '.env'
$botInEnv = [bool]$env:TELEGRAM_BOT_TOKEN
$botInFile = (Test-Path -LiteralPath $dotEnvPath) -and
    [bool](Select-String -LiteralPath $dotEnvPath -Pattern '^\s*TELEGRAM_BOT_TOKEN\s*=' -Quiet)
if ($botInEnv -or $botInFile) {
    wt -w 0 new-tab -p 'Windows PowerShell' -d $mcpDir --title 'Telegram Bot' cmd /c 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run_bot.ps1 & exit 0'
    Write-Host 'Telegram Bot  ' -NoNewline
    Write-Host '[OK] вкладка запущена (лог — в ней же)' -ForegroundColor Green
} else {
    Write-Host 'Telegram Bot  ' -NoNewline
    Write-Host '[--] TELEGRAM_BOT_TOKEN не задан: см. docs/telegram-bot.md' -ForegroundColor DarkGray
}

Write-Host 'Порты: ASK 8737, MCP ask 8000, MCP ask-extra 8001, OpenAI Proxy 8789' -ForegroundColor Cyan
Write-Host 'Все процессы запущены!' -ForegroundColor Green
