# Creates a Windows scheduled task that runs the OLJ checker every 10 minutes.
# Run once:  powershell -ExecutionPolicy Bypass -File .\setup-schedule.ps1
# Remove later:  Unregister-ScheduledTask -TaskName "OLJ Job Alerts" -Confirm:$false

$dir  = $PSScriptRoot

# Find node.exe: PATH first, then the usual install folders (a terminal opened
# before Node was installed may not have it on PATH yet).
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $node = @("$env:LOCALAPPDATA\nodejs\node.exe", "C:\Program Files\nodejs\node.exe", "C:\Program Files (x86)\nodejs\node.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $node) { Write-Error "Could not find node.exe. Install Node.js from nodejs.org, then run this again."; exit 1 }
Write-Host "Using Node at: $node"

$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"Set-Location '$dir'; & '$node' checker.mjs`""
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName "OLJ Job Alerts" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Checks OnlineJobs.ph every 10 min and alerts phone via ntfy" -Force |
  Select-Object TaskName, State

Get-ScheduledTask -TaskName "OLJ Job Alerts" | Get-ScheduledTaskInfo | Select-Object NextRunTime
