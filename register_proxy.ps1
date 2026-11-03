<#
.SYNOPSIS
  Проверяет OpenAI Proxy и выводит параметры для подключения к Cline и VS Code Copilot.

.DESCRIPTION
  Настройки провайдера моделей Cline и Copilot хранят токен в защищённом хранилище VS Code,
  поэтому записать их файлом нельзя. Скрипт делает всё, что можно автоматизировать:
    1. читает PROXY_PORT / PROXY_HOST / PROXY_MODEL / PROXY_TOKEN из переменных среды и mcp\.env;
    2. проверяет /healthz и (если токен найден) /v1/models с токеном;
    3. печатает Base URL, Model ID и куда вставить токен;
    4. по -CopyToken кладёт токен в буфер обмена (на экран он не выводится).

.EXAMPLE
  .\register_proxy.ps1 -CopyToken
#>
[CmdletBinding()]
param(
    [switch]$CopyToken
)

$ErrorActionPreference = 'Stop'
$EnvFile = Join-Path $PSScriptRoot 'mcp\.env'

# Значения из mcp\.env (KEY=VALUE, # - комментарий).
$fileVars = @{}
if (Test-Path -LiteralPath $EnvFile) {
    foreach ($line in [IO.File]::ReadAllLines($EnvFile, [Text.Encoding]::UTF8)) {
        $l = $line.Trim()
        if ($l -eq '' -or $l.StartsWith('#')) { continue }
        $i = $l.IndexOf('=')
        if ($i -lt 1) { continue }
        $v = $l.Substring($i + 1).Trim().Trim('"').Trim("'")
        $fileVars[$l.Substring(0, $i).Trim()] = $v
    }
}
function Get-Setting($name, $default) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($v)) { $v = [Environment]::GetEnvironmentVariable($name, 'User') }
    if ([string]::IsNullOrWhiteSpace($v)) { $v = $fileVars[$name] }
    if ([string]::IsNullOrWhiteSpace($v)) { return $default }
    return $v
}

$hostName = Get-Setting 'PROXY_HOST' '127.0.0.1'
$port = Get-Setting 'PROXY_PORT' '8789'
$model = Get-Setting 'PROXY_MODEL' 'claude-sonnet-5-5'
$token = Get-Setting 'PROXY_TOKEN' ''
$base = "http://${hostName}:${port}"

function Write-Status($name, $state, $text) {
    $color = @{ OK = 'Green'; FAIL = 'Red'; WARN = 'Yellow' }[$state]
    Write-Host ("{0,-22} [{1}] {2}" -f $name, $state, $text) -ForegroundColor $color
}

Write-Host 'Проверка OpenAI Proxy:'
$problems = 0

try {
    $r = Invoke-WebRequest -Uri "$base/healthz" -UseBasicParsing -TimeoutSec 5
    Write-Status 'Прокси /healthz' 'OK' "HTTP $($r.StatusCode), $base"
}
catch {
    $problems++
    Write-Status 'Прокси /healthz' 'FAIL' "не отвечает на $base. Запустите start_servers.ps1"
}

if ([string]::IsNullOrWhiteSpace($token)) {
    $problems++
    Write-Status 'PROXY_TOKEN' 'FAIL' 'не найден ни в среде, ни в mcp\.env'
}
else {
    Write-Status 'PROXY_TOKEN' 'OK' '*** (задан)'
    try {
        $r = Invoke-WebRequest -Uri "$base/v1/models" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 5
        Write-Status 'Прокси /v1/models' 'OK' "токен принят, HTTP $($r.StatusCode)"
    }
    catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 401) { Write-Status 'Прокси /v1/models' 'FAIL' 'токен отклонён (401): перезапустите прокси после смены токена'; $problems++ }
        else { Write-Status 'Прокси /v1/models' 'WARN' 'проверить не удалось (прокси не запущен?)' }
    }
}

Write-Host ''
Write-Host 'Параметры подключения (одни и те же для Cline и Copilot):'
Write-Host "  Base URL : $base/v1"
Write-Host "  Model ID : $model"
Write-Host '  API Key  : значение PROXY_TOKEN (не ASK_API_KEY)'
Write-Host ''
Write-Host 'Cline: шестерёнка -> API Provider = "OpenAI Compatible" -> вставьте Base URL, API Key, Model ID.'
Write-Host 'Copilot: Command Palette -> "Chat: Manage Language Models" -> Add -> Custom Endpoint (или OpenAI Compatible).'
Write-Host 'Подробно: docs\clients-setup.md'

if ($CopyToken -and -not [string]::IsNullOrWhiteSpace($token)) {
    Set-Clipboard -Value $token
    Write-Host ''
    Write-Host 'PROXY_TOKEN скопирован в буфер обмена. Вставьте его в поле API Key.' -ForegroundColor Green
}

if ($problems -gt 0) { exit 1 }
exit 0
