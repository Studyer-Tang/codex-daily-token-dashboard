$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$temporaryAssembly = Join-Path $projectRoot ("widget-build-" + [Guid]::NewGuid().ToString("N") + ".exe")
$targetAssembly = Join-Path $projectRoot "CodexTokenWidget.exe"
try {
    $sources = @("Widget.cs", "widget\Widget.Models.cs", "widget\Widget.Search.cs") | ForEach-Object { Join-Path $projectRoot $_ }
    Add-Type -Path $sources -ReferencedAssemblies "System.Windows.Forms","System.Drawing","System.Web.Extensions" -OutputAssembly $temporaryAssembly -OutputType WindowsApplication
    if (Test-Path -LiteralPath $targetAssembly) {
        [System.IO.File]::Replace($temporaryAssembly, $targetAssembly, [NullString]::Value)
    } else { [System.IO.File]::Move($temporaryAssembly, $targetAssembly) }
    Write-Output "Built $targetAssembly"
} finally {
    if (Test-Path -LiteralPath $temporaryAssembly) { Remove-Item -LiteralPath $temporaryAssembly -Force }
}
