<#
.SYNOPSIS
  Регистрирует MCP-сервер ask в Claude Desktop, VS Code (Copilot) и Cline.

.DESCRIPTION
  Добавляет (или обновляет) запись "ask" в конфиге клиента. Остальные серверы в конфиге
  не трогаются. Перед записью делается копия файла с суффиксом .bak-<дата>.
  Ключей и токенов в конфиги не пишется: ASK_API_KEY держите в mcp\.env.

.PARAMETER Client
  claude | vscode | cline | all (по умолчанию all)

.PARAMETER Backend
  api (по умолчанию) | legacy | both. Значение попадает в MCP_BACKEND.

.PARAMETER LocalUrl
  Адрес Node-сервера ASK HTTP (ASK_LOCAL_URL).

.PARAMETER VSCodeUser
  Для vscode писать в пользовательский mcp.json (%APPDATA%\Code\User) с абсолютными путями,
  а не в .vscode\mcp.json этого проекта.

.PARAMETER Remove
  Удалить запись "ask" из конфигов вместо добавления.

.EXAMPLE
  .\register_mcp.ps1
  .\register_mcp.ps1 -Client cline -Backend both
  .\register_mcp.ps1 -Client claude -Remove
#>
[CmdletBinding()]
param(
    [ValidateSet('claude', 'vscode', 'cline', 'all')][string]$Client = 'all',
    [ValidateSet('api', 'legacy', 'both')][string]$Backend = 'api',
    [string]$LocalUrl = 'http://127.0.0.1:8737',
    [switch]$VSCodeUser,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ServerName = 'ask'
$Root = $PSScriptRoot
$McpDir = Join-Path $Root 'mcp'
$Python = Join-Path $McpDir '.venv\Scripts\python.exe'
$Script = Join-Path $McpDir 'server.py'

function Write-Status($name, $ok, $text) {
    if ($ok) { Write-Host ("{0,-16} [OK]   {1}" -f $name, $text) -ForegroundColor Green }
    else { Write-Host ("{0,-16} [FAIL] {1}" -f $name, $text) -ForegroundColor Red }
}

# Читает JSON-файл конфига; если файла нет, возвращает пустой объект.
function Read-JsonConfig($path) {
    if (-not (Test-Path -LiteralPath $path)) { return [pscustomobject]@{} }
    $raw = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) { return [pscustomobject]@{} }
    try { return ($raw | ConvertFrom-Json) }
    catch { throw "Файл $path не разобран как JSON (комментарии не поддерживаются): $($_.Exception.Message)" }
}

# Записывает или удаляет сервер в $path -> $rootKey -> $ServerName, остальное сохраняет.
function Set-McpEntry($path, $rootKey, $entry, [bool]$remove) {
    $cfg = Read-JsonConfig $path
    $existed = Test-Path -LiteralPath $path

    if (-not ($cfg.PSObject.Properties.Name -contains $rootKey)) {
        if ($remove) { return 'нет записи, менять нечего' }
        $cfg | Add-Member -NotePropertyName $rootKey -NotePropertyValue ([pscustomobject]@{})
    }
    $servers = $cfg.$rootKey
    $has = $servers.PSObject.Properties.Name -contains $ServerName

    if ($remove) {
        if (-not $has) { return 'нет записи, менять нечего' }
        $servers.PSObject.Properties.Remove($ServerName)
    }
    elseif ($has) { $servers.$ServerName = $entry }
    else { $servers | Add-Member -NotePropertyName $ServerName -NotePropertyValue $entry }

    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if ($existed) {
        Copy-Item -LiteralPath $path -Destination ("{0}.bak-{1:yyyyMMdd-HHmmss}" -f $path, (Get-Date))
    }
    $json = $cfg | ConvertTo-Json -Depth 30
    [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
    if ($remove) { return 'запись удалена' }
    if ($has) { return 'запись обновлена' }
    return 'запись добавлена'
}

function New-Env {
    return [ordered]@{ MCP_BACKEND = $Backend; ASK_LOCAL_URL = $LocalUrl }
}

# --- Проверки окружения ---
if (-not $Remove) {
    Write-Host 'Проверка окружения:'
    $pyOk = Test-Path -LiteralPath $Python
    Write-Status 'mcp\.venv' $pyOk $(if ($pyOk) { $Python } else { 'не найден: запустите .\init_app.ps1' })
    $srvOk = Test-Path -LiteralPath $Script
    Write-Status 'mcp\server.py' $srvOk $(if ($srvOk) { $Script } else { 'файл не найден' })
    if (-not ($pyOk -and $srvOk)) { Write-Host 'Регистрация прервана.' -ForegroundColor Red; exit 1 }
    Write-Host ''
}

$targets = if ($Client -eq 'all') { @('claude', 'vscode', 'cline') } else { @($Client) }
$failed = 0
Write-Host $(if ($Remove) { 'Удаление регистрации MCP-сервера:' } else { 'Регистрация MCP-сервера:' })

foreach ($t in $targets) {
    try {
        switch ($t) {
            'claude' {
                $path = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
                $entry = [ordered]@{ command = $Python; args = @($Script); env = (New-Env) }
                $res = Set-McpEntry $path 'mcpServers' $entry $Remove.IsPresent
                Write-Status 'Claude Desktop' $true "$res ($path)"
            }
            'cline' {
                # Разные версии Cline читают разные файлы: пишем во все существующие, новый путь (~\.cline) всегда.
                $paths = @(
                    (Join-Path $env:USERPROFILE '.cline\data\settings\cline_mcp_settings.json'),
                    (Join-Path $env:APPDATA 'Code\User\globalStorage\.cline\data\settings\cline_mcp_settings.json'),
                    (Join-Path $env:APPDATA 'Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json')
                )
                if ($env:CLINE_DIR) { $paths = @((Join-Path $env:CLINE_DIR 'data\settings\cline_mcp_settings.json')) + $paths }
                $paths = $paths | Select-Object -Unique | Where-Object { $_ -eq $paths[0] -or (Test-Path -LiteralPath $_) }
                foreach ($path in $paths) {
                    $entry = [ordered]@{ command = $Python; args = @($Script); env = (New-Env); disabled = $false; autoApprove = @() }
                    $res = Set-McpEntry $path 'mcpServers' $entry $Remove.IsPresent
                    Write-Status 'VS Code Cline' $true "$res ($path)"
                }
            }
            'vscode' {
                if ($VSCodeUser) {
                    $path = Join-Path $env:APPDATA 'Code\User\mcp.json'
                    $entry = [ordered]@{ type = 'stdio'; command = $Python; args = @($Script); env = (New-Env) }
                }
                else {
                    $path = Join-Path $Root '.vscode\mcp.json'
                    $entry = [ordered]@{
                        type    = 'stdio'
                        command = '${workspaceFolder}/mcp/.venv/Scripts/python.exe'
                        args    = @('${workspaceFolder}/mcp/server.py')
                        env     = (New-Env)
                    }
                }
                $res = Set-McpEntry $path 'servers' $entry $Remove.IsPresent
                Write-Status 'VS Code Copilot' $true "$res ($path)"
            }
        }
    }
    catch {
        $failed++
        Write-Status $t $false $_.Exception.Message
    }
}

Write-Host ''
if ($failed -gt 0) { Write-Host "Ошибок: $failed" -ForegroundColor Red; exit 1 }
if (-not $Remove) {
    Write-Host 'Дальше:'
    Write-Host ' 1. Запустите Node-сервер ASK HTTP (start_servers.ps1 или npm start).'
    Write-Host ' 2. Полностью перезапустите Claude Desktop (включая значок в трее); в VS Code выполните Developer: Reload Window.'
    if ($Backend -ne 'api') { Write-Host ' 3. Для бэкенда legacy/both задайте ASK_API_KEY в mcp\.env.' }
}
exit 0
