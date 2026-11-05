# Starts the Telegram bot (telegram_bot.py).
# Usage:  .\run_bot.ps1
# Settings come from mcp\.env or the environment:
#   TELEGRAM_BOT_TOKEN        required, from @BotFather
#   TELEGRAM_ALLOWED_USER_IDS required, e.g. 123456789
#   TELEGRAM_MCP_URL          default http://127.0.0.1:8000/mcp (server.py --http)
#   TELEGRAM_DEFAULT_MODE     plan (edits, all), TELEGRAM_ALLOW_DANGEROUS=0|1
# The MCP server must be running: .\run_server.ps1, or /svc start in the bot itself.
# The token is NOT stored here: put it in mcp\.env (that file is in .gitignore) or setx TELEGRAM_BOT_TOKEN

Set-Location -LiteralPath $PSScriptRoot

$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $py)) {
    Write-Error '.venv not found. Create it: python -m venv .venv; .venv\Scripts\python -m pip install -r requirements.txt'
    exit 1
}

if (-not $env:TELEGRAM_MCP_URL) { $env:TELEGRAM_MCP_URL = 'http://127.0.0.1:8000/mcp' }

if (-not $env:TELEGRAM_BOT_TOKEN) {
    Write-Warning 'TELEGRAM_BOT_TOKEN is not set in the environment: the bot will look in mcp\.env (docs/telegram-bot.md).'
}

& $py telegram_bot.py
exit $LASTEXITCODE
