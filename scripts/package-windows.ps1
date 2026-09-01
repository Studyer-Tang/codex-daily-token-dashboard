param(
    [string]$OutputDirectory = "dist",
    [switch]$IncludeBundledNode
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$stagingRoot = Join-Path $projectRoot ".release-staging"
$packageRoot = Join-Path $stagingRoot "CodexTokenWidget"
$outputRoot = Join-Path $projectRoot $OutputDirectory

Push-Location $projectRoot
try {
    & (Join-Path $projectRoot "build-widget.cmd")
    if ($LASTEXITCODE -ne 0) { throw "Widget compilation failed." }

    if (Test-Path -LiteralPath $stagingRoot) {
        $resolvedStaging = (Resolve-Path -LiteralPath $stagingRoot).Path
        if (-not $resolvedStaging.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe staging path: $resolvedStaging"
        }
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

    Copy-Item -LiteralPath "CodexTokenWidget.exe", "server.mjs", "README.md", "CHANGELOG.md", "LICENSE", "start-dashboard.cmd", "stop-dashboard.cmd" -Destination $packageRoot
    Copy-Item -LiteralPath "src", "public" -Destination $packageRoot -Recurse

    if ($IncludeBundledNode) {
        $nodeCommand = Get-Command node.exe -ErrorAction Stop
        $runtime = Join-Path $packageRoot "runtime"
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $runtime "node.exe")
    }

    $zipPath = Join-Path $outputRoot "CodexTokenWidget-windows-x64.zip"
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksumPath = Join-Path $outputRoot "CodexTokenWidget-windows-x64.sha256.txt"
    Set-Content -LiteralPath $checksumPath -Value "$hash  CodexTokenWidget-windows-x64.zip" -Encoding ascii
    Write-Output $zipPath
    Write-Output $checksumPath
}
finally {
    Pop-Location
    if (Test-Path -LiteralPath $stagingRoot) {
        $resolvedStaging = (Resolve-Path -LiteralPath $stagingRoot).Path
        if ($resolvedStaging.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
        }
    }
}
