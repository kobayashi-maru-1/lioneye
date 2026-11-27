<#
.SYNOPSIS
  Runs the build lab's ladder crawl at night only: a scheduled task that resumes it each night in a time window.

.DESCRIPTION
  The crawl (market.py popularity --crawl) reads about 300 public ladder characters; GGG's rate limit makes that
  about 3 hours, two night windows. This registers a Windows scheduled task that runs it from -Start to -Until each night for
  -Nights nights, then expires and deletes itself. Each night resumes where the last one stopped
  (--only-unfinished: once the league's crawl is finished, the remaining nights do nothing, so it never starts a
  new crawl on its own). Progress goes to %LOCALAPPDATA%\poe-build-expert\crawl-log.txt.

  After each night that read something, the crawl and its reference builds are pushed to the repo's crawl-data
  branch (--publish; git and this clone's GitHub sign-in), so chats outside Claude Code can use them.

  Outside the window nothing is read, even when the task is started by hand (--from/--until), and every request,
  rate-limit wait included, ends a minute before -Until.

  The task runs only while you're signed in (a locked screen is fine) and doesn't wake the PC: a night the PC is
  asleep or signed out is skipped.

.EXAMPLE
  .\schedule-crawl.ps1 -League Covens                 # 01:00-04:00 for 3 nights (one spare)
  .\schedule-crawl.ps1 -League Covens -Nights 4 -Start 00:30 -Until 03:30
  .\schedule-crawl.ps1 -Remove
#>
param(
    [string]$League,
    [string]$Start = "01:00",
    [string]$Until = "04:00",
    [int]$Nights = 3,
    [switch]$Remove
)

$TaskName = "Lioneye build-lab ladder crawl"

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        "Removed '$TaskName'."
    } else {
        "No task named '$TaskName'."
    }
    return
}

if (-not $League) { throw "Give -League (the league name market.py prices reports, e.g. Covens)." }

$py = Join-Path $env:LOCALAPPDATA "poe-build-expert\venv\Scripts\pythonw.exe"
if (-not (Test-Path $py)) { throw "No windowless Python at $py (the poe-build-expert venv)." }
$market = Join-Path $PSScriptRoot "market.py"
$log = Join-Path $env:LOCALAPPDATA "poe-build-expert\crawl-log.txt"

$startAt = [datetime]::ParseExact($Start, "HH:mm", $null)
$untilAt = [datetime]::ParseExact($Until, "HH:mm", $null)
$window = $untilAt - $startAt
if ($window.TotalMinutes -le 0) { $window = $window.Add([timespan]::FromDays(1)) }

$arguments = @(
    "`"$market`"", "popularity", "--crawl", "--only-unfinished", "--publish",
    "--from", $Start, "--until", $Until, "--league", "`"$League`"", "--log", "`"$log`""
) -join " "
$action = New-ScheduledTaskAction -Execute $py -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $startAt
# Expire after the last night; the task deletes itself a day later.
$trigger.EndBoundary = (Get-Date).Date.AddDays($Nights).Add($untilAt.TimeOfDay).AddMinutes(30).ToString("s")
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ($window + [timespan]::FromMinutes(15)) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -DeleteExpiredTaskAfter ([timespan]::FromDays(1))
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description "Build lab ladder crawl ($League), $Start-$Until, $Nights nights; resumes each night" `
    -Force | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
$info = $t | Get-ScheduledTaskInfo
[pscustomobject]@{
    Task      = $TaskName
    League    = $League
    Window    = "$Start-$Until"
    NextRun   = $info.NextRunTime
    Expires   = $t.Triggers[0].EndBoundary
    Log       = $log
}
