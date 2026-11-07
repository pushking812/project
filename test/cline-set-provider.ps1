# Переключает lastUsedProvider в providers.json Cline. Ключи не читает и не выводит.
# Запуск (из папки project):
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\cline-set-provider.ps1            # поставить openai-compatible
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\cline-set-provider.ps1 -Provider openai
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\cline-set-provider.ps1 -Show      # только показать текущее
# Перед запуском закройте Cline CLI и Kanban, иначе они перезапишут файл.
param(
  [string]$Provider = 'openai-compatible',
  [string]$File = (Join-Path $env:USERPROFILE '.cline\data\settings\providers.json'),
  [switch]$Show
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $File)) { Write-Host "Нет файла: $File"; exit 1 }
$text = [IO.File]::ReadAllText($File)
$rx = '"lastUsedProvider"\s*:\s*"([^"]*)"'
$m = [regex]::Match($text, $rx)
if (-not $m.Success) { Write-Host 'В файле нет lastUsedProvider.'; exit 1 }
$cur = $m.Groups[1].Value
Write-Host "Сейчас: $cur"
if ($Show) { exit 0 }
if ($cur -eq $Provider) { Write-Host 'Уже стоит нужное, ничего не меняю.'; exit 0 }
$bak = "$File.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item $File $bak
$new = [regex]::Replace($text, $rx, ('"lastUsedProvider": "' + $Provider + '"'), 1)
[void]($new | ConvertFrom-Json)   # проверка, что JSON остался корректным
[IO.File]::WriteAllText($File, $new, (New-Object Text.UTF8Encoding($false)))
Write-Host "Поставил: $Provider"
Write-Host "Копия: $bak"
