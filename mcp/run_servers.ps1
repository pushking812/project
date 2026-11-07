# Starts two MCP servers, each in its own window:
#   ask        (all except office, vba, browser)  http://127.0.0.1:8000/mcp
#   ask-extra  (office, vba, browser)             http://127.0.0.1:8001/mcp
# Usage:  .\run_servers.ps1
# In Cline add a second MCP server "ask-extra" with the URL above (same headers as "ask").
# Tool names of office/vba/browser become ask-extra__... (the proxy puts them right after ask__...).

Set-Location -LiteralPath $PSScriptRoot
$script = Join-Path $PSScriptRoot 'run_server.ps1'

foreach ($part in 'main', 'office') {
    Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$script`"", '-Part', $part
}
Write-Host 'ask:       http://127.0.0.1:8000/mcp'
Write-Host 'ask-extra: http://127.0.0.1:8001/mcp'
