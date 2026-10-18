# Creates the Android signing key for Scheduling Pilot. Run it ONCE, yourself:
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\make-android-key.ps1
#
# keytool asks for a password (twice) and a name for the certificate. The key
# is written OUTSIDE the repo, to Documents\scheduling-pilot-keys, together with
# a base64 copy to paste into the ANDROID_KEYSTORE_BASE64 GitHub secret.
#
# This key is the app's identity for its whole life: every APK and every Play
# update must be signed with it. Back up the .keystore file and the password
# somewhere other than this PC (a password manager holds both). See
# docs/mobile/android-apk.md.
$ErrorActionPreference = 'Stop'

$dir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'scheduling-pilot-keys'
$keystore = Join-Path $dir 'scheduling-pilot-release.keystore'
$base64File = Join-Path $dir 'ANDROID_KEYSTORE_BASE64.txt'
$alias = 'schedulingpilot'

if (Test-Path $keystore) {
    Write-Host "A key already exists at $keystore - not replacing it. A new key would be a different app identity." -ForegroundColor Yellow
    exit 1
}

# keytool ships with any Java: Android Studio's bundled one, or Temurin.
$candidates = @()
if ($env:JAVA_HOME) { $candidates += (Join-Path $env:JAVA_HOME 'bin\keytool.exe') }
$candidates += 'C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe'
$candidates += (Get-ChildItem 'C:\Program Files\Eclipse Adoptium\*\bin\keytool.exe' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$fromPath = Get-Command keytool -ErrorAction SilentlyContinue
if ($fromPath) { $candidates += $fromPath.Source }
$keytool = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $keytool) {
    Write-Host 'keytool (part of Java) was not found. Install Java with:' -ForegroundColor Yellow
    Write-Host '  winget install EclipseAdoptium.Temurin.21.JDK'
    Write-Host 'then open a new terminal and run this script again.'
    exit 1
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "Using $keytool"
Write-Host 'Choose a strong password and save it in your password manager now.' -ForegroundColor Cyan

& $keytool -genkeypair -v `
    -keystore $keystore -storetype PKCS12 `
    -alias $alias -keyalg RSA -keysize 4096 -validity 10000 `
    -dname 'CN=Scheduling Pilot, O=Valladolid NovaTech'
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $keystore)) { throw 'keytool did not create the key.' }

[Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore)) | Set-Content -Encoding ascii -NoNewline $base64File

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Key file:          $keystore"
Write-Host "  For GitHub secret: $base64File"
Write-Host "  Key alias:         $alias"
Write-Host ''
Write-Host 'Certificate fingerprint (public; used later for app links):'
& $keytool -list -keystore $keystore -alias $alias -storetype PKCS12 | Select-String 'SHA-256|SHA256'
