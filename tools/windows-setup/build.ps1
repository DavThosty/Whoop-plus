<#
.SYNOPSIS
    Baut WhoopPlus-Setup.exe aus WhoopPlusSetup.ps1 (mit ps2exe). Läuft unter Windows PowerShell 5.1.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\windows-setup\build.ps1 -BuildNumber 12
#>
[CmdletBinding()]
param(
    [string]$OutputDir = (Join-Path $PSScriptRoot 'dist'),
    [int]$BuildNumber = 0
)
$ErrorActionPreference = 'Stop'

# Feste Version (zuletzt erfolgreich im CI gebaut), damit ein neues ps2exe den Build nicht unbemerkt ändert.
$ps2exeVersion = '1.0.18'
if (-not (Get-Module -ListAvailable -Name ps2exe | Where-Object { $_.Version -eq [version]$ps2exeVersion })) {
    Write-Output "ps2exe $ps2exeVersion wird installiert …"
    Install-Module ps2exe -RequiredVersion $ps2exeVersion -Scope CurrentUser -Force -AllowClobber
}
Import-Module ps2exe -RequiredVersion $ps2exeVersion

$source = Join-Path $PSScriptRoot 'WhoopPlusSetup.ps1'
$icon = Join-Path $PSScriptRoot 'icon.ico'
$text = [System.IO.File]::ReadAllText($source)
$match = [regex]::Match($text, "\`$script:HelperVersion = '(\d+\.\d+\.\d+)'")
if (-not $match.Success) { throw 'HelperVersion nicht gefunden' }
$version = '{0}.{1}' -f $match.Groups[1].Value, $BuildNumber

if (-not (Test-Path $OutputDir)) { $null = New-Item -ItemType Directory -Path $OutputDir -Force }
$exe = Join-Path $OutputDir 'WhoopPlus-Setup.exe'
if (Test-Path $exe) { Remove-Item $exe -Force }

# -noConsole: Fensterprogramm ohne Konsole. -noOutput/-noError: keine Meldungsfenster für Ausgaben.
# -STA: nötig für Zwischenablage und Fenster. -DPIAware: scharf auf hochauflösenden Bildschirmen.
Invoke-ps2exe -inputFile $source -outputFile $exe -iconFile $icon `
    -noConsole -noOutput -noError -STA -DPIAware -supportOS `
    -title 'Whoop Plus Einrichtungshelfer' `
    -description 'Whoop Plus Einrichtungshelfer' `
    -product 'Whoop Plus' `
    -company 'DavThosty' `
    -copyright 'Copyright (c) 2026 DavThosty - PolyForm Noncommercial 1.0.0' `
    -version $version

if (-not (Test-Path $exe)) { throw 'ps2exe hat keine EXE erzeugt' }
$item = Get-Item $exe
Write-Output ('{0}: {1:N0} Bytes, Version {2}' -f $item.Name, $item.Length, $item.VersionInfo.FileVersion)
