$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeExecutable = Join-Path $projectRoot "runtime\node.exe"
if (-not (Test-Path -LiteralPath $nodeExecutable)) { $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
& $nodeExecutable -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if ($LASTEXITCODE -ne 0) { throw "Node.js 22.13 or newer is required." }
$requestedPort = 4817
if ($env:CODEX_TOKEN_PORT) { $requestedPort = [int]$env:CODEX_TOKEN_PORT }
if ($requestedPort -lt 1 -or $requestedPort -gt 65535) { throw "Use a fixed port between 1 and 65535." }
$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $requestedPort
try { $listener.Start() } catch { throw "Port $requestedPort is occupied. No existing process was changed." } finally { $listener.Stop() }
$dashboardProcess = Start-Process -WindowStyle Hidden -FilePath $nodeExecutable -ArgumentList 'server.mjs' -WorkingDirectory $projectRoot -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    if ($dashboardProcess.HasExited) { throw "Dashboard failed to start." }
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$requestedPort/api/health" -TimeoutSec 1
        if ($health.service -eq "codex-daily-token-dashboard") {
            Start-Process "http://127.0.0.1:$requestedPort"
            exit 0
        }
    } catch {}
}
throw "Dashboard did not become ready. Check the server startup manually."
