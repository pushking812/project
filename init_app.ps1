# init_app.ps1
# Проверяет окружение .venv для mcp и при необходимости создаёт его заново:
#   1. .venv существует и рабочий (python.exe запускается, базовый Python на месте);
#   2. .venv создан на этой машине и в этой папке (не перенесён): пути в pyvenv.cfg и activate.bat;
#   3. все пакеты из requirements.txt установлены в нужных версиях.
# Если что-то не так, .venv удаляется, создаётся заново и пакеты ставятся заново.
# Перед этим проверяются переменные среды всех серверов (ASK HTTP, MCP, OpenAI Proxy).
# Код выхода 1, если .venv не удалось подготовить или обязательные переменные не заданы.
# Параметр -Force пересоздаёт .venv без проверок.

param([switch]$Force)

if ((Get-ExecutionPolicy -Scope Process) -ne 'Bypass') {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    if ($Force) { $a += '-Force' }
    & powershell.exe @a
    exit $LASTEXITCODE
}

$ErrorActionPreference = 'Continue'
$mcpDir  = Join-Path $PSScriptRoot 'mcp'
$venvDir = Join-Path $mcpDir '.venv'
$venvPy  = Join-Path $venvDir 'Scripts\python.exe'
$req     = Join-Path $mcpDir 'requirements.txt'

function Info($t) { Write-Host $t -ForegroundColor Cyan }
function Ok($t)   { Write-Host $t -ForegroundColor Green }
function Warn($t) { Write-Host $t -ForegroundColor Yellow }
function Fail($t) { Write-Host $t -ForegroundColor Red }

if (-not (Test-Path -LiteralPath $mcpDir)) { Fail "Не найдена папка: $mcpDir"; exit 1 }
if (-not (Test-Path -LiteralPath $req))    { Fail "Не найден файл: $req"; exit 1 }

# Скрипт проверки пакетов (запускается внутри .venv)
$checkPy = Join-Path ([IO.Path]::GetTempPath()) ("ask_check_reqs_{0}.py" -f [guid]::NewGuid().ToString('N'))
@'
import sys
from importlib import metadata
from pip._vendor.packaging.requirements import Requirement

bad = []
for line in open(sys.argv[1], encoding="utf-8-sig"):
    line = line.split("#", 1)[0].strip()
    if not line or line.startswith("-"):
        continue
    r = Requirement(line)
    if r.marker is not None and not r.marker.evaluate():
        continue
    try:
        v = metadata.version(r.name)
    except metadata.PackageNotFoundError:
        bad.append(r.name + " (не установлен)")
        continue
    if r.specifier and not r.specifier.contains(v, prereleases=True):
        bad.append("%s %s (нужно %s)" % (r.name, v, r.specifier))
if bad:
    print("; ".join(bad))
    sys.exit(1)
'@ | Set-Content -LiteralPath $checkPy -Encoding UTF8

# Возвращает $null, если .venv в порядке, иначе текст причины
function Test-Venv {
    if (-not (Test-Path -LiteralPath $venvDir)) { return '.venv не найден' }
    if (-not (Test-Path -LiteralPath $venvPy))  { return 'в .venv нет Scripts\python.exe' }

    $cfg = Join-Path $venvDir 'pyvenv.cfg'
    if (-not (Test-Path -LiteralPath $cfg)) { return 'нет pyvenv.cfg' }
    $home_ = $null
    foreach ($l in Get-Content -LiteralPath $cfg) {
        if ($l -match '^\s*home\s*=\s*(.+?)\s*$') { $home_ = $Matches[1] }
    }
    if (-not $home_ -or -not (Test-Path -LiteralPath (Join-Path $home_ 'python.exe'))) {
        return "базовый Python из pyvenv.cfg не найден на этой машине: $home_"
    }

    # Путь, под которым .venv был создан, записан в activate.bat
    $act = Join-Path $venvDir 'Scripts\activate.bat'
    if (Test-Path -LiteralPath $act) {
        $txt = [IO.File]::ReadAllText($act)
        if ($txt -match '(?im)^\s*set\s+"?VIRTUAL_ENV=([^"\r\n]+)"?') {
            $orig = $Matches[1].TrimEnd('\')
            $real = (Resolve-Path -LiteralPath $venvDir).Path.TrimEnd('\')
            if ($orig -ine $real) { return ".venv перенесён: создан в '$orig', лежит в '$real'" }
        }
    }

    & $venvPy -c "import sys" 2>$null
    if ($LASTEXITCODE -ne 0) { return 'python из .venv не запускается' }
    & $venvPy -m pip --version 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { return 'в .venv не работает pip' }

    $out = & $venvPy -I $checkPy $req 2>&1
    if ($LASTEXITCODE -ne 0) { return "пакеты: $($out -join ' ')" }
    return $null
}

# Ищет системный Python 3.10+ (не заглушку WindowsApps), возвращает путь к python.exe
function Find-Python {
    $cands = @()
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        $p = & py.exe -3 -c "import sys;print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $p) { $cands += $p.Trim() }
    }
    foreach ($c in @(Get-Command python.exe -All -ErrorAction SilentlyContinue)) {
        if ($c.Source -notmatch '\\WindowsApps\\') { $cands += $c.Source }
    }
    foreach ($c in $cands | Select-Object -Unique) {
        & $c -c "import sys,venv;sys.exit(0 if sys.version_info>=(3,10) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { return $c }
    }
    return $null
}

# ---------- Переменные среды ----------
# Читает .env рядом с server.py так же, как mcp\ask_mcp\config.py (его видят только Python-серверы)
function Read-DotEnv {
    $r = @{}
    $p = Join-Path $mcpDir '.env'
    if (-not (Test-Path -LiteralPath $p)) { return $r }
    foreach ($l in Get-Content -LiteralPath $p -Encoding UTF8) {
        $l = $l.Trim()
        if (-not $l -or $l.StartsWith('#') -or -not $l.Contains('=')) { continue }
        $k, $v = $l.Split('=', 2)
        $k = $k.Trim(); $v = $v.Trim().Trim('"').Trim("'")
        if ($k -and $v) { $r[$k] = $v }
    }
    return $r
}

# Значение переменной: окружение (процесс, пользователь, система), для Python-серверов ещё и .env.
# Возвращает @{ Value; From } или $null
function Get-Setting([string]$Name, [switch]$DotEnv) {
    foreach ($scope in 'Process', 'User', 'Machine') {
        $v = [Environment]::GetEnvironmentVariable($Name, $scope)
        if ($v -and $v.Trim()) { return @{ Value = $v.Trim(); From = $scope } }
    }
    if ($DotEnv -and $script:dotEnv.ContainsKey($Name)) { return @{ Value = $script:dotEnv[$Name]; From = 'mcp\.env' } }
    return $null
}

# Проверяет переменные всех серверов, печатает список, возвращает $true, если обязательные заданы и значения верны
function Test-Environment {
    $script:dotEnv = Read-DotEnv
    $script:envBad = 0
    $script:envWarn = 0
    Info 'Проверка переменных среды:'

    function Row([string]$Name, [string]$Status, [string]$Text, [string]$Color) {
        Write-Host ('  {0,-22} {1,-8} {2}' -f $Name, $Status, $Text) -ForegroundColor $Color
    }
    # Required: обязательная; Check: scriptblock проверки значения (возвращает текст ошибки или $null)
    function Check([string]$Server, [string]$Name, [bool]$Required, [switch]$DotEnv, [scriptblock]$Check, [string]$Default, [switch]$Secret, [switch]$WarnOnly) {
        $s = Get-Setting $Name -DotEnv:$DotEnv
        if (-not $s) {
            if ($WarnOnly) { Row $Name '[WARN]' "не задана ($Server): запуск не блокируется, но функции, которым нужен ключ, не заработают" Yellow; $script:envWarn++ }
            elseif ($Required) { Row $Name '[FAIL]' "не задана ($Server)" Red; $script:envBad++ }
            else           { Row $Name '[--]' "не задана ($Default)" DarkGray }
            return
        }
        $err = if ($Check) { & $Check $s.Value } else { $null }
        $shown = if ($Secret) { '***' } else { $s.Value }
        if ($err) { Row $Name '[FAIL]' "$err (значение: $shown, источник: $($s.From))" Red; $script:envBad++ }
        else      { Row $Name '[OK]' "$shown (источник: $($s.From))" Green }
    }
    $port  = { param($v) $n = 0; if (-not ([int]::TryParse($v, [ref]$n) -and $n -ge 0 -and $n -le 65535)) { 'нужно целое от 0 до 65535' } }

    $backendS = Get-Setting 'MCP_BACKEND' -DotEnv
    $backend = if ($backendS) { $backendS.Value.ToLower() } else { 'api' }
    $legacy = $backend -ne 'api'

    Write-Host ' Сервер ASK HTTP (npm start) - только переменные среды, .env он не читает:' -ForegroundColor White
    Check 'ASK HTTP' 'ASK_KEY' $true -Secret -Check { param($v) if ($v -notmatch '^\S+$') { 'ключ не должен содержать пробелов' } }
    Check 'ASK HTTP' 'ASK_SITE' $false -Default 'https://ask.oryxml.com' -Check { param($v) if ($v -notmatch '^https://' -and $v -notmatch '^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$') { 'нужен https:// (http:// только для localhost)' } }
    Check 'ASK HTTP' 'ASK_PORT' $false -Default '8737' -Check $port
    Check 'ASK HTTP' 'ASK_MODE' $false -Default 'all' -Check { param($v) if ('all', 'edits', 'plan' -notcontains $v) { 'допустимо: all, edits, plan' } }
    Check 'ASK HTTP' 'ASK_CAPTCHA' $false -Default 'manual' -Check { param($v) if ('manual', 'handoff' -notcontains $v.ToLower()) { 'допустимо: manual, handoff' } }
    Check 'ASK HTTP' 'ASK_LOG_LEVEL' $false -Default 'info' -Check { param($v) if ('debug', 'info', 'warn', 'error' -notcontains $v) { 'допустимо: debug, info, warn, error' } }

    Write-Host " Сервер MCP (бэкенд: $backend), переменные среды и mcp\.env:" -ForegroundColor White
    Check 'MCP' 'MCP_BACKEND' $false -DotEnv -Default 'api' -Check { param($v) if ('api', 'legacy', 'both' -notcontains $v.ToLower()) { 'допустимо: api, legacy, both' } }
    Check 'MCP' 'ASK_LOCAL_URL' $false -DotEnv -Default 'http://127.0.0.1:8737'
    Check 'MCP' 'ASK_PORT' $false -DotEnv -Default '8000' -Check $port
    Check 'MCP' 'ASK_API_KEY' $false -DotEnv -Secret -WarnOnly:$legacy -Default 'не нужна для бэкенда api'

    Write-Host ' OpenAI Proxy, переменные среды и mcp\.env:' -ForegroundColor White
    Check 'Proxy' 'ASK_API_KEY' $false -DotEnv -Secret -WarnOnly
    Check 'Proxy' 'PROXY_TOKEN' $true -DotEnv -Secret -Check {
        param($v)
        $k = Get-Setting 'ASK_API_KEY' -DotEnv
        if ($k -and $k.Value -eq $v) { 'не должен совпадать с ASK_API_KEY' }
    }
    Check 'Proxy' 'PROXY_PORT' $false -DotEnv -Default '8789' -Check $port
    Check 'Proxy' 'PROXY_HOST' $false -DotEnv -Default '127.0.0.1'
    Check 'Proxy' 'PROXY_MODEL' $false -DotEnv -Default 'claude-sonnet-5-5'

    if ($script:envWarn -gt 0) { Warn "Предупреждений: $($script:envWarn) (ASK_API_KEY не задана: задайте в mcp\.env или командой setx ASK_API_KEY ...)." }
    if ($script:envBad -eq 0) { Ok 'Переменные среды в порядке [OK]'; return $true }
    Fail "Проблемных переменных: $($script:envBad). Задайте их командой setx ИМЯ ЗНАЧЕНИЕ (и откройте новый терминал) или в mcp\.env (кроме ASK_KEY: он читается только из среды)."
    return $false
}

$envOk = Test-Environment
Write-Host ''
$envExit = if ($envOk) { 0 } else { 1 }

try {
    Info 'Проверка окружения MCP (.venv):'
    $reason = if ($Force) { 'запрошено принудительное пересоздание (-Force)' } else { Test-Venv }

    if (-not $reason) {
        Ok '.venv в порядке: пути соответствуют этой машине, все пакеты установлены [OK]'
        exit $envExit
    }

    Warn "Требуется инициализация: $reason"

    $sysPy = Find-Python
    if (-not $sysPy) {
        Fail 'Не найден Python 3.10 или новее. Установите его с python.org и запустите скрипт снова.'
        exit 1
    }
    Info "Используется Python: $sysPy"

    if (Test-Path -LiteralPath $venvDir) {
        Info 'Удаление старого .venv...'
        Remove-Item -LiteralPath $venvDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $venvDir) {
            Fail 'Не удалось удалить .venv. Остановите серверы (stop_servers.ps1) и повторите.'
            exit 1
        }
    }

    Info 'Создание .venv...'
    & $sysPy -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { Fail 'Не удалось создать .venv'; exit 1 }

    Info 'Обновление pip...'
    & $venvPy -m pip install --upgrade pip --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { Warn 'pip не обновился, продолжаю с текущим' }

    Info 'Установка пакетов из requirements.txt...'
    & $venvPy -m pip install -r $req --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { Fail 'Установка пакетов завершилась ошибкой'; exit 1 }

    $reason = Test-Venv
    if ($reason) { Fail "Проверка после установки не пройдена: $reason"; exit 1 }
    Ok '.venv создан, пакеты установлены [OK]'
    exit $envExit
}
finally {
    Remove-Item -LiteralPath $checkPy -ErrorAction SilentlyContinue
}
