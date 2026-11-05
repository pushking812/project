<#
  Runs the 18 checks for Cline CLI (MCP: files, output_files, auto-session, wrappers)
  and writes everything to a log.

  Before: Cline CLI is installed (npm i -g cline), the "ask" MCP server is connected in Cline,
  the Ask server runs with ASK_KEY (npm start) and ASK_ROOT is the same folder as -Dir.

  Run from the project folder:
    powershell -ExecutionPolicy Bypass -File test\cline-check.ps1 -Dir C:\Users\user\Desktop\ask-workspace-test
    ... -Phase restart        (only check 13, after restarting Cline, MCP and the server)
    ... -Only 1,2,4           (only these checks)
    ... -Server myname        (if the MCP server is not called "ask" in Cline)

  The prompts go to Cline through stdin, so quotes and Cyrillic are not mangled.
  PASS/FAIL below is only a substring/file check; read the log for the real answers.
#>
param(
  [string]$Dir = (Join-Path $env:TEMP 'cline-check'),
  [ValidateSet('main', 'restart')][string]$Phase = 'main',
  [string[]]$Only = @(),   # string, not int[]: with -File "7,8,9" would become the number 789
  [string]$Server = 'ask',
  [int]$Timeout = 300,
  [string]$Log = ''
)

$ErrorActionPreference = 'Continue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$project = Split-Path -Parent $PSScriptRoot
if (-not $Log) { $Log = Join-Path $project ("cline-check-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date)) }

if (-not (Get-Command cline -ErrorAction SilentlyContinue)) {
  Write-Host 'cline not found in PATH (npm i -g cline).'; exit 2
}

# fixtures: do not touch an existing folder's files except the three we need
if (-not ((Test-Path (Join-Path $Dir 'hello.xlsx')) -and (Test-Path (Join-Path $Dir 'calc.py')) -and (Test-Path (Join-Path $Dir 'doc.pdf')))) {
  & node (Join-Path $PSScriptRoot 'cline-prep.mjs') $Dir
  if ($LASTEXITCODE -ne 0) { Write-Host 'could not prepare files'; exit 2 }
}

function Add-Log([string]$s) { [System.IO.File]::AppendAllText($Log, $s + "`r`n", $utf8) }

# the server root must be -Dir, otherwise files written by the server are not where the checks look
try {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8737/health' -TimeoutSec 5
  $want = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\', '/')
  $have = ([string]$h.root).TrimEnd('\', '/')
  if ($have -and ($have -ne $want)) {
    Write-Host "Server root is $have, but -Dir is $want."
    Write-Host "Run with: -Dir $have   (or set the root: POST /workspace, or ASK_ROOT)."
    exit 2
  }
} catch { Write-Host "Warning: /health on 127.0.0.1:8737 did not answer; the root was not checked." }

$s = "(MCP-сервер в Cline называется '$Server'.) "

# id, title, prompt, file that must appear (or ''), regex that must match (or ''), regex that must NOT match (or '')
$cases = @(
  @(1, 'analyze xlsx', 'Используй MCP-инструмент analyze: path="hello.xlsx", prompt="Какие листы и строки в файле?"', '', 'Apple|Pear|Sales', ''),
  @(2, 'ask files=[calc.py]', 'Вызови MCP-инструмент ask с prompt="Что делает этот скрипт?" и files=["calc.py"]', '', 'add|слож|сумм', ''),
  @(3, 'ask 3 files', 'Вызови ask с files=["hello.xlsx","calc.py","doc.pdf"] и prompt="Назови по одной фразе про каждый файл"', '', '', ''),
  @(4, 'ask without files', 'Вызови ask с prompt="Сколько будет 2+2?" без files', '', '"toolName":"ask__ask"[^\n]*"output":\{"content":\[\{"type":"text","text":".{0,60}4[^\n]*"isError":false', 'Error executing|"isError":true'),
  @(5, 'files ../secret.txt', 'Вызови ask с files=["../secret.txt"] и prompt="прочитай"', '', 'Error executing tool ask: 403 outside', ''),
  @(6, 'files .env', 'Вызови ask с files=[".env"] и prompt="прочитай"', '', 'Error executing tool ask: 403 secret', 'DUMMY_KEY|not-a-real-secret'),
  @(7, 'analyze write', 'Вызови analyze: path="hello.xlsx", prompt="Создай report.xlsx с итогами по таблице", mode="write"', 'report.xlsx', 'output_files', ''),
  @(8, 'execute output_files', 'Вызови execute с prompt="Создай файл notes.txt с текстом hi" и files=["calc.py"]', 'notes.txt', 'output_files', ''),
  @(9, 'start_task + task_status', 'Вызови start_task с prompt="Создай out.txt" и files=["calc.py"], затем task_status с полученным id (повтори, пока задача не завершится)', 'out.txt', 'outputFiles', ''),
  @(10, 'session: remember', 'Вызови execute с prompt="Запомни слово БАНАН только в этой беседе, не записывай в память проекта. Ничего не делай, только подтверди."', '', '', ''),
  @(11, 'session_info', 'Вызови session_info', '', 'requests', ''),
  @(12, 'session: recall', 'Вызови execute с prompt="Какое слово я просил запомнить?"', '', 'БАНАН', ''),
  @(13, 'session after restart', 'Вызови execute с prompt="Какое слово я просил запомнить?"', '', 'БАНАН', ''),
  @(14, 'new_session forgets', 'Вызови new_session, затем execute с prompt="Какое слово я просил запомнить?"', '', '', 'слово\W{0,3}БАНАН|БАНАН\W{0,3}$'),
  @(15, 'review', 'Вызови review с path="calc.py"', '', '', ''),
  @(16, 'summarize pdf', 'Вызови summarize с path="doc.pdf"', '', 'twelve|12|двенадцат', ''),
  @(17, 'explain', 'Вызови explain с path="calc.py"', '', '', ''),
  @(18, 'plan', 'Вызови plan с prompt="Как добавить в calc.py деление?"', '', '', '')
)

if ($Phase -eq 'restart') { $run = @($cases | Where-Object { $_[0] -eq 13 }) }
else { $run = @($cases | Where-Object { $_[0] -ne 13 }) }
if ($Only.Count -gt 0) {
  $onlyN = @($Only -join ',' -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [int]$_ })
  $run = @($run | Where-Object { $onlyN -contains $_[0] })
}

Add-Log ("Cline check {0:u}" -f (Get-Date))
Add-Log "Dir: $Dir   Phase: $Phase   Server: $Server   Timeout: $Timeout s"
Add-Log ("cline: " + ((& cline --version 2>&1) -join ' '))
Add-Log ('=' * 70)

$results = @()
foreach ($c in $run) {
  $id = $c[0]; $title = $c[1]; $prompt = $s + $c[2]
  foreach ($f in 'report.xlsx', 'notes.txt', 'out.txt') {
    if ($c[3] -eq $f) { Remove-Item (Join-Path $Dir $f) -ErrorAction SilentlyContinue }
  }
  Write-Host ("[{0}] {1} ..." -f $id, $title) -NoNewline
  Add-Log ("### {0}. {1}" -f $id, $title)
  Add-Log ("PROMPT: " + $c[2])
  $t0 = Get-Date
  # prompt as an argument: cline's PowerShell shim does not forward piped stdin (checked with cline 3.0.74)
  $arg = $prompt -replace '"', '\"'
  $out = (& cline -y --json --timeout $Timeout -c $Dir $arg 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $sec = [int]((Get-Date) - $t0).TotalSeconds
  Add-Log ("EXIT: $code   TIME: $sec s")
  Add-Log "OUTPUT:"
  Add-Log $out

  $problems = @()
  if ($code -ne 0) { $problems += "exit $code" }
  if ($c[3] -and -not (Test-Path (Join-Path $Dir $c[3]))) { $problems += "no file $($c[3])" }
  if ($c[4] -and $out -notmatch $c[4]) { $problems += "no match /$($c[4])/" }
  if ($c[5] -and $out -match $c[5]) { $problems += "unexpected /$($c[5])/" }
  if ($id -eq 13) {
    # a hard check: the word must be in done.answer of execute AND the session must be an old one (requests > 1);
    # the bare word also shows up in this script's own text, and a new session would pass a plain match
    $m = [regex]::Matches($out, '\\"requests\\":\s*(\d+)')
    $req = if ($m.Count -gt 0) { [int]$m[$m.Count - 1].Groups[1].Value } else { 0 }
    if ($req -le 1) { $problems += "requests=$req (a new session, not the old one)" }
    if ($out -notmatch '\\"answer\\":\s*\\"[^\\]*БАНАН') { $problems += 'no БАНАН in done.answer' }
  }
  $status = if ($problems.Count -eq 0) { 'PASS' } else { 'FAIL' }
  $note = ($problems -join '; ')
  Add-Log ("RESULT: $status $note")
  Add-Log ('-' * 70)
  Write-Host (" {0} {1} ({2} s)" -f $status, $note, $sec)
  $results += [pscustomobject]@{ Id = $id; Title = $title; Result = $status; Note = $note }
}

Add-Log 'SUMMARY'
foreach ($r in $results) { Add-Log ("{0,3} {1,-28} {2} {3}" -f $r.Id, $r.Title, $r.Result, $r.Note) }
Add-Log 'Checks 3, 5, 6, 15, 17, 18 and the tool-call arguments (is files an array?) need reading by eye.'

Write-Host ''
Write-Host "Log: $Log"
Write-Host 'In the log look at the tool call of checks 1-3: files must be a JSON array, not a string.'
