# Installs the Microsoft Store package (MSIX/.appx) on Windows and starts it,
# the way the Store would. Windows only installs signed packages, so this
# signs a COPY with a throwaway test certificate made here (trusted on this
# test machine only). The package uploaded to the Store stays unsigned - the
# Store signs it. Used by .github/workflows/notifier.yml.
#   pwsh test/store-test.ps1 -Package dist/Chat-Notifier-1.3.0-store.appx
param([Parameter(Mandatory)] [string] $Package)
$ErrorActionPreference = 'Stop'
$Package = (Resolve-Path $Package).Path
$script:pass = 0; $script:fail = 0
function Check([string] $name, [bool] $ok, $extra = '') {
  if ($ok) { $script:pass++; Write-Host "ok   $name" } else { $script:fail++; Write-Host "FAIL $name $extra" }
}
function Wait-Until([scriptblock] $test, [int] $seconds = 45) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $test) { return $true }; Start-Sleep -Milliseconds 500 }
  return [bool](& $test)
}
function AppProcesses { @(Get-Process -Name 'Chat Notifier' -ErrorAction SilentlyContinue) }
function AppWindow { @(AppProcesses | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like 'Chat Notifier*' }) }
function Stop-App { AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue; Wait-Until { (AppProcesses).Count -eq 0 } 20 | Out-Null }

# what's inside: name, publisher, startup task
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($Package)
$manifest = [xml](New-Object IO.StreamReader(($zip.Entries | Where-Object FullName -eq 'AppxManifest.xml').Open())).ReadToEnd()
$zip.Dispose()
$publisher = $manifest.Package.Identity.Publisher
Write-Host "package: $($manifest.Package.Identity.Name) $($manifest.Package.Identity.Version) by $publisher"
Check 'package declares a startup task (Start with Windows)' ($manifest.OuterXml -match 'windows\.startupTask')
Check 'package runs as a full desktop app' ($manifest.OuterXml -match 'runFullTrust')

# sign a copy with a test certificate for this machine
$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature -FriendlyName 'Chat Notifier CI test' `
  -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$pw = ConvertTo-SecureString -String 'ci-test-only' -Force -AsPlainText
$pfx = Join-Path $env:RUNNER_TEMP 'store-test.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pw | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' -Password $pw | Out-Null
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' | Sort-Object FullName -Descending | Select-Object -First 1
$copy = Join-Path $env:RUNNER_TEMP 'store-test.appx'
Copy-Item $Package $copy -Force
& $signtool.FullName sign /fd SHA256 /f $pfx /p 'ci-test-only' $copy | Out-Host
Check 'test copy signed' ($LASTEXITCODE -eq 0)

Add-AppxPackage -Path $copy
$pkg = Get-AppxPackage -Name $manifest.Package.Identity.Name
Check 'installs like a Store app' ([bool]$pkg)
$appId = $manifest.Package.Applications.Application.Id
$aumid = "$($pkg.PackageFamilyName)!$appId"
$dataDir = Join-Path $env:LOCALAPPDATA "Packages\$($pkg.PackageFamilyName)\LocalCache\Roaming\Chat Notifier"

# first start (signed out): the sign-in window
Start-Process "shell:AppsFolder\$aumid"
Check 'starts from the Start menu and shows the sign-in window' (Wait-Until { (AppWindow).Count -gt 0 } 90) ((AppProcesses).Count)
Stop-App
$log = Join-Path $dataDir 'notifier.log'
Check 'keeps its log in the package folder' (Wait-Until { Test-Path $log } 10) $dataDir
if (Test-Path $log) { Get-Content $log -Tail 5 | ForEach-Object { Write-Host "    $_" } }

# signed in, started the way Windows does at sign-in: keeps running, tray + a "running" card
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
'{"server":"http://127.0.0.1:9","username":"ci","token":"not-a-real-token"}' | Set-Content -Path (Join-Path $dataDir 'config.json') -Encoding ascii
Start-Process "shell:AppsFolder\$aumid"
Check 'signed in: keeps running' (Wait-Until { (AppProcesses).Count -gt 0 } 60)
Start-Sleep -Seconds 6
Check 'signed in: still running after a few seconds' ((AppProcesses).Count -gt 0)
Check 'signed in: knows it is the Store version' ((Get-Content $log -Raw) -match 'Microsoft Store version' -and (Get-Content $log -Raw) -match 'ready: signed in')
Get-Content $log -Tail 6 | ForEach-Object { Write-Host "    $_" }
Stop-App

Remove-AppxPackage -Package $pkg.PackageFullName
Check 'uninstalls cleanly' (-not (Get-AppxPackage -Name $manifest.Package.Identity.Name))
Remove-Item $pfx, $copy -Force -ErrorAction SilentlyContinue
Write-Host "passed $script:pass, failed $script:fail"
if ($script:fail) { exit 1 }
