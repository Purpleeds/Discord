# Installs the notifier the way people do on a real Windows PC and checks it
# opens every time:
#   1. a fresh install with the installer (as if double-clicked) starts the app
#   2. starting it again by hand shows its window (one copy keeps running)
#   3. starting it at Windows sign-in (--hidden) keeps it running in the tray
#   4. an older release, updated the way the app updates itself
#      (installer --updated /S --force-run, then the old app quits), comes
#      back on its own as the new version - signed in and signed out
# Used by .github/workflows/notifier.yml (windows-latest).
#   pwsh test/install-test.ps1 -NewSetup dist/Chat-Notifier-Setup-1.2.0.exe -NewVersion 1.2.0 -OldSetup old/Chat-Notifier-Setup-1.1.0.exe
param(
  [Parameter(Mandatory)] [string] $NewSetup,
  [Parameter(Mandatory)] [string] $NewVersion,
  [string] $OldSetup = ''
)
$ErrorActionPreference = 'Stop'
$NewSetup = (Resolve-Path $NewSetup).Path
if ($OldSetup) { $OldSetup = (Resolve-Path $OldSetup).Path }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\chat-notifier'
$exe = Join-Path $installDir 'Chat Notifier.exe'
$dataDir = Join-Path $env:APPDATA 'Chat Notifier'
$script:pass = 0; $script:fail = 0

function Check([string] $name, [bool] $ok, $extra = '') {
  if ($ok) { $script:pass++; Write-Host "ok   $name" }
  else { $script:fail++; Write-Host "FAIL $name $extra" }
}
function Wait-Until([scriptblock] $test, [int] $seconds = 45) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $test) { return $true }; Start-Sleep -Milliseconds 500 }
  return [bool](& $test)
}
function AppProcesses { @(Get-Process -Name 'Chat Notifier' -ErrorAction SilentlyContinue) }
function AppWindow { @(AppProcesses | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like 'Chat Notifier*' }) }
function InstalledVersion { if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { '' } }
function Stop-App {
  AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  Wait-Until { (AppProcesses).Count -eq 0 } 20 | Out-Null
}
function Uninstall {
  Stop-App
  $un = Join-Path $installDir 'Uninstall Chat Notifier.exe'
  if (Test-Path $un) { Start-Process $un -ArgumentList '/S' -Wait; Wait-Until { -not (Test-Path $exe) } 30 | Out-Null }
  if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue }
}
function Write-SignedIn {
  # an account that can't connect (nothing listens there): the app must still open
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  '{"server":"http://127.0.0.1:9","username":"ci","token":"not-a-real-token"}' | Set-Content -Path (Join-Path $dataDir 'config.json') -Encoding ascii
}
function Show-Log {
  $log = Join-Path $dataDir 'notifier.log'
  if (Test-Path $log) { Write-Host '--- notifier.log'; Get-Content $log -Tail 40 | ForEach-Object { Write-Host "    $_" } }
}

Uninstall

# 1. fresh install, run like a double-click (one-click installer, starts the app when done)
function Show-State([string] $why) {
  Write-Host "--- $why"
  Write-Host "    processes: $((Get-Process | Where-Object { $_.Name -match 'Chat|Setup|Notifier|Au_|nsis' } | ForEach-Object { "$($_.Name)#$($_.Id)" }) -join ', ')"
  $progs = Join-Path $env:LOCALAPPDATA 'Programs'
  if (Test-Path $progs) { Write-Host "    Programs: $((Get-ChildItem $progs -Name) -join ', ')" }
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {
    $v = Get-ItemProperty $_.PSPath
    if ($v.DisplayName -match 'Chat') { Write-Host "    uninstall entry: $($v.DisplayName) $($v.DisplayVersion) at $($v.InstallLocation)" }
  }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process $NewSetup -PassThru
Check 'installer finishes' ($p.WaitForExit(180000))
Write-Host "    installer exit code $($p.ExitCode) after $([int]$sw.Elapsed.TotalSeconds)s"
Show-State 'right after the installer process exited'
Check 'installed (within 2 minutes)' (Wait-Until { Test-Path $exe } 120)
Write-Host "    installed after $([int]$sw.Elapsed.TotalSeconds)s"
Show-State 'after waiting for the files'
Check "installed version is $NewVersion" ((InstalledVersion) -eq $NewVersion) (InstalledVersion)
Check 'the app starts after installing and shows its window' (Wait-Until { (AppWindow).Count -gt 0 } 60) ((AppProcesses | ForEach-Object { $_.MainWindowTitle }) -join ',')

# 2. started again by hand while it runs: the running copy shows its window, no second copy stays
Stop-App
Start-Process $exe
Check 'starts by hand (signed out)' (Wait-Until { (AppWindow).Count -gt 0 } 45)
$second = Start-Process $exe -PassThru
Check 'a second start exits by itself' ($second.WaitForExit(20000))
Check 'the first copy still runs with its window' ((AppWindow).Count -gt 0)

Stop-App
Write-SignedIn
Start-Process $exe
Check 'starts by hand (signed in, chat unreachable)' (Wait-Until { (AppWindow).Count -gt 0 } 45)
Show-Log

# 3. Windows sign-in start: no window, keeps running in the tray
Stop-App
Start-Process $exe -ArgumentList '--hidden'
Start-Sleep -Seconds 12
Check 'hidden start keeps running' ((AppProcesses).Count -gt 0)
Check 'hidden start shows no window' ((AppWindow).Count -eq 0)

# 4. updating from an older release the way electron-updater does it
if ($OldSetup) {
  foreach ($signedIn in @($false, $true)) {
    $label = if ($signedIn) { 'signed in' } else { 'signed out' }
    Uninstall
    Start-Process $OldSetup -ArgumentList '/S' -Wait
    Wait-Until { Test-Path $exe } 30 | Out-Null
    $old = InstalledVersion
    if ($signedIn) { Write-SignedIn }
    Start-Process $exe
    Check "old version $old opens ($label)" (Wait-Until { (AppWindow).Count -gt 0 } 45)
    # quitAndInstall(silent, forceRun): start the installer, then the app quits
    $inst = Start-Process $NewSetup -ArgumentList '--updated', '/S', '--force-run' -PassThru
    Start-Sleep -Milliseconds 300
    AppProcesses | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    Start-Sleep -Milliseconds 500
    AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Check "update installer finishes ($label)" ($inst.WaitForExit(180000))
    Check "updated to $NewVersion ($label)" ((InstalledVersion) -eq $NewVersion) (InstalledVersion)
    Check "the app comes back by itself after the update ($label)" (Wait-Until { (AppWindow).Count -gt 0 } 60) ((AppProcesses).Count)
    Show-Log
  }
}

Stop-App
Write-Host "passed $script:pass, failed $script:fail"
if ($script:fail) { exit 1 }
