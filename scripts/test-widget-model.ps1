param([string]$AssemblyPath = "")
$ErrorActionPreference = "Stop"
if (-not $AssemblyPath) { $AssemblyPath = Join-Path (Split-Path -Parent $PSScriptRoot) "CodexTokenWidget.exe" }
$assembly = [System.Reflection.Assembly]::LoadFrom($AssemblyPath)
$formType = $assembly.GetType("TokenWidgetForm", $true)
$taskType = $formType.GetNestedType("UsageTask", [System.Reflection.BindingFlags]::NonPublic)
$turnType = $formType.GetNestedType("UsageTurn", [System.Reflection.BindingFlags]::NonPublic)
$task = [Activator]::CreateInstance($taskType, $true)
$task.Revision = "old"
$task.DetailsLoaded = $true
$task.DetailsLoading = $true
$task.DetailError = "old failure"
$turn = [Activator]::CreateInstance($turnType, $true)
$task.Turns.Add($turn)
if ($task.UpdateRevision("old")) { throw "Unchanged revision invalidated details." }
if ($task.Turns.Count -ne 1) { throw "Unchanged details were lost." }
if (-not $task.UpdateRevision("new")) { throw "Changed revision was not detected." }
if ($task.DetailsLoaded -or $task.Turns.Count -ne 0 -or $task.DetailError -ne "") { throw "Stale detail data remains." }
if (-not $task.DetailsLoading) { throw "Inflight ownership was cleared prematurely." }
Write-Output "Native model regression passed: revision invalidation and inflight state."
