# tap_start.ps1 - второй перехват: Cline -> прокси (PROXY_BACKEND=code) -> наш сервер (/execute) -> отвод -> сайт.
# Запуск из любой папки:  powershell -ExecutionPolicy Bypass -File project\test\tap_start.ps1
# Параметры:
#   -Root  папка, в которой работает модель (по умолчанию C:\Users\user\Desktop\workai)
#   -Stop  только остановить всё (через stop_servers.ps1) и выйти
# Ключ: берётся из $env:ASK_KEY; если не задан, спросит (ввод скрыт). В файлы и на экран он не пишется.
# Каждый процесс стартует в своём окне и наследует переменные этого окна. Другие настройки прокси берутся из mcp\.env.
param(
    [string]$Root = 'C:\Users\user\Desktop\workai',
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$mcpDir  = Join-Path $project 'mcp'

function Test-Url($url) {
    $code = (& curl.exe -s -o NUL -w '%{http_code}' --connect-timeout 2 $url) -as [int]
    return ($code -gt 0)
}
function Wait-Url($name, $url, $timeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $ok = $false
    do {
        $ok = Test-Url $url
        if (-not $ok) { Start-Sleep -Seconds 1 }
    } while (-not $ok -and (Get-Date) -lt $deadline)
    Write-Host "$name " -NoNewline
    if ($ok) { Write-Host '[OK]' -ForegroundColor Green } else { Write-Host '[FAIL]' -ForegroundColor Red }
    return $ok
}

# 1. Остановить обычные серверы (порты 8737, 8000, 8001, 8789 должны быть свободны).
Write-Host 'Останавливаю серверы...' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $project 'stop_servers.ps1')
# Отвод (порт 8790) stop_servers.ps1 не знает: гасим отдельно.
Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { & taskkill.exe /PID $_ /T /F *> $null }
if ($Stop) { exit 0 }

if (-not (Test-Path -LiteralPath $Root)) { throw "Папка не найдена: $Root" }

# 2. Ключ.
if (-not $env:ASK_KEY) {
    $sec = Read-Host 'ASK_KEY (ввод скрыт)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $env:ASK_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $env:ASK_KEY) { throw 'ASK_KEY не задан.' }

# 3. Python: venv из mcp, если он есть.
$py = Join-Path $mcpDir '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $py)) { $py = 'python' }

# 4. Отвод. Слушает 8790, пересылает на сайт, пишет project\tap\<дата-время>.jsonl.
$env:TAP_PORT = '8790'
Write-Host 'Запуск отвода (8790)...' -ForegroundColor Cyan
Start-Process powershell.exe -WorkingDirectory $mcpDir -ArgumentList @(
    '-NoExit', '-NoProfile', '-Command',
    "`$Host.UI.RawUI.WindowTitle='TAP'; & '$py' code_tap.py")
if (-not (Wait-Url 'Отвод' 'http://127.0.0.1:8790/' 15)) { throw 'Отвод не поднялся. Смотрите его окно.' }

# 5. Наш сервер: на сайт ходит через отвод.
$env:ASK_SITE = 'http://127.0.0.1:8790'
$env:ASK_ROOT = $Root
Write-Host 'Запуск сервера ASK (npm start) через отвод...' -ForegroundColor Cyan
Start-Process cmd.exe -WorkingDirectory $project -ArgumentList '/k', 'title ASK via TAP && npm start'
if (-not (Wait-Url 'Сервер ASK' 'http://127.0.0.1:8737/health' 30)) { throw 'Сервер ASK не поднялся. Смотрите его окно.' }

# 6. Прокси в режиме code. ASK_SITE и ASK_KEY ему не нужны: он говорит только с нашим сервером.
Remove-Item Env:ASK_SITE -ErrorAction SilentlyContinue
$env:PROXY_BACKEND = 'code'
Write-Host 'Запуск прокси (PROXY_BACKEND=code, 8789)...' -ForegroundColor Cyan
Start-Process powershell.exe -WorkingDirectory $mcpDir -ArgumentList @(
    '-NoExit', '-NoProfile', '-Command',
    "`$Host.UI.RawUI.WindowTitle='Proxy code'; & '$py' openai_proxy.py")
Wait-Url 'Прокси' 'http://127.0.0.1:8789/healthz' 30 | Out-Null

Write-Host ''
Write-Host "Папка модели: $Root" -ForegroundColor Cyan
Write-Host 'Порты: отвод 8790, ASK 8737, прокси 8789 (code). MCP-серверы не запущены.' -ForegroundColor Cyan
Write-Host 'Дайте Cline в НОВОЙ задаче: "тест", "запусти notepad", "создай файл helloworld.txt".' -ForegroundColor Cyan
Write-Host "Запись обмена: $(Join-Path $project 'tap')\<дата-время>.jsonl" -ForegroundColor Cyan
Write-Host 'Вернуть обычный режим: stop_servers.ps1, затем start_servers.ps1 (из project).' -ForegroundColor Cyan
