<#
.SYNOPSIS
    Whoop Plus Einrichtungshelfer – führt unter Windows Schritt für Schritt durch die Einrichtung von SideStore,
    damit die App „Whoop Plus“ kostenlos auf das iPhone kommt.

.DESCRIPTION
    Läuft mit Windows PowerShell 5.1 (in Windows enthalten) und wird mit ps2exe zu WhoopPlus-Setup.exe gebaut.
    Der Helfer fragt NIE nach Apple-ID oder Passwort – die Anmeldung passiert nur im Programm iloader.
    Bericht: %LOCALAPPDATA%\WhoopPlusSetup\log.txt, gemerkte Schritte: %LOCALAPPDATA%\WhoopPlusSetup\state.json

.PARAMETER SelfTest
    Prüft alles ohne Fenster (für die automatischen Tests) und beendet sich mit 0 (OK) oder 1 (Fehler).

.PARAMETER SelfTestReport
    Optional: Pfad, in den der Selbsttest sein Ergebnis als JSON schreibt.

.PARAMETER LibraryOnly
    Lädt nur die Funktionen (für Pester-Tests: . .\WhoopPlusSetup.ps1 -LibraryOnly).
#>
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [string]$SelfTestReport,
    [switch]$LibraryOnly
)

# region Einstellungen
$script:HelperVersion = '1.0.0'
$script:Config = @{
    ILoaderApiUrl        = 'https://api.github.com/repos/nab138/iloader/releases/latest'
    ILoaderLatestJsonUrl = 'https://github.com/nab138/iloader/releases/latest/download/latest.json'
    LocalDevVpnUrl       = 'https://apps.apple.com/app/localdevvpn/id6755608044'
    SourceUrl            = 'https://raw.githubusercontent.com/DavThosty/Whoop-plus/sidestore/source.json'
    IpaFallbackUrl       = 'https://github.com/DavThosty/Whoop-plus/releases/tag/ios-latest'
    RefreshHelpUrl       = 'https://github.com/DavThosty/Whoop-plus/blob/main/docs/ANLEITUNG.md#4-nie-mehr-dran-denken-automatisch-verl%C3%A4ngern'
    GuideUrl             = 'https://github.com/DavThosty/Whoop-plus/blob/main/docs/ANLEITUNG.md'
    ITunesDownloadUrl    = 'https://www.apple.com/itunes/download/win64'
    AppleDevicesStoreUrl = 'https://apps.microsoft.com/detail/9np83lwlpz9k'
    ITunesWingetId       = 'Apple.iTunes'
    AppleDevicesStoreId  = '9NP83LWLPZ9K'
    UsbmuxPort           = 27015
    UserAgent            = 'WhoopPlusSetup'
}
# endregion

# region Reine Hilfsfunktionen (ohne Windows-Abhängigkeit, mit Pester getestet)

function Get-PropValue {
    # Liest eine Eigenschaft robust aus Hashtable/PSCustomObject (fehlt sie, kommt $null).
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -ne $prop) { return $prop.Value }
    return $null
}

function ConvertTo-VersionObject {
    # "v2.4.0", "2.4", "2.4.0-beta.1" -> [version] 2.4.0.0 ; unbrauchbar -> $null
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $m = [regex]::Match($Text, '(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?')
    if (-not $m.Success) { return $null }
    $parts = @()
    for ($i = 1; $i -le 4; $i++) {
        if ($m.Groups[$i].Success) { $parts += [int]$m.Groups[$i].Value } else { $parts += 0 }
    }
    return New-Object System.Version -ArgumentList $parts[0], $parts[1], $parts[2], $parts[3]
}

function Test-UpdateAvailable {
    # $true, wenn $LatestVersion neuer ist als $InstalledVersion (oder nichts installiert ist).
    param([string]$InstalledVersion, [string]$LatestVersion)
    $latest = ConvertTo-VersionObject $LatestVersion
    if ($null -eq $latest) { return $false }
    $installed = ConvertTo-VersionObject $InstalledVersion
    if ($null -eq $installed) { return $true }
    return ($latest -gt $installed)
}

function Select-ILoaderAsset {
    # Wählt aus den Release-Dateien die Windows-x64-Installationsdatei: zuerst MSI, sonst EXE.
    param([object[]]$Assets)
    $list = @($Assets | Where-Object { $null -ne $_ -and (Get-PropValue $_ 'name') })
    $patterns = @(
        '^iloader-windows-x64\.msi$',
        '^iloader.*(x64|amd64|x86_64).*\.msi$',
        '^iloader-windows-x64\.exe$',
        '^iloader.*(windows|setup).*(x64|amd64|x86_64).*\.exe$'
    )
    foreach ($pattern in $patterns) {
        $hit = $list | Where-Object { [string](Get-PropValue $_ 'name') -match $pattern } | Select-Object -First 1
        if ($null -ne $hit) { return $hit }
    }
    return $null
}

function New-ILoaderReleaseInfo {
    param([string]$Version, [string]$Tag, [string]$FileName, [string]$Url, [long]$Size, [string]$Sha256, [string]$Source)
    $kind = 'exe'
    if ($FileName -match '\.msi$') { $kind = 'msi' }
    return [pscustomobject]@{
        Version  = $Version
        Tag      = $Tag
        FileName = $FileName
        Url      = $Url
        Size     = $Size
        Sha256   = $Sha256
        Kind     = $kind
        Source   = $Source
    }
}

function ConvertFrom-ILoaderApiRelease {
    # Antwort von api.github.com/repos/nab138/iloader/releases/latest -> Release-Info (oder $null).
    param($Release)
    $tag = [string](Get-PropValue $Release 'tag_name')
    $asset = Select-ILoaderAsset -Assets @(Get-PropValue $Release 'assets')
    $version = ConvertTo-VersionObject $tag
    if ($null -eq $asset -or $null -eq $version) { return $null }
    $sha = $null
    $digest = [string](Get-PropValue $asset 'digest')
    if ($digest -match '^sha256:([0-9a-fA-F]{64})$') { $sha = $Matches[1].ToUpperInvariant() }
    $size = 0L
    $rawSize = Get-PropValue $asset 'size'
    if ($null -ne $rawSize) { $size = [long]$rawSize }
    return New-ILoaderReleaseInfo -Version $version.ToString(3) -Tag $tag -FileName ([string](Get-PropValue $asset 'name')) `
        -Url ([string](Get-PropValue $asset 'browser_download_url')) -Size $size -Sha256 $sha -Source 'api'
}

function ConvertFrom-ILoaderLatestJson {
    # Ersatzweg, falls die GitHub-API nicht antwortet: latest.json des iloader-Updaters.
    param($Json)
    $version = ConvertTo-VersionObject ([string](Get-PropValue $Json 'version'))
    $platforms = Get-PropValue $Json 'platforms'
    if ($null -eq $version -or $null -eq $platforms) { return $null }
    $entry = $null
    foreach ($key in @('windows-x86_64-msi', 'windows-x86_64', 'windows-x86_64-nsis')) {
        $candidate = Get-PropValue $platforms $key
        $url = [string](Get-PropValue $candidate 'url')
        if ($url -match '\.(msi|exe)$') { $entry = $candidate; break }
    }
    if ($null -eq $entry) { return $null }
    $url = [string](Get-PropValue $entry 'url')
    $fileName = ($url -split '/')[-1]
    return New-ILoaderReleaseInfo -Version $version.ToString(3) -Tag ('v' + $version.ToString(3)) -FileName $fileName `
        -Url $url -Size 0 -Sha256 $null -Source 'latest.json'
}

function Test-DownloadComplete {
    # Prüft Größe und (falls bekannt) SHA-256 einer heruntergeladenen Datei.
    param([long]$ActualSize, [long]$ExpectedSize, [string]$ActualSha256, [string]$ExpectedSha256)
    if ($ActualSize -le 0) { return [pscustomobject]@{ Ok = $false; Reason = 'leer' } }
    if ($ExpectedSize -gt 0 -and $ActualSize -ne $ExpectedSize) {
        return [pscustomobject]@{ Ok = $false; Reason = "Größe $ActualSize statt $ExpectedSize" }
    }
    if ($ExpectedSha256 -and $ActualSha256 -and ($ActualSha256.ToUpperInvariant() -ne $ExpectedSha256.ToUpperInvariant())) {
        return [pscustomobject]@{ Ok = $false; Reason = 'Prüfsumme passt nicht' }
    }
    return [pscustomobject]@{ Ok = $true; Reason = '' }
}

function Get-WindowsSupport {
    # Bewertet das Windows nach den SideStore-Vorgaben (64 Bit nötig, kein Windows 10 auf ARM).
    param([int]$Build, [string]$NativeArchitecture, [bool]$Is64BitOS)
    $arch = ([string]$NativeArchitecture).ToUpperInvariant()
    $isWin11 = $Build -ge 22000
    $name = 'Windows'
    if ($Build -ge 22000) { $name = 'Windows 11' }
    elseif ($Build -ge 10240) { $name = 'Windows 10' }
    elseif ($Build -ge 9200) { $name = 'Windows 8' }

    $status = 'Ok'; $message = "$name (64 Bit) – passt."; $action = ''
    if (-not $Is64BitOS -or $arch -eq 'X86') {
        $status = 'Fail'
        $message = 'Dein Windows ist eine 32-Bit-Version. Damit klappt es leider nicht.'
        $action = 'Bitte nimm einen anderen PC mit 64-Bit-Windows.'
    }
    elseif ($arch -eq 'ARM64' -and -not $isWin11) {
        $status = 'Fail'
        $message = 'Windows 10 auf einem ARM-Prozessor wird leider nicht unterstützt.'
        $action = 'Bitte nimm einen anderen PC.'
    }
    elseif ($arch -eq 'ARM64') {
        $status = 'Warn'
        $message = 'Dein PC hat einen ARM-Prozessor. Das ist nicht offiziell unterstützt.'
        $action = 'Du kannst es trotzdem versuchen. Klappt es nicht, nimm einen anderen PC.'
    }
    elseif ($Build -lt 9200) {
        $status = 'Fail'
        $message = 'Dieses Windows ist zu alt.'
        $action = 'Bitte nimm einen PC mit Windows 10 oder 11.'
    }
    elseif ($Build -lt 10240) {
        $status = 'Warn'
        $message = 'Windows 8 geht, aber manches musst du selbst installieren.'
        $action = 'Ich zeige dir dann die passenden Internetseiten.'
    }
    elseif ($arch -ne 'AMD64') {
        $status = 'Warn'
        $message = "Unbekannter Prozessor ($arch)."
        $action = 'Du kannst es trotzdem versuchen.'
    }
    return [pscustomobject]@{
        Status      = $status
        Name        = $name
        IsWindows11 = $isWin11
        Message     = $message
        Action      = $action
    }
}

function Get-AppleInstallMethods {
    # Reihenfolge der Installationswege für das Apple-Programm (Apple Mobile Device Support).
    # Wie von SideStore empfohlen: iTunes von Apple zuerst, die App „Apple-Geräte“ nur als Ersatz.
    # $IsWindows11 bleibt als Parameter, falls sich die Empfehlung je nach Windows-Version ändert.
    param([bool]$IsWindows11, [bool]$WingetAvailable)
    $null = $IsWindows11
    if (-not $WingetAvailable) { return @('Manual') }
    return @('ITunesWinget', 'AppleDevicesStore', 'Manual')
}

function Get-WingetArguments {
    param([ValidateSet('AppleDevicesStore', 'ITunesWinget')][string]$Method)
    if ($Method -eq 'AppleDevicesStore') {
        $id = $script:Config.AppleDevicesStoreId; $source = 'msstore'
    }
    else {
        $id = $script:Config.ITunesWingetId; $source = 'winget'
    }
    return @('install', '--id', $id, '--exact', '--source', $source,
        '--accept-package-agreements', '--accept-source-agreements', '--silent')
}

function Get-WingetResultKind {
    param([int]$ExitCode)
    switch ($ExitCode) {
        0 { return 'Success' }
        -1978335189 { return 'AlreadyInstalled' }   # 0x8A15002B: kein Update nötig
        -1978335135 { return 'AlreadyInstalled' }   # 0x8A150061: schon installiert
        -1978335212 { return 'NotFound' }           # 0x8A150014: Paket nicht gefunden
        -1978335215 { return 'Cancelled' }          # 0x8A150011: abgebrochen
        default { return 'Failed' }
    }
}

function Get-MsiResultKind {
    param([int]$ExitCode)
    switch ($ExitCode) {
        0 { return 'Success' }
        3010 { return 'Success' }   # Neustart empfohlen
        1641 { return 'Success' }
        1602 { return 'Cancelled' }
        1223 { return 'Cancelled' }
        1618 { return 'Busy' }      # andere Installation läuft
        default { return 'Failed' }
    }
}

function Find-ILoaderInstall {
    # Findet iloader anhand der Deinstallations-Einträge und bekannter Pfade.
    param(
        [object[]]$UninstallEntries,
        [string[]]$CandidatePaths,
        [scriptblock]$PathExists = { param($p) Test-Path -LiteralPath $p -PathType Leaf }
    )
    $entry = @($UninstallEntries | Where-Object { [string](Get-PropValue $_ 'DisplayName') -match '^iloader\b' } |
            Sort-Object -Property @{ Expression = { ConvertTo-VersionObject ([string](Get-PropValue $_ 'DisplayVersion')) } } -Descending) |
        Select-Object -First 1
    $paths = @()
    if ($null -ne $entry) {
        $location = [string](Get-PropValue $entry 'InstallLocation')
        if ($location) { $paths += ($location.Trim('"').TrimEnd('\') + '\iloader.exe') }
        $icon = [string](Get-PropValue $entry 'DisplayIcon')
        if ($icon) {
            $iconPath = ($icon -replace '"', '') -replace ',\s*-?\d+$', ''
            if ($iconPath -match '\.exe$') { $paths += $iconPath }
        }
    }
    $paths += @($CandidatePaths | Where-Object { $_ })
    $exe = $paths | Where-Object { & $PathExists $_ } | Select-Object -First 1
    if ($null -eq $entry -and -not $exe) { return $null }
    $version = $null
    if ($null -ne $entry) { $version = [string](Get-PropValue $entry 'DisplayVersion') }
    return [pscustomobject]@{
        Version   = $version
        ExePath   = $exe
        Installed = [bool]$exe
    }
}

function ConvertTo-SetupState {
    # Gemerkte, einmalige iPhone-Schritte. Unbekanntes/kaputtes -> Standardwerte.
    param($InputObject)
    $state = [ordered]@{
        Version       = 1
        VpnDone       = $false
        TrustDone     = $false
        DevModeDone   = $false
        SideStoreDone = $false
        SourceDone    = $false
        CompletedAt   = $null
        LastMode      = $null
    }
    foreach ($key in @('VpnDone', 'TrustDone', 'DevModeDone', 'SideStoreDone', 'SourceDone')) {
        $value = Get-PropValue $InputObject $key
        if ($value -is [bool]) { $state[$key] = $value }
    }
    foreach ($key in @('CompletedAt', 'LastMode')) {
        $value = Get-PropValue $InputObject $key
        if ($value) { $state[$key] = [string]$value }
    }
    return $state
}

function Get-SetupPlan {
    # Welche Bildschirme gezeigt werden. PC-Schritte prüfen sich später selbst und werden ggf. übersprungen.
    param(
        [ValidateSet('First', 'Full', 'NewPhone', 'Check', 'Expired', 'Pairing')][string]$Mode,
        $State
    )
    $s = ConvertTo-SetupState $State
    $plan = New-Object System.Collections.Generic.List[string]
    switch ($Mode) {
        { $_ -in @('First', 'Full', 'NewPhone') } {
            $remember = ($Mode -eq 'First')
            $plan.AddRange([string[]]@('Windows', 'AppleSoftware'))
            if (-not ($remember -and $s.VpnDone)) { $plan.AddRange([string[]]@('VpnInstall', 'VpnConnect')) }
            $plan.AddRange([string[]]@('Connect', 'ILoader', 'ILoaderLogin', 'ILoaderInstall'))
            if (-not ($remember -and $s.TrustDone)) { $plan.Add('PhoneTrust') }
            if (-not ($remember -and $s.DevModeDone)) { $plan.Add('DevMode') }
            $plan.AddRange([string[]]@('SideStoreOpen', 'SideStoreRefresh', 'AddSource', 'Done'))
        }
        'Check' {
            $plan.AddRange([string[]]@('Windows', 'AppleSoftware', 'ILoader', 'CheckDone'))
        }
        'Expired' {
            $plan.AddRange([string[]]@('Windows', 'AppleSoftware'))
            if (-not $s.VpnDone) { $plan.AddRange([string[]]@('VpnInstall', 'VpnConnect')) }
            $plan.AddRange([string[]]@('Connect', 'ILoader', 'ILoaderLogin', 'ILoaderInstall', 'SideStoreOpen', 'SideStoreRefresh', 'Done'))
        }
        'Pairing' {
            $plan.AddRange([string[]]@('Windows', 'AppleSoftware', 'Connect', 'ILoader', 'PairingDelete', 'PairingSelect', 'PairingPlace', 'PairingDone'))
        }
    }
    return , $plan.ToArray()
}

function Add-PlanStepsBefore {
    # Fügt Schritte vor Position $Index ein, sofern sie ab dort nicht ohnehin noch kommen.
    param([string[]]$Plan, [int]$Index, [string[]]$Steps)
    $rest = @()
    if ($Index -lt $Plan.Count) { $rest = $Plan[$Index..($Plan.Count - 1)] }
    $toAdd = @($Steps | Where-Object { $rest -notcontains $_ })
    $head = @()
    if ($Index -gt 0) { $head = $Plan[0..($Index - 1)] }
    return , [string[]](@($head) + $toAdd + @($rest))
}

function ConvertFrom-SimpleMarkup {
    # "Tippe **Vertrauen**" -> Teile mit Fett-Kennzeichen
    param([string]$Text)
    $result = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Text) { return , $result.ToArray() }
    $parts = $Text -split '\*\*'
    for ($i = 0; $i -lt $parts.Count; $i++) {
        if ($parts[$i].Length -gt 0) {
            $result.Add([pscustomobject]@{ Text = $parts[$i]; Bold = ($i % 2 -eq 1) })
        }
    }
    return , $result.ToArray()
}

function Format-ByteSize {
    param([long]$Bytes)
    $de = [System.Globalization.CultureInfo]::GetCultureInfo('de-DE')
    if ($Bytes -ge 1MB) { return ([double]$Bytes / 1MB).ToString('0.0', $de) + ' MB' }
    if ($Bytes -ge 1KB) { return ([double]$Bytes / 1KB).ToString('0', $de) + ' KB' }
    return "$Bytes Bytes"
}

function Get-SideStoreSourceDeepLink {
    # sidestore://source?url=... öffnet SideStore direkt mit „Quelle hinzufügen“ (SideStore 0.6.4+).
    param([string]$SourceUrl)
    return 'sidestore://source?url=' + [System.Uri]::EscapeDataString($SourceUrl)
}

function Test-IsAppleMobileDeviceId {
    # USB-Kennung eines iPhones/iPads (Hersteller 05AC = Apple, Produkt 12xx = iOS-Gerät).
    param([string]$DeviceId)
    return ([string]$DeviceId -match '^USB\\VID_05AC&PID_12[0-9A-F]{2}(&|\\|$)')
}

function New-UsbmuxListDevicesPlist {
    return @'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>MessageType</key><string>ListDevices</string><key>ClientVersionString</key><string>WhoopPlusSetup</string><key>ProgName</key><string>WhoopPlusSetup</string><key>kLibUSBMuxVersion</key><integer>3</integer></dict></plist>
'@
}

function New-UsbmuxPlistPacket {
    # usbmuxd-Paket: 16 Byte Kopf (Länge, Version 1, Typ 8 = Plist, Tag), danach XML (Little Endian).
    param([string]$PlistXml, [int]$Tag = 1)
    $payload = [System.Text.Encoding]::UTF8.GetBytes($PlistXml)
    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter -ArgumentList $stream
    $writer.Write([uint32](16 + $payload.Length))
    $writer.Write([uint32]1)
    $writer.Write([uint32]8)
    $writer.Write([uint32]$Tag)
    $writer.Write($payload)
    $writer.Flush()
    $bytes = $stream.ToArray()
    $writer.Dispose()
    return , $bytes
}

function ConvertFrom-UsbmuxHeader {
    param([byte[]]$Bytes)
    if ($null -eq $Bytes -or $Bytes.Length -lt 16) { return $null }
    return [pscustomobject]@{
        Length  = [System.BitConverter]::ToUInt32($Bytes, 0)
        Version = [System.BitConverter]::ToUInt32($Bytes, 4)
        Message = [System.BitConverter]::ToUInt32($Bytes, 8)
        Tag     = [System.BitConverter]::ToUInt32($Bytes, 12)
    }
}

function ConvertFrom-PlistNode {
    param($Node)
    switch ($Node.LocalName) {
        'dict' {
            $table = @{}
            $key = $null
            foreach ($child in $Node.ChildNodes) {
                if ($child.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
                if ($child.LocalName -eq 'key') { $key = $child.InnerText }
                elseif ($null -ne $key) { $table[$key] = ConvertFrom-PlistNode $child; $key = $null }
            }
            return $table
        }
        'array' {
            $items = New-Object System.Collections.Generic.List[object]
            foreach ($child in $Node.ChildNodes) {
                if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) { $items.Add((ConvertFrom-PlistNode $child)) }
            }
            return , $items.ToArray()
        }
        'string' { return $Node.InnerText }
        'integer' { return [long]$Node.InnerText }
        'real' { return [double]::Parse($Node.InnerText, [System.Globalization.CultureInfo]::InvariantCulture) }
        'true' { return $true }
        'false' { return $false }
        'data' { return , [System.Convert]::FromBase64String($Node.InnerText) }
        default { return $Node.InnerText }
    }
}

function ConvertFrom-PlistXml {
    # Minimaler XML-Plist-Leser (dict, array, string, integer, real, true/false, data).
    param([string]$Xml)
    $settings = New-Object System.Xml.XmlReaderSettings
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Ignore
    $settings.XmlResolver = $null
    $reader = [System.Xml.XmlReader]::Create((New-Object System.IO.StringReader -ArgumentList $Xml), $settings)
    try {
        $doc = New-Object System.Xml.XmlDocument
        $doc.XmlResolver = $null
        $doc.Load($reader)
    }
    finally { $reader.Dispose() }
    foreach ($child in $doc.DocumentElement.ChildNodes) {
        if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) { return ConvertFrom-PlistNode $child }
    }
    return $null
}

function Get-UsbmuxDeviceList {
    # Antwort auf ListDevices -> Geräte (Kennung + Verbindungsart USB/Network).
    param($Plist)
    $devices = New-Object System.Collections.Generic.List[object]
    foreach ($item in @(Get-PropValue $Plist 'DeviceList')) {
        $props = Get-PropValue $item 'Properties'
        if ($null -eq $props) { continue }
        $devices.Add([pscustomobject]@{
                DeviceId       = Get-PropValue $props 'DeviceID'
                Udid           = [string](Get-PropValue $props 'SerialNumber')
                ConnectionType = [string](Get-PropValue $props 'ConnectionType')
            })
    }
    return $devices.ToArray()   # bewusst ausgerollt: Aufrufer nutzen @(...)
}

function Get-ScreenDefinition {
    # Texte und Knöpfe jedes Bildschirms. Alltagssprache, kurze Sätze, **fett** = genaue Knopf-Beschriftung.
    param([string]$Id, [string]$Mode = 'First')
    $d = @{
        Id = $Id; Kind = 'manual'; Title = ''; Icon = 'step-question'; Body = ''; Note = ''
        Qr = $null; QrCaption = ''; Primary = 'Erledigt'; PrimaryAction = 'Next'
        Secondary = @(); Links = @(); Tiles = @(); OnEnter = $null; ShowProgress = $true
    }
    switch ($Id) {
        'Welcome' {
            $d.Title = 'Whoop Plus aufs iPhone bringen'; $d.Icon = 'step-add'; $d.ShowProgress = $false
            $d.Body = "Ich führe dich Schritt für Schritt durch die Einrichtung.`nDu brauchst dein **iPhone**, das **Kabel** und deine **Apple-ID**.`nDas dauert etwa 20 Minuten."
            $d.Primary = "Los geht's"; $d.PrimaryAction = 'Mode:First'
            $d.Links = @(@{ Text = 'Erweitert: alles von vorne einrichten'; Action = 'Mode:Full' })
        }
        'Changed' {
            $d.Title = 'Hat sich etwas geändert?'; $d.Icon = 'step-question'; $d.ShowProgress = $false
            $d.Body = 'Wähle, was passt. Läuft alles, nimm einfach das Erste.'
            $d.Primary = $null
            $d.Tiles = @(
                @{ Text = 'Alles gut – nur prüfen'; Action = 'Mode:Check'; Main = $true },
                @{ Text = 'SideStore öffnet nicht oder ist abgelaufen'; Action = 'Mode:Expired' },
                @{ Text = 'Fehlermeldung zur Verbindung, z. B. nach einem iOS-Update'; Action = 'Mode:Pairing' },
                @{ Text = 'Ich habe ein neues iPhone'; Action = 'Mode:NewPhone' }
            )
            $d.Links = @(@{ Text = 'Erweitert: alles von vorne einrichten'; Action = 'Mode:Full' })
        }
        'Windows' {
            $d.Kind = 'auto'; $d.Title = 'Dein PC wird geprüft'; $d.Icon = 'step-pc'
            $d.Body = 'Einen Moment – ich schaue, ob dein Windows passt.'
            $d.Primary = 'Weiter'
        }
        'AppleSoftware' {
            $d.Kind = 'auto'; $d.Title = 'Apple-Programm für das iPhone'; $d.Icon = 'step-apple'
            $d.Body = 'Damit dein PC das iPhone erkennt, braucht er ein kostenloses Programm von Apple.'
            $d.Note = 'Fragt Windows „Möchten Sie zulassen, dass …“? Dann auf **Ja** klicken.'
            $d.Primary = 'Weiter'
        }
        'VpnInstall' {
            $d.Title = 'App „LocalDevVPN“ laden'; $d.Icon = 'step-vpn'
            $d.Body = "Scanne den Code mit der **Kamera** deines iPhones.`nLade dann die kostenlose App **LocalDevVPN**."
            $d.Qr = 'qr-localdevvpn'; $d.QrCaption = 'Oder im App Store nach „LocalDevVPN“ suchen.'
        }
        'VpnConnect' {
            $d.Title = 'LocalDevVPN einschalten'; $d.Icon = 'step-vpn'
            $d.Body = "1. Öffne **LocalDevVPN** und tippe auf **Connect**.`n2. Fragt das iPhone nach VPN: Tippe **Erlauben** und gib deinen Code ein."
            $d.Note = 'Wichtig: Dein iPhone braucht einen Code zum Entsperren, und das WLAN muss an sein.'
            $d.PrimaryAction = 'Confirm:VpnDone'
        }
        'Connect' {
            $d.Kind = 'auto'; $d.Title = 'iPhone anschließen'; $d.Icon = 'step-cable'
            $d.Body = "1. Verbinde dein iPhone mit dem **Kabel** mit dem PC.`n2. Entsperre das iPhone.`n3. Fragt es `„Diesem Computer vertrauen?`“: Tippe **Vertrauen** und gib deinen Code ein."
            $d.Primary = 'Weiter'
        }
        'ILoader' {
            $d.Kind = 'auto'; $d.Title = 'Programm „iloader“ vorbereiten'; $d.Icon = 'step-download'
            $d.Body = '**iloader** bringt SideStore auf dein iPhone. Ich lade es und installiere es – du musst nur zuschauen.'
            $d.Note = 'Fragt Windows „Möchten Sie zulassen, dass …“? Dann auf **Ja** klicken.'
            $d.Primary = 'Weiter'
        }
        'ILoaderLogin' {
            $d.Title = 'In iloader anmelden'; $d.Icon = 'step-login'; $d.OnEnter = 'StartILoader'
            $d.Body = "iloader ist jetzt offen.`n1. Gib deine **Apple-ID** (E-Mail) und dein **Passwort** ein.`n2. Klicke auf **Anmelden** (`„Sign in`“).`n3. Kommt ein Code aufs iPhone? Gib ihn in iloader ein."
            $d.Note = 'Deine Apple-ID gibst du nur in iloader ein. Dieser Helfer fragt nie danach und speichert nichts.'
            $d.Secondary = @(@{ Text = 'iloader öffnen'; Action = 'StartILoader' })
        }
        'ILoaderInstall' {
            $d.Title = 'SideStore installieren'; $d.Icon = 'step-install'
            $d.Body = "1. Klicke in iloader unter **Geräte** (`„Devices`“) auf dein iPhone.`n2. Klicke unter **Installer** auf **SideStore (Stable)**.`n3. Warte, bis `„**SideStore installiert!**`“ erscheint."
            if ($Mode -eq 'Expired') {
                $d.Note = 'Keine Sorge: Whoop Plus und deine Daten bleiben erhalten. Lösche Whoop Plus nicht.'
            }
            else {
                $d.Note = 'Fragt das iPhone „Vertrauen?“: Tippe **Vertrauen** und gib deinen Code ein.'
            }
            $d.PrimaryAction = 'Confirm:SideStoreDone'
        }
        'PhoneTrust' {
            $d.Title = 'Am iPhone: Entwickler vertrauen'; $d.Icon = 'step-trust'
            $d.Body = "1. Öffne **Einstellungen** → **Allgemein** → **VPN & Geräteverwaltung**.`n2. Tippe unter `„Entwickler-App`“ auf deine Apple-ID.`n3. Tippe auf **Vertrauen** und bestätige. Steht dort **Erlauben & Neustarten**, tippe darauf."
            $d.PrimaryAction = 'Confirm:TrustDone'
        }
        'DevMode' {
            $d.Title = 'Am iPhone: Entwicklermodus'; $d.Icon = 'step-devmode'
            $d.Body = "1. Öffne **Einstellungen** → **Datenschutz & Sicherheit**.`n2. Ganz unten **Entwicklermodus** einschalten und **Neustart** tippen.`n3. Nach dem Neustart die Frage bestätigen und den Code eingeben."
            $d.Note = 'Gibt es den Punkt nicht? Dann einfach auf **Erledigt** klicken.'
            $d.PrimaryAction = 'Confirm:DevModeDone'
        }
        'SideStoreOpen' {
            $d.Title = 'SideStore öffnen'; $d.Icon = 'step-refresh'
            $d.Body = "1. Öffne **LocalDevVPN** und tippe auf **Connect**.`n2. Öffne **SideStore** und melde dich mit **derselben Apple-ID** an wie in iloader."
            $d.Secondary = @(@{ Text = 'SideStore öffnet nicht'; Action = 'SideStoreNotOpening' })
        }
        'SideStoreRefresh' {
            $d.Title = 'SideStore einmal verlängern'; $d.Icon = 'step-refresh'
            $d.Body = "1. Tippe in SideStore unten auf **My Apps**.`n2. Tippe neben SideStore auf **7 DAYS**.`n3. Fragt SideStore etwas? Tippe **Yes** bzw. **Refresh Now**."
            $d.Note = 'SideStore verschwindet kurz und ist nach ein paar Sekunden wieder da. Das ist normal.'
        }
        'AddSource' {
            $d.Title = 'Whoop Plus hinzufügen'; $d.Icon = 'step-add'; $d.OnEnter = 'CopySourceSilent'
            $d.Body = "1. Scanne den Code mit der **Kamera** und tippe auf **In `„SideStore`“ öffnen**.`n2. Tippe auf **ADD** und dann auf **Add Source**.`n3. Tippe bei Whoop Plus auf **FREE** (bzw. **Install**)."
            $d.Qr = 'qr-source'
            $d.QrCaption = 'Ohne Kamera: In SideStore **Sources** → **+** und diese Adresse eingeben:'
            $d.Note = $script:Config.SourceUrl
            $d.Secondary = @(@{ Text = 'Adresse kopieren'; Action = 'CopySource' })
            $d.Links = @(@{ Text = 'Notlösung: App-Datei direkt laden (am iPhone in Safari öffnen)'; Action = 'OpenUrl:' + $script:Config.IpaFallbackUrl })
            $d.PrimaryAction = 'Confirm:SourceDone'
        }
        'Done' {
            $d.Title = 'Geschafft!'; $d.Icon = 'step-done'; $d.OnEnter = 'MarkCompleted'
            if ($Mode -eq 'Expired') {
                $d.Body = "SideStore läuft wieder.`nTippe jetzt in SideStore unter **My Apps** auf **Refresh All**. Whoop Plus startet dann wieder – mit allen Daten."
            }
            else {
                $d.Body = 'Whoop Plus ist jetzt auf deinem iPhone.'
            }
            $d.Note = 'Letzter Tipp: Richte am iPhone das **automatische Verlängern** ein (Kurzbefehl, 5 Minuten). Dann musst du nie mehr daran denken.'
            $d.Links = @(@{ Text = 'Anleitung: automatisch verlängern'; Action = 'OpenUrl:' + $script:Config.RefreshHelpUrl })
            $d.Primary = 'Schließen'; $d.PrimaryAction = 'Quit'
        }
        'CheckDone' {
            $d.Title = 'Alles in Ordnung'; $d.Icon = 'step-done'; $d.OnEnter = 'MarkCompleted'
            $d.Body = 'Dein PC ist bereit. Du musst nichts tun.'
            $d.Note = 'Tipp: Mit dem Kurzbefehl verlängert das iPhone SideStore und Whoop Plus jede Nacht von selbst.'
            $d.Links = @(@{ Text = 'Anleitung: automatisch verlängern'; Action = 'OpenUrl:' + $script:Config.RefreshHelpUrl })
            $d.Primary = 'Schließen'; $d.PrimaryAction = 'Quit'
        }
        'PairingDelete' {
            $d.Title = 'Alte Verbindung löschen'; $d.Icon = 'step-repair'; $d.OnEnter = 'StartILoader'
            $d.Body = "iloader ist jetzt offen.`n1. Klicke auf **Einstellungen** (`„Settings`“).`n2. Klicke auf **Delete Stored Pairing** und bestätige."
            $d.Secondary = @(@{ Text = 'iloader öffnen'; Action = 'StartILoader' })
        }
        'PairingSelect' {
            $d.Title = 'iPhone auswählen'; $d.Icon = 'step-cable'
            $d.Body = "1. Klicke in iloader unter **Geräte** (`„Devices`“) auf dein iPhone.`n2. Am iPhone: Tippe **Vertrauen** und gib deinen Code ein."
        }
        'PairingPlace' {
            $d.Title = 'Neue Verbindung ablegen'; $d.Icon = 'step-repair'
            $d.Body = "1. Klicke auf **Pairing-Datei verwalten** (`„Manage Pairing File`“).`n2. Klicke neben **SideStore** auf **Ablegen** (`„Place`“).`n3. Warte, bis grün `„**erfolgreich abgelegt**`“ erscheint."
        }
        'PairingDone' {
            $d.Title = 'Geschafft!'; $d.Icon = 'step-done'; $d.OnEnter = 'MarkCompleted'
            $d.Body = "Die Verbindung ist erneuert.`nÖffne am iPhone **LocalDevVPN** → **Connect** und dann **SideStore**."
            $d.Primary = 'Schließen'; $d.PrimaryAction = 'Quit'
        }
        default { throw "Unbekannter Bildschirm: $Id" }
    }
    return $d
}

# endregion

# region Bericht und gemerkte Schritte

function Get-AppDataDir {
    $base = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($base)) { $base = [Environment]::GetFolderPath('LocalApplicationData') }
    $dir = Join-Path $base 'WhoopPlusSetup'
    if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
    return $dir
}

function Get-LogPath { return (Join-Path (Get-AppDataDir) 'log.txt') }

function Write-SetupLog {
    param([string]$Message, [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO')
    try {
        $path = Get-LogPath
        if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 1MB) {
            Move-Item -LiteralPath $path -Destination ($path + '.alt.txt') -Force
        }
        $line = '{0} [{1}] {2}{3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message, [Environment]::NewLine
        [System.IO.File]::AppendAllText($path, $line, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
    }
    catch {
        # Ein Bericht, der nicht geschrieben werden kann, darf den Helfer nicht stoppen.
        $null = $_
    }
}

function Read-SetupState {
    $path = Join-Path (Get-AppDataDir) 'state.json'
    if (-not (Test-Path -LiteralPath $path)) { return (ConvertTo-SetupState $null) }
    try {
        $raw = [System.IO.File]::ReadAllText($path)
        return (ConvertTo-SetupState ($raw | ConvertFrom-Json))
    }
    catch {
        Write-SetupLog "state.json unlesbar, beginne neu: $($_.Exception.Message)" 'WARN'
        return (ConvertTo-SetupState $null)
    }
}

function Save-SetupState {
    param($State)
    try {
        $path = Join-Path (Get-AppDataDir) 'state.json'
        $json = [pscustomobject]$State | ConvertTo-Json
        [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
    }
    catch { Write-SetupLog "state.json nicht gespeichert: $($_.Exception.Message)" 'WARN' }
}

function Test-IsCompiledHost {
    # $true in der .exe (ps2exe), $false in powershell.exe/pwsh.
    $name = [System.Diagnostics.Process]::GetCurrentProcess().ProcessName
    return ($name -notmatch '^(powershell|pwsh|powershell_ise)$')
}

# endregion

# region Systemprüfungen (Windows)

function Get-UninstallEntries {
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $entries = @()
    foreach ($root in $roots) {
        try {
            $entries += @(Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
                    Where-Object { $_.PSObject.Properties['DisplayName'] } |
                    Select-Object DisplayName, DisplayVersion, InstallLocation, DisplayIcon, Publisher)
        }
        catch { $null = $_ }
    }
    return $entries
}

function Get-WindowsInfo {
    $build = 0; $display = ''; $arch = $env:PROCESSOR_ARCHITECTURE
    try {
        $cv = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
        $build = [int](Get-PropValue $cv 'CurrentBuildNumber')
        $display = [string](Get-PropValue $cv 'DisplayVersion')
    }
    catch { $build = [Environment]::OSVersion.Version.Build }
    try {
        # Echte Prozessorart (auch wenn dieses Programm auf ARM emuliert läuft).
        $envKey = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -ErrorAction Stop
        $native = [string](Get-PropValue $envKey 'PROCESSOR_ARCHITECTURE')
        if ($native) { $arch = $native }
    }
    catch { $null = $_ }
    return [pscustomobject]@{
        Build              = $build
        DisplayVersion     = $display
        NativeArchitecture = $arch
        Is64BitOS          = [Environment]::Is64BitOperatingSystem
    }
}

function Test-AppleSoftware {
    # Apple Mobile Device Support: kommt mit iTunes oder der App „Apple-Geräte“.
    $services = @(Get-Service -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -like 'Apple Mobile Device*' -or $_.Name -like 'AppleMobileDevice*' -or $_.DisplayName -like 'Apple Mobile Device*'
        })
    $packages = @()
    if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
        foreach ($name in @('AppleInc.AppleDevices', 'AppleInc.iTunes')) {
            try { $packages += @(Get-AppxPackage -Name $name -ErrorAction Stop) } catch { $null = $_ }
        }
    }
    $entries = @(Get-UninstallEntries | Where-Object { [string]$_.DisplayName -like 'Apple Mobile Device Support*' })
    $running = @($services | Where-Object { $_.Status -eq 'Running' }).Count -gt 0
    $source = @()
    if ($entries.Count) { $source += 'iTunes' }
    if ($packages.Count) { $source += @($packages | ForEach-Object { $_.Name }) }
    return [pscustomobject]@{
        Present        = ($services.Count -gt 0 -or $packages.Count -gt 0 -or $entries.Count -gt 0)
        ServiceRunning = $running
        Source         = ($source -join ', ')
    }
}

function Find-Winget {
    $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cmd) { return $cmd.Source }
    if ($env:LOCALAPPDATA) {
        $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
        if (Test-Path -LiteralPath $alias) { return $alias }
    }
    return $null
}

function Get-ILoaderCandidatePaths {
    $paths = @()
    if ($env:ProgramFiles) { $paths += (Join-Path $env:ProgramFiles 'iloader\iloader.exe') }
    if ($env:LOCALAPPDATA) {
        $paths += (Join-Path $env:LOCALAPPDATA 'iloader\iloader.exe')
        $paths += (Join-Path $env:LOCALAPPDATA 'Programs\iloader\iloader.exe')
    }
    return $paths
}

function Get-InstalledILoader {
    $found = Find-ILoaderInstall -UninstallEntries (Get-UninstallEntries) -CandidatePaths (Get-ILoaderCandidatePaths)
    if ($null -ne $found -and $found.Installed -and -not $found.Version) {
        try { $found.Version = (Get-Item -LiteralPath $found.ExePath).VersionInfo.ProductVersion } catch { $null = $_ }
    }
    return $found
}

$script:FetchJsonScript = {
    # Lädt JSON als Text (auch wenn der Server es als Datei ausliefert) und wandelt es um.
    param($Url, $UserAgent)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.UserAgent = $UserAgent
    $request.Accept = 'application/vnd.github+json, application/json'
    $request.Timeout = 20000
    $request.ReadWriteTimeout = 20000
    $response = $request.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader -ArgumentList $response.GetResponseStream(), ([System.Text.Encoding]::UTF8)
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    finally { $response.Close() }
    $text | ConvertFrom-Json
}

$script:DownloadScript = {
    param($Url, $Path, $Progress, $UserAgent)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.UserAgent = $UserAgent
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 60000
    $response = $request.GetResponse()
    $done = 0L
    try {
        $Progress.Total = [long]$response.ContentLength
        $inStream = $response.GetResponseStream()
        $outStream = [System.IO.File]::Create($Path)
        try {
            $buffer = New-Object byte[] 65536
            while (($read = $inStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $outStream.Write($buffer, 0, $read)
                $done += $read
                $Progress.Done = $done
                if ($Progress.Cancel) { throw 'Download abgebrochen' }
            }
        }
        finally { $outStream.Dispose(); $inStream.Dispose() }
    }
    finally { $response.Close() }
    return $done
}

$script:RunProcessScript = {
    # Startet ein Programm unsichtbar und liest seine Ausgabe mit (für die Fortschrittsanzeige).
    param($Exe, [string[]]$ArgList, $Progress)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = (@($ArgList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $process = [System.Diagnostics.Process]::Start($psi)
    $errTask = $process.StandardError.ReadToEndAsync()
    $lines = New-Object System.Collections.Generic.List[string]
    while ($null -ne ($line = $process.StandardOutput.ReadLine())) {
        $text = $line.Trim()
        if ($text) {
            $Progress.Line = $text
            if ($text -notmatch '[▀-▟]') { $lines.Add($text) }
        }
    }
    $process.WaitForExit()
    [pscustomobject]@{ ExitCode = $process.ExitCode; Output = (($lines | Select-Object -Last 40) -join "`n") + $errTask.Result }
}

function Get-ILoaderLatestRelease {
    # Neueste iloader-Version: GitHub-API, ersatzweise latest.json.
    try {
        $api = Invoke-InBackground -ScriptBlock $script:FetchJsonScript -ArgumentList @($script:Config.ILoaderApiUrl, $script:Config.UserAgent)
        $info = ConvertFrom-ILoaderApiRelease $api
        if ($null -ne $info) { return $info }
        Write-SetupLog 'GitHub-API: keine passende Windows-Datei gefunden' 'WARN'
    }
    catch { Write-SetupLog "GitHub-API nicht erreichbar: $($_.Exception.Message)" 'WARN' }
    try {
        $json = Invoke-InBackground -ScriptBlock $script:FetchJsonScript -ArgumentList @($script:Config.ILoaderLatestJsonUrl, $script:Config.UserAgent)
        return (ConvertFrom-ILoaderLatestJson $json)
    }
    catch {
        Write-SetupLog "latest.json nicht erreichbar: $($_.Exception.Message)" 'WARN'
        return $null
    }
}

function Read-StreamExact {
    param([System.IO.Stream]$Stream, [int]$Count)
    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) { throw 'Verbindung vorzeitig beendet' }
        $offset += $read
    }
    return , $buffer
}

function Get-UsbmuxDevices {
    # Fragt den Apple-Gerätedienst (usbmuxd, 127.0.0.1:27015) nach angeschlossenen iPhones.
    param([int]$TimeoutMs = 1500)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $client.BeginConnect('127.0.0.1', $script:Config.UsbmuxPort, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne($TimeoutMs)) { throw 'Apple-Gerätedienst antwortet nicht' }
        $client.EndConnect($connect)
        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        $stream.WriteTimeout = $TimeoutMs
        $packet = New-UsbmuxPlistPacket -PlistXml (New-UsbmuxListDevicesPlist)
        $stream.Write($packet, 0, $packet.Length)
        $header = ConvertFrom-UsbmuxHeader (Read-StreamExact $stream 16)
        if ($null -eq $header -or $header.Length -lt 16 -or $header.Length -gt 1MB) { throw 'Ungültige Antwort' }
        $body = Read-StreamExact $stream ([int]$header.Length - 16)
        $plist = ConvertFrom-PlistXml ([System.Text.Encoding]::UTF8.GetString($body))
        return (Get-UsbmuxDeviceList -Plist $plist)
    }
    finally { $client.Close() }
}

function Test-IPhoneConnected {
    try {
        $usb = @(Get-UsbmuxDevices | Where-Object { $_.ConnectionType -eq 'USB' })
        if ($usb.Count -gt 0) { return [pscustomobject]@{ Connected = $true; Via = 'usbmux'; Count = $usb.Count } }
    }
    catch { $null = $_ }
    try {
        $pnp = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB%VID_05AC%'" -ErrorAction Stop |
                Where-Object { (Test-IsAppleMobileDeviceId $_.PNPDeviceID) -and ((Get-PropValue $_ 'Present') -ne $false) })
        if ($pnp.Count -gt 0) { return [pscustomobject]@{ Connected = $true; Via = 'pnp'; Count = $pnp.Count } }
    }
    catch { $null = $_ }
    return [pscustomobject]@{ Connected = $false; Via = ''; Count = 0 }
}

function Test-IsUserCancelled {
    # UAC-Abfrage mit „Nein“ beantwortet (Win32-Fehler 1223)?
    param($Exception)
    $e = $Exception
    while ($null -ne $e) {
        if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { return $true }
        $e = $e.InnerException
    }
    return $false
}

function Stop-ILoaderIfRunning {
    $running = @(Get-Process -Name 'iloader' -ErrorAction SilentlyContinue)
    foreach ($p in $running) {
        try {
            $null = $p.CloseMainWindow()
            if (-not $p.WaitForExit(5000)) { $p.Kill() }
        }
        catch { Write-SetupLog "iloader ließ sich nicht schließen: $($_.Exception.Message)" 'WARN' }
    }
}

# endregion

# region Warten ohne einzufrieren

$script:UiActive = $false
$script:Closing = $false

function Wait-UiCondition {
    # Wartet, hält aber das Fenster bedienbar. Namen mit __, damit übergebene Skriptblöcke Variablen des Aufrufers sehen.
    param([scriptblock]$Until, [scriptblock]$OnTick, [int]$TimeoutMs = 0, [int]$IntervalMs = 100)
    $__watch = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (& $Until)) {
        if ($script:Closing) { return $false }
        if ($TimeoutMs -gt 0 -and $__watch.ElapsedMilliseconds -gt $TimeoutMs) { return $false }
        if ($null -ne $OnTick) { & $OnTick }
        if ($script:UiActive) { [System.Windows.Forms.Application]::DoEvents() }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return $true
}

function Invoke-InBackground {
    # Führt einen Skriptblock in einem eigenen Runspace aus (Fenster bleibt bedienbar). Ohne Fenster: direkt.
    param([scriptblock]$ScriptBlock, [object[]]$ArgumentList = @(), [scriptblock]$OnTick, [int]$TimeoutSeconds = 0)
    if (-not $script:UiActive) { return (& $ScriptBlock @ArgumentList) }
    $__ps = [powershell]::Create()
    try {
        $null = $__ps.AddScript($ScriptBlock.ToString())
        foreach ($arg in $ArgumentList) { $null = $__ps.AddArgument($arg) }
        $__async = $__ps.BeginInvoke()
        $finished = Wait-UiCondition -Until { $__async.IsCompleted } -OnTick $OnTick -TimeoutMs ($TimeoutSeconds * 1000)
        if (-not $finished) {
            $null = $__ps.BeginStop($null, $null)
            throw 'Abgebrochen oder Zeit überschritten'
        }
        $output = $__ps.EndInvoke($__async)
        if ($output.Count -eq 0 -and $__ps.Streams.Error.Count -gt 0) { throw $__ps.Streams.Error[0].Exception }
        return $output
    }
    finally { $__ps.Dispose() }
}

# endregion

# region Oberfläche

$script:Colors = @{}
$script:Ui = @{}
$script:Images = @{}
$script:State = $null
$script:Mode = 'First'
$script:Plan = @()
$script:Index = -1
$script:ScreenToken = 0
$script:CurrentId = $null
$script:ScreenTimers = New-Object System.Collections.ArrayList
$script:Facts = @{}
$script:Scale = 1.0

function Initialize-UiAssemblies {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $script:Colors = @{
        Back      = [System.Drawing.ColorTranslator]::FromHtml('#0f1317')
        Panel     = [System.Drawing.ColorTranslator]::FromHtml('#171c21')
        Text      = [System.Drawing.ColorTranslator]::FromHtml('#eef2f4')
        Muted     = [System.Drawing.ColorTranslator]::FromHtml('#9aa7b0')
        Accent    = [System.Drawing.ColorTranslator]::FromHtml('#16ec06')
        OnAccent  = [System.Drawing.ColorTranslator]::FromHtml('#04210a')
        Secondary = [System.Drawing.ColorTranslator]::FromHtml('#2a323a')
        Fail      = [System.Drawing.ColorTranslator]::FromHtml('#ff6b6b')
        Warn      = [System.Drawing.ColorTranslator]::FromHtml('#ffb020')
        Link      = [System.Drawing.ColorTranslator]::FromHtml('#7fd8ff')
    }
}

function Get-AssetImage {
    param([string]$Name)
    if ($script:Images.ContainsKey($Name)) { return $script:Images[$Name] }
    $data = Get-EmbeddedAssetData
    if (-not $data.ContainsKey($Name)) { return $null }
    $bytes = [System.Convert]::FromBase64String($data[$Name])
    $stream = New-Object System.IO.MemoryStream -ArgumentList (, $bytes)
    $image = [System.Drawing.Image]::FromStream($stream)   # Stream bleibt offen (GDI+ braucht ihn)
    $script:Images[$Name] = $image
    return $image
}

function New-UiFont {
    param([float]$Size, [switch]$Bold)
    $style = [System.Drawing.FontStyle]::Regular
    if ($Bold) { $style = [System.Drawing.FontStyle]::Bold }
    return New-Object System.Drawing.Font -ArgumentList 'Segoe UI', $Size, $style
}

function New-UiButton {
    param([string]$Text, [switch]$Primary)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text
    $b.AutoSize = $true
    $b.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
    $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $b.FlatAppearance.BorderSize = 0
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.Padding = New-Object System.Windows.Forms.Padding -ArgumentList ([int](18 * $script:Scale)), ([int](8 * $script:Scale)), ([int](18 * $script:Scale)), ([int](8 * $script:Scale))
    $b.Margin = New-Object System.Windows.Forms.Padding -ArgumentList ([int](8 * $script:Scale))
    $b.MinimumSize = New-Object System.Drawing.Size -ArgumentList ([int](140 * $script:Scale)), ([int](52 * $script:Scale))
    if ($Primary) {
        $b.BackColor = $script:Colors.Accent; $b.ForeColor = $script:Colors.OnAccent; $b.Font = New-UiFont 14 -Bold
    }
    else {
        $b.BackColor = $script:Colors.Secondary; $b.ForeColor = $script:Colors.Text; $b.Font = New-UiFont 12
    }
    $b.Add_Click({ param($src) Invoke-UiAction ([string]$src.Tag) })
    return $b
}

function New-UiRichText {
    param([float]$Size, $Color)
    $r = New-Object System.Windows.Forms.RichTextBox
    $r.ReadOnly = $true
    $r.BorderStyle = [System.Windows.Forms.BorderStyle]::None
    $r.BackColor = $script:Colors.Back
    $r.ForeColor = $Color
    $r.Font = New-UiFont $Size
    $r.ScrollBars = [System.Windows.Forms.RichTextBoxScrollBars]::None
    $r.TabStop = $false
    $r.DetectUrls = $false
    $r.Cursor = [System.Windows.Forms.Cursors]::Default
    $r.Anchor = [System.Windows.Forms.AnchorStyles]'Left, Right, Top'
    $r.Height = [int](30 * $script:Scale)
    $r.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 0, ([int](4 * $script:Scale)), 0, ([int](8 * $script:Scale))
    $r.Add_ContentsResized({ param($src, $evt) $src.Height = $evt.NewRectangle.Height + 8 })
    return $r
}

function Set-RichText {
    param($Box, [string]$Markup)
    $Box.Clear()
    $regular = $Box.Font
    $bold = New-Object System.Drawing.Font -ArgumentList $regular, ([System.Drawing.FontStyle]::Bold)
    foreach ($part in (ConvertFrom-SimpleMarkup $Markup)) {
        $Box.SelectionStart = $Box.TextLength
        $Box.SelectionLength = 0
        if ($part.Bold) { $Box.SelectionFont = $bold } else { $Box.SelectionFont = $regular }
        $Box.AppendText($part.Text)
    }
    $Box.Visible = -not [string]::IsNullOrEmpty($Markup)
}

function New-MainForm {
    $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
    $script:Scale = [Math]::Max(1.0, $g.DpiX / 96.0)
    $g.Dispose()
    $s = $script:Scale

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Whoop Plus Einrichtungshelfer'
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
    $form.ClientSize = New-Object System.Drawing.Size -ArgumentList ([int](940 * $s)), ([int](700 * $s))
    $form.MinimumSize = New-Object System.Drawing.Size -ArgumentList ([int](760 * $s)), ([int](600 * $s))
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.BackColor = $script:Colors.Back
    $form.ForeColor = $script:Colors.Text
    $form.Font = New-UiFont 12
    try {
        if (Test-IsCompiledHost) {
            $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
        }
    }
    catch { $null = $_ }
    $form.Add_FormClosing({ $script:Closing = $true })

    $root = New-Object System.Windows.Forms.TableLayoutPanel
    $root.Dock = [System.Windows.Forms.DockStyle]::Fill
    $root.ColumnCount = 1
    $root.RowCount = 3
    $null = $root.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle -ArgumentList ([System.Windows.Forms.SizeType]::Percent), 100))
    $null = $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle -ArgumentList ([System.Windows.Forms.SizeType]::AutoSize)))
    $null = $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle -ArgumentList ([System.Windows.Forms.SizeType]::Percent), 100))
    $null = $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle -ArgumentList ([System.Windows.Forms.SizeType]::AutoSize)))
    $root.Padding = New-Object System.Windows.Forms.Padding -ArgumentList ([int](24 * $s))
    $form.Controls.Add($root)

    # Kopf: „Schritt 3 von 9“ + Fortschrittsbalken
    $header = New-Object System.Windows.Forms.TableLayoutPanel
    $header.Dock = [System.Windows.Forms.DockStyle]::Fill
    $header.AutoSize = $true
    $header.ColumnCount = 1
    $null = $header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle -ArgumentList ([System.Windows.Forms.SizeType]::Percent), 100))
    $stepLabel = New-Object System.Windows.Forms.Label
    $stepLabel.AutoSize = $true
    $stepLabel.ForeColor = $script:Colors.Muted
    $stepLabel.Font = New-UiFont 12
    $stepBar = New-Object System.Windows.Forms.ProgressBar
    $stepBar.Dock = [System.Windows.Forms.DockStyle]::Top
    $stepBar.Height = [int](10 * $s)
    $stepBar.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
    $header.Controls.Add($stepLabel)
    $header.Controls.Add($stepBar)
    $root.Controls.Add($header, 0, 0)

    # Inhalt: Bild links, Text rechts
    $content = New-Object System.Windows.Forms.TableLayoutPanel
    $content.Dock = [System.Windows.Forms.DockStyle]::Fill
    $content.ColumnCount = 2
    $content.RowCount = 1
    $null = $content.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle -ArgumentList ([System.Windows.Forms.SizeType]::Absolute), ([int](170 * $s))))
    $null = $content.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle -ArgumentList ([System.Windows.Forms.SizeType]::Percent), 100))
    $content.Padding = New-Object System.Windows.Forms.Padding -ArgumentList 0, ([int](20 * $s)), 0, 0
    $root.Controls.Add($content, 0, 1)

    $icon = New-Object System.Windows.Forms.PictureBox
    $icon.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
    $icon.Size = New-Object System.Drawing.Size -ArgumentList ([int](136 * $s)), ([int](136 * $s))
    $icon.Anchor = [System.Windows.Forms.AnchorStyles]::Top
    $content.Controls.Add($icon, 0, 0)

    $right = New-Object System.Windows.Forms.TableLayoutPanel
    $right.Dock = [System.Windows.Forms.DockStyle]::Fill
    $right.ColumnCount = 1
    $null = $right.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle -ArgumentList ([System.Windows.Forms.SizeType]::Percent), 100))
    $right.AutoScroll = $true
    $content.Controls.Add($right, 1, 0)

    $title = New-Object System.Windows.Forms.Label
    $title.AutoSize = $true
    $title.Font = New-UiFont 22 -Bold
    $title.ForeColor = $script:Colors.Text
    $title.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 0, 0, 0, ([int](12 * $s))

    $body = New-UiRichText -Size 14 -Color $script:Colors.Text

    $qrPanel = New-Object System.Windows.Forms.FlowLayoutPanel
    $qrPanel.AutoSize = $true
    $qrPanel.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
    $qrPanel.WrapContents = $false
    $qr = New-Object System.Windows.Forms.PictureBox
    $qr.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
    $qr.Size = New-Object System.Drawing.Size -ArgumentList ([int](200 * $s)), ([int](200 * $s))
    $qrCaption = New-UiRichText -Size 11 -Color $script:Colors.Muted
    $qrCaption.Anchor = [System.Windows.Forms.AnchorStyles]'Left, Top'
    $qrCaption.Width = [int](560 * $s)
    $qrPanel.Controls.Add($qr)
    $qrPanel.Controls.Add($qrCaption)

    $statusRow = New-Object System.Windows.Forms.TableLayoutPanel
    $statusRow.AutoSize = $true
    $statusRow.ColumnCount = 2
    $statusRow.Anchor = [System.Windows.Forms.AnchorStyles]'Left, Right, Top'
    $null = $statusRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle -ArgumentList ([System.Windows.Forms.SizeType]::AutoSize)))
    $null = $statusRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle -ArgumentList ([System.Windows.Forms.SizeType]::Percent), 100))
    $statusSymbol = New-Object System.Windows.Forms.Label
    $statusSymbol.AutoSize = $true
    $statusSymbol.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI Symbol', 30, ([System.Drawing.FontStyle]::Bold)
    $statusText = New-UiRichText -Size 14 -Color $script:Colors.Text
    $statusRow.Controls.Add($statusSymbol, 0, 0)
    $statusRow.Controls.Add($statusText, 1, 0)

    $activity = New-Object System.Windows.Forms.ProgressBar
    $activity.Anchor = [System.Windows.Forms.AnchorStyles]'Left, Right, Top'
    $activity.Height = [int](22 * $s)
    $activity.Visible = $false

    $note = New-UiRichText -Size 12 -Color $script:Colors.Muted

    $tiles = New-Object System.Windows.Forms.FlowLayoutPanel
    $tiles.AutoSize = $true
    $tiles.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
    $tiles.WrapContents = $false

    $links = New-Object System.Windows.Forms.FlowLayoutPanel
    $links.AutoSize = $true
    $links.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
    $links.WrapContents = $false

    foreach ($c in @($title, $body, $qrPanel, $statusRow, $activity, $note, $tiles, $links)) { $right.Controls.Add($c) }

    # Fuß: Hilfe/Zurück links, Hauptknopf rechts
    $footer = New-Object System.Windows.Forms.TableLayoutPanel
    $footer.Dock = [System.Windows.Forms.DockStyle]::Fill
    $footer.AutoSize = $true
    $footer.ColumnCount = 2
    $null = $footer.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle -ArgumentList ([System.Windows.Forms.SizeType]::Percent), 40))
    $null = $footer.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle -ArgumentList ([System.Windows.Forms.SizeType]::Percent), 60))
    $leftButtons = New-Object System.Windows.Forms.FlowLayoutPanel
    $leftButtons.AutoSize = $true
    $leftButtons.Dock = [System.Windows.Forms.DockStyle]::Fill
    $help = New-UiButton -Text 'Hilfe'
    $help.Tag = 'Help'
    $back = New-UiButton -Text 'Zurück'
    $back.Tag = 'Back'
    $leftButtons.Controls.Add($help)
    $leftButtons.Controls.Add($back)
    $rightButtons = New-Object System.Windows.Forms.FlowLayoutPanel
    $rightButtons.AutoSize = $true
    $rightButtons.Dock = [System.Windows.Forms.DockStyle]::Fill
    $rightButtons.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
    $primary = New-UiButton -Text 'Weiter' -Primary
    $rightButtons.Controls.Add($primary)
    $footer.Controls.Add($leftButtons, 0, 0)
    $footer.Controls.Add($rightButtons, 1, 0)
    $root.Controls.Add($footer, 0, 2)

    $form.AcceptButton = $primary

    $script:Ui = @{
        Form = $form; StepLabel = $stepLabel; StepBar = $stepBar; Icon = $icon; Right = $right
        Title = $title; Body = $body; QrPanel = $qrPanel; Qr = $qr; QrCaption = $qrCaption
        StatusRow = $statusRow; StatusSymbol = $statusSymbol; StatusText = $statusText
        Activity = $activity; Note = $note; Tiles = $tiles; Links = $links
        Help = $help; Back = $back; Primary = $primary; RightButtons = $rightButtons
    }
    # Breite der Textfelder an die Spalte anpassen (RichTextBox braucht eine feste Breite).
    $right.Add_Resize({ Update-UiWidths })
    return $form
}

function Update-UiWidths {
    if ($null -eq $script:Ui.Right) { return }
    $w = $script:Ui.Right.ClientSize.Width - [int](24 * $script:Scale)
    if ($w -lt 200) { return }
    foreach ($key in @('Body', 'Note', 'StatusRow', 'Activity')) { $script:Ui[$key].Width = $w }
    $script:Ui.StatusText.Width = [Math]::Max(150, $w - $script:Ui.StatusSymbol.Width - 10)
    $script:Ui.QrCaption.Width = $w
    foreach ($tile in $script:Ui.Tiles.Controls) { $tile.Width = $w }
}

function Set-Status {
    # Großes ✔/✖ mit einem Satz und – bei Fehlern – genau einer nächsten Aktion.
    param([ValidateSet('ok', 'fail', 'warn', 'busy', 'info', 'none')][string]$Kind, [string]$Text = '')
    $sym = $script:Ui.StatusSymbol
    switch ($Kind) {
        'ok' { $sym.Text = [string][char]0x2714; $sym.ForeColor = $script:Colors.Accent }
        'fail' { $sym.Text = [string][char]0x2716; $sym.ForeColor = $script:Colors.Fail }
        'warn' { $sym.Text = '!'; $sym.ForeColor = $script:Colors.Warn }
        'busy' { $sym.Text = [string][char]0x231B; $sym.ForeColor = $script:Colors.Muted }
        default { $sym.Text = '' }
    }
    Set-RichText $script:Ui.StatusText $Text
    $script:Ui.StatusRow.Visible = ($Kind -ne 'none')
    $script:Ui.Activity.Visible = ($Kind -eq 'busy')
    if ($Kind -eq 'busy') { Set-ActivityProgress -1 }
    Update-UiWidths
}

function Set-ActivityProgress {
    # -1 = läuft (ohne Prozentangabe), 0..100 = Prozent
    param([int]$Percent)
    $bar = $script:Ui.Activity
    if ($Percent -lt 0) {
        $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
        $bar.MarqueeAnimationSpeed = 30
    }
    else {
        $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
        $bar.Value = [Math]::Min(100, [Math]::Max(0, $Percent))
    }
}

function Set-PrimaryButton {
    param([string]$Text, [string]$Action)
    $b = $script:Ui.Primary
    if ([string]::IsNullOrEmpty($Text)) { $b.Visible = $false; return }
    $b.Text = $Text; $b.Tag = $Action; $b.Visible = $true; $b.Enabled = $true
}

function Set-SecondaryButtons {
    param([object[]]$Buttons)
    $panel = $script:Ui.RightButtons
    foreach ($c in @($panel.Controls)) {
        if ($c -ne $script:Ui.Primary) { $panel.Controls.Remove($c); $c.Dispose() }
    }
    foreach ($def in @($Buttons)) {
        if ($null -eq $def) { continue }
        $b = New-UiButton -Text $def.Text
        $b.Tag = $def.Action
        $panel.Controls.Add($b)
    }
}

function Add-SecondaryButton {
    param([string]$Text, [string]$Action)
    foreach ($c in $script:Ui.RightButtons.Controls) { if ([string]$c.Tag -eq $Action) { return } }
    $b = New-UiButton -Text $Text
    $b.Tag = $Action
    $script:Ui.RightButtons.Controls.Add($b)
}

function Set-Busy {
    param([bool]$Busy)
    foreach ($c in $script:Ui.RightButtons.Controls) { $c.Enabled = -not $Busy }
    $script:Ui.Back.Enabled = -not $Busy
}

function Show-Screen {
    param([hashtable]$Def)
    $ui = $script:Ui
    $ui.Form.SuspendLayout()
    try {
        $ui.Title.Text = $Def.Title
        $ui.Icon.Image = Get-AssetImage $Def.Icon
        Set-RichText $ui.Body $Def.Body
        Set-RichText $ui.Note $Def.Note
        if ($Def.Qr) {
            $ui.Qr.Image = Get-AssetImage $Def.Qr
            Set-RichText $ui.QrCaption $Def.QrCaption
            $ui.QrPanel.Visible = $true
        }
        else { $ui.QrPanel.Visible = $false }
        Set-Status 'none'

        foreach ($c in @($ui.Tiles.Controls)) { $ui.Tiles.Controls.Remove($c); $c.Dispose() }
        foreach ($tile in @($Def.Tiles)) {
            if ($null -eq $tile) { continue }
            $b = New-UiButton -Text $tile.Text -Primary:([bool]$tile.Main)
            $b.AutoSize = $false
            $b.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
            $b.Height = [int](64 * $script:Scale)
            $b.Font = New-UiFont 14 -Bold:([bool]$tile.Main)
            $b.Tag = $tile.Action
            $ui.Tiles.Controls.Add($b)
        }
        $ui.Tiles.Visible = (@($Def.Tiles).Count -gt 0)

        foreach ($c in @($ui.Links.Controls)) { $ui.Links.Controls.Remove($c); $c.Dispose() }
        foreach ($link in @($Def.Links)) {
            if ($null -eq $link) { continue }
            $l = New-Object System.Windows.Forms.LinkLabel
            $l.Text = $link.Text
            $l.AutoSize = $true
            $l.Font = New-UiFont 11
            $l.LinkColor = $script:Colors.Link
            $l.ActiveLinkColor = $script:Colors.Accent
            $l.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 0, ([int](6 * $script:Scale)), 0, 0
            $l.Tag = $link.Action
            $l.Add_LinkClicked({ param($src) Invoke-UiAction ([string]$src.Tag) })
            $ui.Links.Controls.Add($l)
        }
        $ui.Links.Visible = (@($Def.Links).Count -gt 0)

        Set-PrimaryButton $Def.Primary $Def.PrimaryAction
        Set-SecondaryButtons $Def.Secondary
        $ui.StepLabel.Visible = $Def.ShowProgress
        $ui.StepBar.Visible = $Def.ShowProgress
        if ($Def.ShowProgress -and $script:Plan.Count -gt 0) {
            $ui.StepLabel.Text = 'Schritt {0} von {1}' -f ($script:Index + 1), $script:Plan.Count
            $ui.StepBar.Maximum = $script:Plan.Count
            $ui.StepBar.Value = [Math]::Min($script:Plan.Count, $script:Index + 1)
        }
        $ui.Back.Visible = ($script:Index -ge 0)
    }
    finally { $ui.Form.ResumeLayout() }
    Update-UiWidths
}

function Stop-ScreenTimers {
    foreach ($t in @($script:ScreenTimers)) { try { $t.Stop(); $t.Dispose() } catch { $null = $_ } }
    $script:ScreenTimers.Clear()
}

function Start-ScreenTimer {
    # Wiederholt $Action alle $IntervalMs, solange dieser Bildschirm offen ist.
    param([int]$IntervalMs, [scriptblock]$Action, [switch]$Once)
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = $IntervalMs
    $timer.Tag = @{ Token = $script:ScreenToken; Action = $Action; Once = [bool]$Once }
    $timer.Add_Tick({
            param($src)
            $info = $src.Tag
            if ($info.Once) { $src.Stop() }
            if ($info.Token -ne $script:ScreenToken -or $script:Closing) { $src.Stop(); return }
            try { & $info.Action }
            catch { Show-Problem -Text 'Da ist etwas schiefgelaufen.' -Action 'Klicke auf **Nochmal versuchen**.' -Exception $_.Exception }
        })
    $null = $script:ScreenTimers.Add($timer)
    $timer.Start()
}

function Invoke-Later {
    param([int]$Milliseconds, [scriptblock]$Action)
    Start-ScreenTimer -IntervalMs $Milliseconds -Action $Action -Once
}

function Show-Problem {
    # Freundliche Meldung + eine konkrete nächste Aktion. Technisches nur in den Bericht.
    param([string]$Text, [string]$Action, $Exception)
    if ($null -ne $Exception) { Write-SetupLog ("Fehler in {0}: {1}" -f $script:CurrentId, $Exception.ToString()) 'ERROR' }
    $msg = $Text
    if ($Action) { $msg = $Text + "`n" + $Action }
    Set-Status 'fail' $msg
    Set-Busy $false
    Set-PrimaryButton 'Nochmal versuchen' 'Retry'
}

function Start-Mode {
    param([string]$Mode)
    $script:Mode = $Mode
    if ($Mode -in @('Full', 'NewPhone')) {
        # Einmalige iPhone-Schritte gelten für ein neues iPhone nicht mehr.
        $keepCompleted = $script:State.CompletedAt
        $script:State = ConvertTo-SetupState $null
        $script:State.CompletedAt = $keepCompleted
    }
    $script:State.LastMode = $Mode
    Save-SetupState $script:State
    $script:Plan = Get-SetupPlan -Mode $Mode -State $script:State
    Write-SetupLog ("Modus {0}: {1}" -f $Mode, ($script:Plan -join ', '))
    Enter-Screen 0
}

function Enter-Screen {
    param([int]$Index)
    Stop-ScreenTimers
    $script:ScreenToken++
    if ($Index -lt 0) { Show-StartScreen; return }
    if ($Index -ge $script:Plan.Count) { $script:Ui.Form.Close(); return }
    $script:Index = $Index
    $script:CurrentId = $script:Plan[$Index]
    $def = Get-ScreenDefinition -Id $script:CurrentId -Mode $script:Mode
    Write-SetupLog ("Bildschirm {0} ({1}/{2})" -f $script:CurrentId, ($Index + 1), $script:Plan.Count)
    Show-Screen $def
    if ($def.OnEnter) { Invoke-Later 300 ([scriptblock]::Create("Invoke-UiAction '$($def.OnEnter)'")) }
    if ($def.Kind -eq 'auto') { Invoke-Later 150 { Invoke-AutoStep $script:CurrentId } }
}

function Show-StartScreen {
    Stop-ScreenTimers
    $script:ScreenToken++
    $script:Index = -1
    $script:Plan = @()
    $script:CurrentId = 'Start'
    if ($script:State.CompletedAt) { Show-Screen (Get-ScreenDefinition 'Changed') }
    else { Show-Screen (Get-ScreenDefinition 'Welcome') }
}

function Move-Next { Enter-Screen ($script:Index + 1) }

function Move-Back {
    # Zurück zum vorigen Bildschirm, automatische Prüfungen überspringen (die liefen ja schon).
    $i = $script:Index - 1
    while ($i -ge 0 -and (Get-ScreenDefinition -Id $script:Plan[$i] -Mode $script:Mode).Kind -eq 'auto') { $i-- }
    Enter-Screen $i
}

function Invoke-UiAction {
    param([string]$Action)
    if ([string]::IsNullOrEmpty($Action)) { return }
    try {
        $name = $Action; $arg = ''
        $colon = $Action.IndexOf(':')
        if ($colon -gt 0) { $name = $Action.Substring(0, $colon); $arg = $Action.Substring($colon + 1) }
        switch ($name) {
            'Next' { Move-Next }
            'Back' { Move-Back }
            'Retry' { Enter-Screen $script:Index }
            'Quit' { $script:Ui.Form.Close() }
            'Mode' { Start-Mode $arg }
            'Confirm' {
                $script:State[$arg] = $true
                Save-SetupState $script:State
                Move-Next
            }
            'OpenUrl' { Open-Url $arg }
            'Help' { Copy-HelpReport }
            'CopySource' { Copy-SourceUrl -Announce }
            'CopySourceSilent' { Copy-SourceUrl }
            'Goto' {
                $target = [array]::IndexOf($script:Plan, $arg)
                if ($target -lt 0) { $target = $script:Index }
                Enter-Screen $target
            }
            'StartILoader' { Start-ILoaderApp }
            'InstallApple' { Install-AppleSoftwareUi }
            'SideStoreNotOpening' {
                $script:Plan = Add-PlanStepsBefore -Plan $script:Plan -Index $script:Index -Steps @('PhoneTrust', 'DevMode')
                Write-SetupLog ("SideStore öffnet nicht -> Plan: {0}" -f ($script:Plan -join ', '))
                Enter-Screen $script:Index
            }
            'MarkCompleted' {
                $script:State.CompletedAt = (Get-Date).ToString('s')
                Save-SetupState $script:State
            }
            default { Write-SetupLog "Unbekannte Aktion: $Action" 'WARN' }
        }
    }
    catch {
        Show-Problem -Text 'Da ist etwas schiefgelaufen.' -Action 'Klicke auf **Nochmal versuchen**. Hilft das nicht, klicke auf **Hilfe**.' -Exception $_.Exception
    }
}

function Open-Url {
    param([string]$Url)
    Write-SetupLog "Öffne $Url"
    try { Start-Process $Url } catch { Write-SetupLog "Konnte $Url nicht öffnen: $($_.Exception.Message)" 'WARN' }
}

function Set-ClipboardText {
    param([string]$Text)
    try { [System.Windows.Forms.Clipboard]::SetText($Text); return $true }
    catch {
        try { Set-Clipboard -Value $Text; return $true } catch { return $false }
    }
}

function Copy-SourceUrl {
    param([switch]$Announce)
    $ok = Set-ClipboardText $script:Config.SourceUrl
    if ($Announce -and $ok) { Set-Status 'ok' 'Adresse kopiert.' }
}

function Copy-HelpReport {
    $lines = @(
        "Whoop Plus Einrichtungshelfer $($script:HelperVersion)",
        "Zeit: $(Get-Date -Format 's')",
        "Modus: $($script:Mode) / Schritt: $($script:CurrentId)",
        "Windows: $(($script:Facts['Windows'] | Out-String).Trim())",
        '--- Bericht (letzte Zeilen) ---'
    )
    try { $lines += @(Get-Content -LiteralPath (Get-LogPath) -Tail 250 -ErrorAction Stop) } catch { $lines += '(kein Bericht)' }
    $ok = Set-ClipboardText ($lines -join "`r`n")
    if ($ok) {
        $msg = "Ein Fehlerbericht ist jetzt kopiert.`n`nFüge ihn mit Strg + V in eine Nachricht ein (z. B. E-Mail oder WhatsApp) und schicke ihn an die Person, die dir hilft.`n`nDeine Apple-ID oder Passwörter stehen nicht darin."
    }
    else {
        $msg = "Der Bericht konnte nicht kopiert werden. Du findest ihn hier:`n$(Get-LogPath)"
    }
    $null = [System.Windows.Forms.MessageBox]::Show($script:Ui.Form, $msg, 'Hilfe', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
}

function Start-ILoaderApp {
    if (@(Get-Process -Name 'iloader' -ErrorAction SilentlyContinue).Count -gt 0) {
        Write-SetupLog 'iloader läuft bereits'
        return
    }
    $inst = Get-InstalledILoader
    if ($null -eq $inst -or -not $inst.Installed) {
        Show-Problem -Text 'iloader wurde nicht gefunden.' -Action 'Klicke auf **Nochmal versuchen**. Ich installiere es dann neu.'
        if ($script:Plan -contains 'ILoader') { Set-PrimaryButton 'Nochmal versuchen' 'Goto:ILoader' }
        return
    }
    Write-SetupLog "Starte iloader: $($inst.ExePath)"
    Start-Process -FilePath $inst.ExePath
}

function Complete-AutoStep {
    # Erfolg: grüner Haken, kurz stehen lassen, dann von selbst weiter.
    param([string]$Text, [int]$DelayMs = 1300)
    Set-Busy $false
    Set-Status 'ok' $Text
    Set-PrimaryButton 'Weiter' 'Next'
    Invoke-Later $DelayMs { Move-Next }
}

function Invoke-AutoStep {
    param([string]$Id)
    Set-Busy $true
    try {
        switch ($Id) {
            'Windows' { Invoke-AutoWindows }
            'AppleSoftware' { Invoke-AutoAppleSoftware }
            'Connect' { Invoke-AutoConnect }
            'ILoader' { Invoke-AutoILoader }
        }
    }
    catch {
        Show-Problem -Text 'Da ist etwas schiefgelaufen.' -Action 'Klicke auf **Nochmal versuchen**. Hilft das nicht, klicke auf **Hilfe**.' -Exception $_.Exception
    }
}

function Invoke-AutoWindows {
    $info = Get-WindowsInfo
    $support = Get-WindowsSupport -Build $info.Build -NativeArchitecture $info.NativeArchitecture -Is64BitOS $info.Is64BitOS
    $script:Facts['Windows'] = "$($support.Name) $($info.DisplayVersion) Build $($info.Build) $($info.NativeArchitecture)"
    $script:Facts['IsWindows11'] = $support.IsWindows11
    Write-SetupLog ("Windows: {0} -> {1}" -f $script:Facts['Windows'], $support.Status)
    Set-Busy $false
    switch ($support.Status) {
        'Ok' { Complete-AutoStep $support.Message }
        'Warn' {
            Set-Status 'warn' ($support.Message + "`n" + $support.Action)
            Set-PrimaryButton 'Trotzdem weiter' 'Next'
        }
        default {
            Set-Status 'fail' ($support.Message + "`n" + $support.Action)
            Set-PrimaryButton 'Beenden' 'Quit'
            Set-SecondaryButtons @(@{ Text = 'Trotzdem versuchen'; Action = 'Next' })
        }
    }
}

function Invoke-AutoAppleSoftware {
    Set-Status 'busy' 'Ich schaue nach …'
    $apple = Test-AppleSoftware
    Write-SetupLog ("Apple-Programm: vorhanden={0} läuft={1} ({2})" -f $apple.Present, $apple.ServiceRunning, $apple.Source)
    if ($apple.Present) {
        Complete-AutoStep 'Das Apple-Programm ist schon da.'
        return
    }
    Set-Busy $false
    Set-Status 'info' 'Das Programm fehlt noch. Klicke auf **Installieren**.'
    Set-PrimaryButton 'Installieren' 'InstallApple'
}

function Wait-AppleSoftware {
    param([int]$TimeoutMs)
    return (Wait-UiCondition -Until { (Test-AppleSoftware).Present } -TimeoutMs $TimeoutMs -IntervalMs 1500)
}

function Install-AppleSoftwareUi {
    $token = $script:ScreenToken
    Set-Busy $true
    $winget = Find-Winget
    $isWin11 = [bool]$script:Facts['IsWindows11']
    $methods = Get-AppleInstallMethods -IsWindows11 $isWin11 -WingetAvailable ([bool]$winget)
    Write-SetupLog ("Apple-Programm installieren, Wege: {0} (winget: {1})" -f ($methods -join ', '), $winget)
    foreach ($method in $methods) {
        if ($token -ne $script:ScreenToken -or $script:Closing) { return }
        if ($method -eq 'Manual') { Show-AppleManualInstall; return }
        $label = 'iTunes'
        if ($method -eq 'AppleDevicesStore') { $label = '„Apple-Geräte“' }
        Set-Status 'busy' "Das Apple-Programm ($label) wird installiert …`nDas kann ein paar Minuten dauern."
        $progress = [hashtable]::Synchronized(@{ Line = '' })
        try {
            $result = Invoke-InBackground -ScriptBlock $script:RunProcessScript -ArgumentList @($winget, (Get-WingetArguments $method), $progress) -OnTick {
                if ($progress.Line -match '(\d{1,3})\s*%') { Set-ActivityProgress ([int]$Matches[1]) }
            }
            $kind = Get-WingetResultKind ([int]$result.ExitCode)
            Write-SetupLog ("winget {0}: Exit {1} ({2})`n{3}" -f $method, $result.ExitCode, $kind, $result.Output)
        }
        catch { Write-SetupLog ("winget {0} fehlgeschlagen: {1}" -f $method, $_.Exception.Message) 'WARN' }
        Set-Status 'busy' 'Ich prüfe die Installation …'
        if (Wait-AppleSoftware -TimeoutMs 30000) {
            Complete-AutoStep 'Das Apple-Programm ist installiert.'
            return
        }
    }
}

function Show-AppleManualInstall {
    # Ohne automatische Installation: Apple-Download im Browser öffnen und warten, bis das Programm da ist.
    Open-Url $script:Config.ITunesDownloadUrl
    Set-Busy $false
    Set-Status 'info' "Im Browser wird jetzt **iTunes** von Apple geladen.`nÖffne die Datei und klicke dich mit **Weiter** durch. Ich warte hier."
    Set-PrimaryButton 'Nochmal prüfen' 'Retry'
    Set-SecondaryButtons @(@{ Text = 'Apple-Geräte (Microsoft Store)'; Action = 'OpenUrl:' + $script:Config.AppleDevicesStoreUrl })
    Start-ScreenTimer -IntervalMs 3000 -Action {
        if ((Test-AppleSoftware).Present) {
            Stop-ScreenTimers
            Write-SetupLog 'Apple-Programm nach manueller Installation gefunden'
            Complete-AutoStep 'Das Apple-Programm ist installiert.'
        }
    }
}

function Invoke-AutoConnect {
    $script:ConnectStarted = Get-Date
    $script:ConnectHintShown = $false
    $first = Test-IPhoneConnected
    if ($first.Connected) {
        Write-SetupLog "iPhone erkannt ($($first.Via))"
        Complete-AutoStep 'iPhone gefunden.' 1000
        return
    }
    Set-Busy $false
    Set-Status 'busy' 'Ich warte auf dein iPhone …'
    Set-PrimaryButton $null $null
    Start-ScreenTimer -IntervalMs 2000 -Action {
        $check = Test-IPhoneConnected
        if ($check.Connected) {
            Stop-ScreenTimers
            Write-SetupLog "iPhone erkannt ($($check.Via))"
            Complete-AutoStep 'iPhone gefunden.' 1000
            return
        }
        if (-not $script:ConnectHintShown -and ((Get-Date) - $script:ConnectStarted).TotalSeconds -gt 45) {
            $script:ConnectHintShown = $true
            Write-SetupLog 'iPhone nach 45 s nicht erkannt' 'WARN'
            Set-RichText $script:Ui.Note 'Klappt es nicht? Probiere ein anderes Kabel oder einen anderen USB-Anschluss. Das iPhone muss entsperrt sein.'
            Set-SecondaryButtons @(@{ Text = 'Trotzdem weiter'; Action = 'Next' })
            Update-UiWidths
        }
    }
}

function Invoke-AutoILoader {
    Set-Status 'busy' 'Ich prüfe iloader …'
    $installed = Get-InstalledILoader
    $release = Get-ILoaderLatestRelease
    $installedVersion = $null
    if ($null -ne $installed -and $installed.Installed) { $installedVersion = $installed.Version }
    Write-SetupLog ("iloader installiert: {0} ({1}); neueste: {2} {3}" -f $installedVersion, (Get-PropValue $installed 'ExePath'), (Get-PropValue $release 'Version'), (Get-PropValue $release 'Url'))

    if ($null -eq $release) {
        if ($installedVersion -or ($null -ne $installed -and $installed.Installed)) {
            Complete-AutoStep 'iloader ist installiert.' 1500
            return
        }
        Show-Problem -Text 'Ich komme gerade nicht ins Internet.' -Action 'Bitte prüfe die Internetverbindung und klicke auf **Nochmal versuchen**.'
        return
    }
    if ($null -ne $installed -and $installed.Installed -and -not (Test-UpdateAvailable $installedVersion $release.Version)) {
        Complete-AutoStep "iloader ist aktuell (Version $installedVersion)."
        return
    }

    # Herunterladen
    $dir = Join-Path (Get-AppDataDir) 'downloads'
    if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
    $target = Join-Path $dir $release.FileName
    $partial = $target + '.part'
    $verb = 'wird geladen'
    if ($installedVersion) { $verb = 'wird aktualisiert' }
    $progress = [hashtable]::Synchronized(@{ Done = 0L; Total = [long]$release.Size; Cancel = $false })
    Set-Status 'busy' "iloader $verb …"
    try {
        $null = Invoke-InBackground -ScriptBlock $script:DownloadScript -ArgumentList @($release.Url, $partial, $progress, $script:Config.UserAgent) -OnTick {
            if ($script:Closing) { $progress.Cancel = $true }
            $total = [long]$progress.Total
            if ($total -le 0) { $total = [long]$release.Size }
            if ($total -gt 0) {
                Set-ActivityProgress ([int](100 * $progress.Done / $total))
                Set-RichText $script:Ui.StatusText ("iloader $verb … {0} von {1}" -f (Format-ByteSize $progress.Done), (Format-ByteSize $total))
            }
        }
    }
    catch {
        Show-Problem -Text 'Der Download hat nicht geklappt.' -Action 'Bitte prüfe die Internetverbindung und klicke auf **Nochmal versuchen**.' -Exception $_.Exception
        return
    }
    $actualSize = (Get-Item -LiteralPath $partial).Length
    $expected = [long]$release.Size
    if ($expected -le 0) { $expected = [long]$progress.Total }
    $actualSha = $null
    if ($release.Sha256) { $actualSha = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash }
    $check = Test-DownloadComplete -ActualSize $actualSize -ExpectedSize $expected -ActualSha256 $actualSha -ExpectedSha256 $release.Sha256
    Write-SetupLog ("Download {0}: {1} Bytes, erwartet {2}, SHA256 {3} -> {4} {5}" -f $release.FileName, $actualSize, $expected, $actualSha, $check.Ok, $check.Reason)
    if (-not $check.Ok) {
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        Show-Problem -Text 'Der Download ist unvollständig.' -Action 'Klicke auf **Nochmal versuchen**.'
        return
    }
    Move-Item -LiteralPath $partial -Destination $target -Force

    # Installieren
    Set-Status 'busy' ("iloader wird installiert ({0}) …`nFragt Windows `„Möchten Sie zulassen …`“? Dann auf **Ja** klicken." -f (Format-ByteSize $actualSize))
    Stop-ILoaderIfRunning
    $result = Install-ILoaderPackage -Path $target
    Write-SetupLog "Installation iloader: $result"
    $after = Get-InstalledILoader
    $ok = ($null -ne $after -and $after.Installed -and -not (Test-UpdateAvailable $after.Version $release.Version))
    if ($ok) {
        Complete-AutoStep "iloader ist bereit (Version $($after.Version))."
        return
    }
    switch ($result) {
        'Cancelled' { Show-Problem -Text 'Die Installation wurde abgebrochen.' -Action 'Klicke auf **Nochmal versuchen** und dann bei Windows auf **Ja**.' }
        'Busy' { Show-Problem -Text 'Gerade läuft schon eine andere Installation.' -Action 'Warte kurz und klicke dann auf **Nochmal versuchen**.' }
        default {
            Show-Problem -Text 'Die Installation hat nicht geklappt.' -Action 'Klicke auf **Selbst installieren** und dann auf **Weiter**, bis es fertig ist.'
            Set-SecondaryButtons @(@{ Text = 'Selbst installieren'; Action = 'OpenUrl:' + $target })
        }
    }
}

function Install-ILoaderPackage {
    param([string]$Path)
    $process = $null
    try {
        if ($Path -match '\.msi$') {
            $msiLog = Join-Path (Get-AppDataDir) 'iloader-install.txt'
            $msiArgs = @('/i', ('"{0}"' -f $Path), '/qb!', '/norestart', '/l*', ('"{0}"' -f $msiLog))
            $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Verb RunAs -PassThru -ErrorAction Stop
        }
        else {
            # EXE-Installer (NSIS) installiert still für den aktuellen Benutzer.
            $process = Start-Process -FilePath $Path -ArgumentList '/S' -PassThru -ErrorAction Stop
        }
    }
    catch {
        if (Test-IsUserCancelled $_.Exception) { Write-SetupLog 'Windows-Abfrage abgelehnt' 'WARN'; return 'Cancelled' }
        Write-SetupLog "Installer-Start fehlgeschlagen: $($_.Exception.Message)" 'ERROR'
        return 'Failed'
    }
    $null = Wait-UiCondition -Until { $process.HasExited } -IntervalMs 250
    try { return (Get-MsiResultKind $process.ExitCode) } catch { return 'Unknown' }
}

function Start-Gui {
    Initialize-UiAssemblies
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $script:State = Read-SetupState
    Write-SetupLog ("Start {0}, gemerkt: {1}" -f $script:HelperVersion, (([pscustomobject]$script:State | ConvertTo-Json -Compress)))
    $form = New-MainForm
    $script:UiActive = $true
    # Erst wenn das Fenster sichtbar ist: so passen sich die Textfelder sicher an ihren Inhalt an.
    $form.Add_Shown({
            try { Update-UiWidths; Show-StartScreen }
            catch { Write-SetupLog ("Startbildschirm: {0}" -f $_.Exception.ToString()) 'ERROR' }
        })
    try { $null = $form.ShowDialog() }
    finally {
        $script:UiActive = $false
        Stop-ScreenTimers
        $form.Dispose()
        Write-SetupLog 'Ende'
    }
}

# endregion

# region Selbsttest (ohne Fenster)

function Invoke-SelfTest {
    param([string]$ReportPath)
    $results = New-Object System.Collections.Generic.List[object]
    $add = {
        param($Name, $Ok, $Detail)
        $results.Add([pscustomobject]@{ Name = $Name; Ok = [bool]$Ok; Detail = [string]$Detail })
    }
    $onWindows = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)

    try { Write-SetupLog "Selbsttest $($script:HelperVersion)"; & $add 'Bericht schreibbar' (Test-Path -LiteralPath (Get-LogPath)) (Get-LogPath) }
    catch { & $add 'Bericht schreibbar' $false $_.Exception.Message }

    try {
        $data = Get-EmbeddedAssetData
        $bad = @()
        foreach ($key in $data.Keys) {
            $bytes = [System.Convert]::FromBase64String($data[$key])
            if ($bytes.Length -lt 8 -or $bytes[0] -ne 0x89 -or $bytes[1] -ne 0x50) { $bad += $key }
        }
        & $add 'Bilder eingebettet' ($bad.Count -eq 0 -and $data.Count -ge 10) ("{0} Bilder, fehlerhaft: {1}" -f $data.Count, ($bad -join ','))
    }
    catch { & $add 'Bilder eingebettet' $false $_.Exception.Message }

    try {
        $missing = @()
        foreach ($mode in @('First', 'Full', 'NewPhone', 'Check', 'Expired', 'Pairing')) {
            foreach ($id in (Get-SetupPlan -Mode $mode -State $null)) {
                $def = Get-ScreenDefinition -Id $id -Mode $mode
                if ($def.Icon -and -not (Get-EmbeddedAssetData).ContainsKey($def.Icon)) { $missing += "$id/$($def.Icon)" }
            }
        }
        & $add 'Ablaufpläne' ($missing.Count -eq 0) ("fehlende Bilder: {0}" -f ($missing -join ','))
    }
    catch { & $add 'Ablaufpläne' $false $_.Exception.Message }

    try {
        $state = ConvertTo-SetupState $null
        $state.VpnDone = $true
        $roundTrip = ConvertTo-SetupState (([pscustomobject]$state | ConvertTo-Json) | ConvertFrom-Json)
        & $add 'Gemerkte Schritte (JSON)' ($roundTrip.VpnDone -eq $true -and $roundTrip.TrustDone -eq $false) ''
    }
    catch { & $add 'Gemerkte Schritte (JSON)' $false $_.Exception.Message }

    if ($onWindows) {
        # Diese Prüfungen müssen nur fehlerfrei laufen – das Ergebnis hängt vom PC ab.
        try {
            $info = Get-WindowsInfo
            $support = Get-WindowsSupport -Build $info.Build -NativeArchitecture $info.NativeArchitecture -Is64BitOS $info.Is64BitOS
            & $add 'Windows-Prüfung' ($info.Build -gt 0) ("{0} Build {1} {2} -> {3}" -f $support.Name, $info.Build, $info.NativeArchitecture, $support.Status)
        }
        catch { & $add 'Windows-Prüfung' $false $_.Exception.Message }
        try { $a = Test-AppleSoftware; & $add 'Apple-Programm-Prüfung' $true ("vorhanden={0} ({1})" -f $a.Present, $a.Source) }
        catch { & $add 'Apple-Programm-Prüfung' $false $_.Exception.Message }
        try { $w = Find-Winget; & $add 'winget-Suche' $true ("{0}" -f $w) }
        catch { & $add 'winget-Suche' $false $_.Exception.Message }
        try { $i = Get-InstalledILoader; & $add 'iloader-Suche' $true ("{0}" -f (($i | ConvertTo-Json -Compress))) }
        catch { & $add 'iloader-Suche' $false $_.Exception.Message }
        try { $c = Test-IPhoneConnected; & $add 'iPhone-Suche' $true ("verbunden={0} {1}" -f $c.Connected, $c.Via) }
        catch { & $add 'iPhone-Suche' $false $_.Exception.Message }
        try {
            Initialize-UiAssemblies
            $form = New-MainForm
            foreach ($id in @('Welcome', 'Changed', 'Windows', 'AppleSoftware', 'VpnInstall', 'VpnConnect', 'Connect', 'ILoader', 'ILoaderLogin',
                    'ILoaderInstall', 'PhoneTrust', 'DevMode', 'SideStoreOpen', 'SideStoreRefresh', 'AddSource', 'Done', 'CheckDone',
                    'PairingDelete', 'PairingSelect', 'PairingPlace', 'PairingDone')) {
                Show-Screen (Get-ScreenDefinition -Id $id)
            }
            Set-Status 'ok' 'Test **fett**'
            Set-Status 'busy' 'Test'
            Set-ActivityProgress 50
            $form.Dispose()
            & $add 'Fenster aufbauen (unsichtbar)' $true ''
        }
        catch { & $add 'Fenster aufbauen (unsichtbar)' $false $_.Exception.ToString() }
    }

    # Netz: nur Hinweis, kein Fehlschlag (Ratenbegrenzung der GitHub-API auf geteilten Rechnern).
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $release = Get-ILoaderLatestRelease
        $detail = 'nicht erreichbar'
        if ($null -ne $release) { $detail = "{0} {1} ({2}, {3})" -f $release.Version, $release.FileName, (Format-ByteSize $release.Size), $release.Source }
        $results.Add([pscustomobject]@{ Name = 'iloader-Version online (Hinweis)'; Ok = $true; Detail = $detail })
    }
    catch { $results.Add([pscustomobject]@{ Name = 'iloader-Version online (Hinweis)'; Ok = $true; Detail = $_.Exception.Message }) }

    $failed = @($results | Where-Object { -not $_.Ok })
    foreach ($r in $results) {
        $level = 'INFO'
        if (-not $r.Ok) { $level = 'ERROR' }
        Write-SetupLog ("Selbsttest {0}: {1} {2}" -f $r.Name, $(if ($r.Ok) { 'OK' } else { 'FEHLER' }), $r.Detail) $level
    }
    $report = [pscustomobject]@{
        Version = $script:HelperVersion
        Ok      = ($failed.Count -eq 0)
        Results = $results.ToArray()
    }
    if ($ReportPath) {
        [System.IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding -ArgumentList $false))
    }
    if (-not (Test-IsCompiledHost)) {
        foreach ($r in $results) { Write-Host ("[{0}] {1}: {2}" -f $(if ($r.Ok) { 'OK' } else { 'FEHLER' }), $r.Name, $r.Detail) }
    }
    if ($failed.Count -eq 0) { return 0 }
    return 1
}

# endregion

# region GENERATED-ASSETS (nicht von Hand ändern – tools/windows-setup/assets/render-assets.cjs)
function Get-EmbeddedAssetData {
    # Base64-kodierte PNG-Bilder. Leerzeichen und Zeilenumbrüche ignoriert [Convert]::FromBase64String.
    return @{
        'step-pc' = @'
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
AAAASUVORK5CYII=
'@
        'step-apple' = @'
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
'@
        'step-vpn' = @'
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
EELI4Of/AaP9bEww1MIcAAAAAElFTkSuQmCC
'@
        'step-cable' = @'
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
'@
        'step-download' = @'
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
'@
        'step-login' = @'
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
TkSuQmCC
'@
        'step-install' = @'
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
'@
        'step-trust' = @'
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
'@
        'step-devmode' = @'
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
'@
        'step-refresh' = @'
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
'@
        'step-add' = @'
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
wI3v3yvRY9t6bzLAAAAAAElFTkSuQmCC
'@
        'step-repair' = @'
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
'@
        'step-question' = @'
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
'@
        'step-done' = @'
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
+2D07XsAAAAASUVORK5CYII=
'@
        'step-warn' = @'
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
'@
        'qr-localdevvpn' = @'
iVBORw0KGgoAAAANSUhEUgAAAOoAAADqAQAAAACE7+TjAAABi0lEQVR42u1Zy23FMAwT6gEyUlb3SBnAgCqSStJeXo8NgRhGXp51
oQWK+iTy05rxml/zL/OMWltG7NoLG6tMX/Fx/acZ8OoGa8sl2NscRz2T509HXh4G1COAGSd1kRmbDfKCHQAMb3shF+w64V8P5KKH
qFJ7wOcePKe2gCH39tCWXpQXyOM4rsPHs+WMTXoeyIs5DsgRlQW+6K2trJSHAVuYg8rPoAreqe3LRFsGPT8ImFSZw8Dnk96e61by
POP08aq4gd5gCOoW+B81gAPP+Qt5kR6K6vV8PvIitsJTWYk5FFJpgJylCwuYvsIVp4/P/nvS7YjWFpndAXmp997c3rKpoiA1QB4j
BRvvEbtJ9mcfcerJEHJewYItJExjViZKj0zUrL5EJjw6i2xWK4eSMEuEMehDe9JyF7rMRyY9UacejVzEHJM+NNWNXg1pGNQt3fsr
dV488dBzzlsUlXzqFmGCfLLK0gsrLh+fi/A/w9Nlljuyd7TD02XGpVqLiamHMC4zrveDyGv+y/wNdQ9n5LFM60oAAAAASUVORK5C
YII=
'@
        'qr-source' = @'
iVBORw0KGgoAAAANSUhEUgAAATIAAAEyAQAAAABRvWFoAAACmklEQVR42u1aS27lMAwTJgfIkXx1H8kHMKCapOTpYhZddogXPBTu
e9kw+pCiEvmja8bnvs99/8d9M8715rNwfnLuN/U5/278hu//xM+u334fsBxg+z1I86COd+bC94C/hlCb4T1BPHjP3wM5GWWgPrEG
3job4sUHIT7XCe5miH3xsn7XCTHKmbmNgyVe1i8ju8bDat0xHvYzy/plf577nx/D/tzMFOhO6ldVvwy9fvXjI4T4pLHIqHGCoWKY
xXezI5GGCBzXQLPS4XWLb0d2nH6laOobYh928RXjIG+RzC0spbiShWyWz4Q598W+1KnwEHBYYac3kLEgX/Dv30ADOB+FW3+GbkwW
Lw7sVKplsbNdfwaiFMaHySy51bPhdKvfEpAYfk/2olEzqyGqUd1u8WXGEteKe9AIrMHBrV9BXKF+Va3RTKRv/PiIDZnZy/58h0GR
kZ/ekGYu8Vxjb0pSlrFjFl/p56WZt+bf79OEYX8uHyPl7SS1tEZgu3khr67Q4C8FIgfAVG9EVFirfp8lMpqO9QuBIVCiXbVrkTL0
lZ3fHrVNSJ3bvptNxMOvX4l/tV8QN0U5AH5+3ZSHQ+AMNIfBFlpz2/k5mzOCrKr91uxQFjRZyc7fGO1Wxa7+PNTE6Oq4zQtCVMqZ
/bnsHT4HP/5VGit1NQPeTFaI3fYLHPA1FmntG+XERlk9bvuUu1mQy5EXqQrZUT/n09t8LUZVvxVlP3+yB39paTFvi4203A+KknY9
gXEnBcP9EQIqZTWyGnKW6fGWG++3339oQe9i5NoyOM6/9/2N8XzX0mvssKzfwpvNvO1vZLbissRbK34N+DQ3ZHH46efsMTDrtY0U
H91dkuX7Of2+yl2Gjn7jbjjy7+c92s99Bvd9Aa1ORXm+HVf/AAAAAElFTkSuQmCC
'@
    }
}
# endregion GENERATED-ASSETS

# region Start
if ($LibraryOnly) { return }
if ($SelfTest) {
    $code = Invoke-SelfTest -ReportPath $SelfTestReport
    exit $code
}
try {
    Start-Gui
}
catch {
    Write-SetupLog ("Unerwarteter Fehler: {0}" -f $_.Exception.ToString()) 'ERROR'
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $null = [System.Windows.Forms.MessageBox]::Show(
            "Da ist leider etwas schiefgelaufen.`n`nBitte starte den Helfer neu. Hilft das nicht, schicke den Bericht an die Person, die dir hilft:`n$(Get-LogPath)",
            'Whoop Plus Einrichtungshelfer', 'OK', 'Warning')
    }
    catch { $null = $_ }
    exit 1
}
# endregion
