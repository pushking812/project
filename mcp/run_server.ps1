# Starts the MCP server in HTTP mode (server.py --http).
# Usage:  .\run_server.ps1 [port]      e.g.  .\run_server.ps1 8100
# Variables already set outside are not changed.
# Backend (MCP_BACKEND): api (default) - tools call our HTTP API (ask-code-server, ASK_LOCAL_URL, run `npm start` first);
#                        legacy - old tools ask/get_usage/code call the Ask site directly (needs ASK_API_KEY);
#                        both - new tools plus legacy_ask, legacy_get_usage, legacy_code.
# The API key is NOT stored here: set $env:ASK_API_KEY or put it in .env (legacy backend only)

param([int]$Port = 0)

Set-Location -LiteralPath $PSScriptRoot

if (-not $env:MCP_BACKEND)    { $env:MCP_BACKEND = 'api' }
if (-not $env:ASK_LOCAL_URL)  { $env:ASK_LOCAL_URL = 'http://127.0.0.1:8737' }
if (-not $env:ASK_BASE_URL)   { $env:ASK_BASE_URL = 'https://ask.oryxml.com' }
if (-not $env:ASK_HOST)       { $env:ASK_HOST = '127.0.0.1' }
if (-not $env:ASK_PORT)       { $env:ASK_PORT = '8000' }
if ($Port -gt 0)              { $env:ASK_PORT = "$Port" }
# $env:ASK_API_KEY = 'sk-ask-...'   # not recommended, better use .env

Write-Host "Backend: $env:MCP_BACKEND"
if ($env:MCP_BACKEND -eq 'api') { Write-Host "API URL: $env:ASK_LOCAL_URL (ask-code-server must be running)" }
else                            { Write-Host "Ask site: $env:ASK_BASE_URL" }
Write-Host "Server:  http://$($env:ASK_HOST):$($env:ASK_PORT)/mcp"

if ($env:MCP_BACKEND -ne 'api' -and -not $env:ASK_API_KEY -and -not (Test-Path -LiteralPath '.env')) {
    Write-Warning 'ASK_API_KEY is not set and .env not found: legacy tools will return a key error.'
}

$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $py)) {
    Write-Error '.venv not found. Create it: python -m venv .venv; .venv\Scripts\python -m pip install -r requirements.txt'
    exit 1
}

& $py server.py --http
exit $LASTEXITCODE
