# Pester 5 – Tests der reinen Funktionen des Einrichtungshelfers (laufen unter Windows PowerShell 5.1 und PowerShell 7).
#   Invoke-Pester -Path tools/windows-setup/tests

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot '..\WhoopPlusSetup.ps1'
    if (-not (Test-Path $script:ScriptPath)) { $script:ScriptPath = Join-Path $PSScriptRoot '../WhoopPlusSetup.ps1' }
    $env:LOCALAPPDATA = Join-Path ([System.IO.Path]::GetTempPath()) ('wps-tests-' + [guid]::NewGuid())
    . $script:ScriptPath -LibraryOnly
    Set-StrictMode -Version Latest

    # Echte Asset-Liste von iloader v2.4.0 (gekürzt auf die relevanten Felder).
    $script:Iloader240Assets = @(
        'iloader-darwin-universal.app.tar.gz', 'iloader-darwin-universal.app.tar.gz.sig', 'iloader-darwin-universal.dmg',
        'iloader-linux-aarch64.AppImage', 'iloader-linux-amd64.AppImage', 'iloader-linux-amd64.deb', 'iloader-linux-x86_64.rpm',
        'iloader-windows-x64.exe', 'iloader-windows-x64.exe.sig', 'iloader-windows-x64.msi', 'iloader-windows-x64.msi.sig', 'latest.json'
    ) | ForEach-Object {
        [pscustomobject]@{ name = $_; size = 8892416; browser_download_url = "https://github.com/nab138/iloader/releases/download/v2.4.0/$_" }
    }
}

AfterAll {
    if ($env:LOCALAPPDATA -and $env:LOCALAPPDATA -like '*wps-tests-*') { Remove-Item -Recurse -Force $env:LOCALAPPDATA -ErrorAction SilentlyContinue }
}

Describe 'Skriptdatei' {
    It 'ist UTF-8 mit BOM (sonst liest Windows PowerShell 5.1 die Umlaute falsch)' {
        $bytes = [System.IO.File]::ReadAllBytes($script:ScriptPath)
        $bytes[0..2] | Should -Be @(0xEF, 0xBB, 0xBF)
    }
    It 'lässt sich ohne Syntaxfehler lesen' {
        $tokens = $null; $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $script:ScriptPath).Path, [ref]$tokens, [ref]$errors)
        @($errors).Count | Should -Be 0
    }
    It 'nutzt keine PowerShell-7-Syntax (??, ?:, &&, ||)' {
        $tokens = $null; $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $script:ScriptPath).Path, [ref]$tokens, [ref]$errors)
        $kinds = @($tokens | ForEach-Object { $_.Kind.ToString() })
        $kinds | Should -Not -Contain 'QuestionQuestion'
        $kinds | Should -Not -Contain 'QuestionMark'
        $kinds | Should -Not -Contain 'AndAnd'
        $kinds | Should -Not -Contain 'OrOr'
    }
}

Describe 'Versionen' {
    It 'liest <Text> als <Expected>' -TestCases @(
        @{ Text = 'v2.4.0'; Expected = '2.4.0.0' }
        @{ Text = '2.4'; Expected = '2.4.0.0' }
        @{ Text = '2.10.1-beta.2'; Expected = '2.10.1.0' }
        @{ Text = 'iloader 1.2.3.4'; Expected = '1.2.3.4' }
    ) {
        (ConvertTo-VersionObject $Text).ToString() | Should -Be $Expected
    }
    It 'gibt $null für Unsinn' {
        ConvertTo-VersionObject '' | Should -BeNullOrEmpty
        ConvertTo-VersionObject 'keine' | Should -BeNullOrEmpty
    }
    It 'erkennt Updates: <Installed> -> <Latest> = <Expected>' -TestCases @(
        @{ Installed = '2.3.9'; Latest = 'v2.4.0'; Expected = $true }
        @{ Installed = '2.4.0'; Latest = 'v2.4.0'; Expected = $false }
        @{ Installed = '2.10.0'; Latest = 'v2.9.9'; Expected = $false }
        @{ Installed = $null; Latest = 'v2.4.0'; Expected = $true }
        @{ Installed = '2.4.0'; Latest = $null; Expected = $false }
    ) {
        Test-UpdateAvailable $Installed $Latest | Should -Be $Expected
    }
}

Describe 'iloader-Release' {
    It 'wählt das MSI der Release v2.4.0' {
        (Select-ILoaderAsset -Assets $script:Iloader240Assets).name | Should -Be 'iloader-windows-x64.msi'
    }
    It 'nimmt die EXE, wenn es kein MSI gibt, und nie eine .sig' {
        $assets = @($script:Iloader240Assets | Where-Object { $_.name -notlike '*.msi' })
        (Select-ILoaderAsset -Assets $assets).name | Should -Be 'iloader-windows-x64.exe'
    }
    It 'erkennt auch Tauri-Standardnamen' {
        $assets = @([pscustomobject]@{ name = 'iloader_2.5.0_x64_en-US.msi' }, [pscustomobject]@{ name = 'iloader_2.5.0_x64_en-US.msi.sig' })
        (Select-ILoaderAsset -Assets $assets).name | Should -Be 'iloader_2.5.0_x64_en-US.msi'
    }
    It 'gibt $null ohne Windows-Datei' {
        Select-ILoaderAsset -Assets @([pscustomobject]@{ name = 'iloader-linux-amd64.deb' }) | Should -BeNullOrEmpty
        Select-ILoaderAsset -Assets @() | Should -BeNullOrEmpty
    }
    It 'wandelt eine API-Antwort samt SHA-256 um' {
        $msi = $script:Iloader240Assets | Where-Object name -eq 'iloader-windows-x64.msi'
        $withDigest = $msi.PSObject.Copy()
        $withDigest | Add-Member -NotePropertyName digest -NotePropertyValue ('sha256:' + ('ab' * 32))
        $release = [pscustomobject]@{ tag_name = 'v2.4.0'; assets = @($withDigest) }
        $info = ConvertFrom-ILoaderApiRelease $release
        $info.Version | Should -Be '2.4.0'
        $info.Kind | Should -Be 'msi'
        $info.Size | Should -Be 8892416
        $info.Sha256 | Should -Be ('AB' * 32)
        $info.Url | Should -Match '/v2\.4\.0/iloader-windows-x64\.msi$'
    }
    It 'kommt ohne digest aus' {
        $info = ConvertFrom-ILoaderApiRelease ([pscustomobject]@{ tag_name = 'v2.4.0'; assets = $script:Iloader240Assets })
        $info.Sha256 | Should -BeNullOrEmpty
    }
    It 'liest latest.json als Ersatzweg' {
        $json = '{"version":"2.4.0","platforms":{"linux-x86_64":{"url":"https://x/iloader-linux-amd64.AppImage"},"windows-x86_64":{"signature":"s","url":"https://github.com/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi"}}}' | ConvertFrom-Json
        $info = ConvertFrom-ILoaderLatestJson $json
        $info.Version | Should -Be '2.4.0'
        $info.FileName | Should -Be 'iloader-windows-x64.msi'
        $info.Kind | Should -Be 'msi'
        $info.Size | Should -Be 0
    }
    It 'prüft Downloads auf Größe und Prüfsumme' {
        (Test-DownloadComplete -ActualSize 100 -ExpectedSize 100).Ok | Should -BeTrue
        (Test-DownloadComplete -ActualSize 99 -ExpectedSize 100).Ok | Should -BeFalse
        (Test-DownloadComplete -ActualSize 0 -ExpectedSize 0).Ok | Should -BeFalse
        (Test-DownloadComplete -ActualSize 5 -ExpectedSize 0).Ok | Should -BeTrue
        (Test-DownloadComplete -ActualSize 5 -ExpectedSize 5 -ActualSha256 'aa' -ExpectedSha256 'AA').Ok | Should -BeTrue
        (Test-DownloadComplete -ActualSize 5 -ExpectedSize 5 -ActualSha256 'aa' -ExpectedSha256 'bb').Ok | Should -BeFalse
    }
}

Describe 'Installiertes iloader finden' {
    It 'nimmt den Pfad aus InstallLocation' {
        $entries = @(
            [pscustomobject]@{ DisplayName = 'Other'; DisplayVersion = '1.0' },
            [pscustomobject]@{ DisplayName = 'iloader'; DisplayVersion = '2.3.1'; InstallLocation = 'C:\Program Files\iloader\' }
        )
        $found = Find-ILoaderInstall -UninstallEntries $entries -CandidatePaths @() -PathExists { param($p) $p -eq 'C:\Program Files\iloader\iloader.exe' }
        $found.Version | Should -Be '2.3.1'
        $found.ExePath | Should -Be 'C:\Program Files\iloader\iloader.exe'
        $found.Installed | Should -BeTrue
    }
    It 'nutzt DisplayIcon und Standardpfade als Ersatz' {
        $entries = @([pscustomobject]@{ DisplayName = 'iloader'; DisplayVersion = '2.4.0'; DisplayIcon = '"C:\Apps\iloader\iloader.exe",0' })
        $found = Find-ILoaderInstall -UninstallEntries $entries -CandidatePaths @('C:\x\iloader.exe') -PathExists { param($p) $p -eq 'C:\Apps\iloader\iloader.exe' }
        $found.ExePath | Should -Be 'C:\Apps\iloader\iloader.exe'
        $found2 = Find-ILoaderInstall -UninstallEntries @() -CandidatePaths @('C:\x\iloader.exe') -PathExists { param($p) $p -eq 'C:\x\iloader.exe' }
        $found2.Installed | Should -BeTrue
        $found2.Version | Should -BeNullOrEmpty
    }
    It 'gibt $null, wenn nichts da ist' {
        Find-ILoaderInstall -UninstallEntries @() -CandidatePaths @('C:\nope.exe') -PathExists { param($p) $false } | Should -BeNullOrEmpty
    }
}

Describe 'Windows-Prüfung' {
    It '<Build> <Arch> 64bit=<Is64> -> <Status>' -TestCases @(
        @{ Build = 22631; Arch = 'AMD64'; Is64 = $true; Status = 'Ok'; Win11 = $true }
        @{ Build = 19045; Arch = 'AMD64'; Is64 = $true; Status = 'Ok'; Win11 = $false }
        @{ Build = 19045; Arch = 'x86'; Is64 = $false; Status = 'Fail'; Win11 = $false }
        @{ Build = 19045; Arch = 'ARM64'; Is64 = $true; Status = 'Fail'; Win11 = $false }
        @{ Build = 26100; Arch = 'ARM64'; Is64 = $true; Status = 'Warn'; Win11 = $true }
        @{ Build = 9600; Arch = 'AMD64'; Is64 = $true; Status = 'Warn'; Win11 = $false }
        @{ Build = 7601; Arch = 'AMD64'; Is64 = $true; Status = 'Fail'; Win11 = $false }
    ) {
        $r = Get-WindowsSupport -Build $Build -NativeArchitecture $Arch -Is64BitOS $Is64
        $r.Status | Should -Be $Status
        $r.IsWindows11 | Should -Be $Win11
        $r.Message | Should -Not -BeNullOrEmpty
        if ($Status -ne 'Ok') { $r.Action | Should -Not -BeNullOrEmpty }
    }
}

Describe 'Apple-Programm installieren' {
    It 'Windows 11 mit winget: zuerst Apple-Geräte' {
        Get-AppleInstallMethods -IsWindows11 $true -WingetAvailable $true | Should -Be @('AppleDevicesStore', 'ITunesWinget', 'Manual')
    }
    It 'Windows 10 mit winget: zuerst iTunes' {
        Get-AppleInstallMethods -IsWindows11 $false -WingetAvailable $true | Should -Be @('ITunesWinget', 'AppleDevicesStore', 'Manual')
    }
    It 'ohne winget: Download-Seite' {
        @(Get-AppleInstallMethods -IsWindows11 $true -WingetAvailable $false) | Should -Be @('Manual')
    }
    It 'baut die winget-Aufrufe mit den richtigen Kennungen' {
        $store = Get-WingetArguments 'AppleDevicesStore'
        $store -join ' ' | Should -Match '--id 9NP83LWLPZ9K --exact --source msstore'
        $itunes = Get-WingetArguments 'ITunesWinget'
        $itunes -join ' ' | Should -Match '--id Apple\.iTunes --exact --source winget'
        $itunes | Should -Contain '--accept-package-agreements'
        $itunes | Should -Contain '--accept-source-agreements'
    }
    It 'deutet Rückgabewerte' {
        Get-WingetResultKind 0 | Should -Be 'Success'
        Get-WingetResultKind -1978335189 | Should -Be 'AlreadyInstalled'
        Get-WingetResultKind -1978335212 | Should -Be 'NotFound'
        Get-WingetResultKind 5 | Should -Be 'Failed'
        Get-MsiResultKind 0 | Should -Be 'Success'
        Get-MsiResultKind 3010 | Should -Be 'Success'
        Get-MsiResultKind 1602 | Should -Be 'Cancelled'
        Get-MsiResultKind 1618 | Should -Be 'Busy'
        Get-MsiResultKind 1603 | Should -Be 'Failed'
    }
}

Describe 'Ablauf' {
    It 'Ersteinrichtung enthält alle Schritte in sinnvoller Reihenfolge' {
        $plan = Get-SetupPlan -Mode First -State $null
        $plan.GetType().Name | Should -Be 'String[]'
        $plan[0] | Should -Be 'Windows'
        $plan[-1] | Should -Be 'Done'
        [array]::IndexOf($plan, 'Connect') | Should -BeLessThan ([array]::IndexOf($plan, 'ILoaderInstall'))
        [array]::IndexOf($plan, 'ILoaderInstall') | Should -BeLessThan ([array]::IndexOf($plan, 'PhoneTrust'))
        [array]::IndexOf($plan, 'SideStoreRefresh') | Should -BeLessThan ([array]::IndexOf($plan, 'AddSource'))
    }
    It 'überspringt gemerkte iPhone-Schritte' {
        $state = @{ VpnDone = $true; TrustDone = $true; DevModeDone = $true }
        $plan = Get-SetupPlan -Mode First -State $state
        $plan | Should -Not -Contain 'VpnInstall'
        $plan | Should -Not -Contain 'PhoneTrust'
        $plan | Should -Not -Contain 'DevMode'
        $plan | Should -Contain 'ILoaderInstall'
    }
    It 'Alles von vorne und neues iPhone ignorieren Gemerktes' {
        $state = @{ VpnDone = $true; TrustDone = $true; DevModeDone = $true }
        foreach ($mode in 'Full', 'NewPhone') {
            $plan = Get-SetupPlan -Mode $mode -State $state
            $plan | Should -Contain 'VpnInstall'
            $plan | Should -Contain 'PhoneTrust'
            $plan | Should -Contain 'DevMode'
        }
    }
    It 'Nur prüfen fasst das iPhone nicht an' {
        $plan = Get-SetupPlan -Mode Check -State $null
        $plan | Should -Be @('Windows', 'AppleSoftware', 'ILoader', 'CheckDone')
    }
    It 'Abgelaufen installiert SideStore neu, ohne Whoop Plus erneut hinzuzufügen' {
        $plan = Get-SetupPlan -Mode Expired -State @{ VpnDone = $true }
        $plan | Should -Contain 'ILoaderInstall'
        $plan | Should -Not -Contain 'AddSource'
        $plan | Should -Not -Contain 'VpnInstall'
        (Get-SetupPlan -Mode Expired -State $null) | Should -Contain 'VpnInstall'
    }
    It 'Verbindungsfehler ersetzt die Verbindungsdatei' {
        $plan = Get-SetupPlan -Mode Pairing -State $null
        $plan | Should -Contain 'PairingPlace'
        $plan | Should -Not -Contain 'ILoaderInstall'
    }
    It 'fügt Schritte ein, ohne doppelte' {
        $plan = @('A', 'B', 'SideStoreOpen', 'Done')
        $new = Add-PlanStepsBefore -Plan $plan -Index 2 -Steps @('PhoneTrust', 'DevMode')
        $new | Should -Be @('A', 'B', 'PhoneTrust', 'DevMode', 'SideStoreOpen', 'Done')
        $again = Add-PlanStepsBefore -Plan @('PhoneTrust', 'DevMode', 'SideStoreOpen') -Index 0 -Steps @('PhoneTrust', 'DevMode')
        $again | Should -Be @('PhoneTrust', 'DevMode', 'SideStoreOpen')
        $single = Add-PlanStepsBefore -Plan @('X') -Index 0 -Steps @('Y')
        $single | Should -Be @('Y', 'X')
        $single.GetType().Name | Should -Be 'String[]'
    }
    It 'jeder Bildschirm aller Abläufe hat Text, Bild und Knopf' {
        $data = Get-EmbeddedAssetData
        foreach ($mode in 'First', 'Full', 'NewPhone', 'Check', 'Expired', 'Pairing') {
            foreach ($id in (Get-SetupPlan -Mode $mode -State $null) + @('Welcome', 'Changed')) {
                $d = Get-ScreenDefinition -Id $id -Mode $mode
                $d.Title | Should -Not -BeNullOrEmpty -Because $id
                $d.Body | Should -Not -BeNullOrEmpty -Because $id
                $data.ContainsKey($d.Icon) | Should -BeTrue -Because "$id braucht das Bild $($d.Icon)"
                if ($d.Qr) { $data.ContainsKey($d.Qr) | Should -BeTrue -Because $id }
                ($d.Primary -or @($d.Tiles).Count -gt 0) | Should -BeTrue -Because $id
            }
        }
    }
    It 'kein Fachchinesisch in den Texten' {
        $forbidden = 'winget', 'MSI', 'Registry', 'Log', 'Repository', 'IPA', 'VID', 'Treiber', 'usbmux', 'PowerShell'
        $ids = 'Welcome', 'Changed', 'Windows', 'AppleSoftware', 'VpnInstall', 'VpnConnect', 'Connect', 'ILoader', 'ILoaderLogin',
        'ILoaderInstall', 'PhoneTrust', 'DevMode', 'SideStoreOpen', 'SideStoreRefresh', 'AddSource', 'Done', 'CheckDone',
        'PairingDelete', 'PairingSelect', 'PairingPlace', 'PairingDone'
        foreach ($id in $ids) {
            $d = Get-ScreenDefinition -Id $id -Mode 'Expired'
            $texts = @($d.Title, $d.Body, $d.QrCaption, $d.Primary) + @($d.Secondary | ForEach-Object { $_.Text }) + @($d.Links | ForEach-Object { $_.Text }) + @($d.Tiles | ForEach-Object { $_.Text })
            if ($id -ne 'AddSource') { $texts += $d.Note }   # Notiz von AddSource ist die Quell-Adresse
            foreach ($word in $forbidden) {
                ($texts -join ' ') | Should -Not -Match "\b$word\b" -Because "$id soll ohne '$word' auskommen"
            }
        }
    }
    It 'Sätze bleiben kurz (höchstens ~2 Zeilen)' {
        foreach ($id in 'VpnInstall', 'VpnConnect', 'Connect', 'ILoaderLogin', 'ILoaderInstall', 'PhoneTrust', 'DevMode', 'SideStoreOpen', 'SideStoreRefresh', 'AddSource') {
            $body = (Get-ScreenDefinition -Id $id).Body -replace '\*\*', ''
            foreach ($line in ($body -split "`n")) { $line.Length | Should -BeLessOrEqual 140 -Because "$id`: $line" }
        }
    }
    It 'unbekannte Bildschirme sind ein Fehler' {
        { Get-ScreenDefinition -Id 'Gibtsnicht' } | Should -Throw
    }
}

Describe 'Gemerkte Schritte' {
    It 'füllt Standardwerte' {
        $s = ConvertTo-SetupState $null
        $s.VpnDone | Should -BeFalse
        $s.CompletedAt | Should -BeNullOrEmpty
    }
    It 'übersteht JSON hin und zurück und ignoriert Müll' {
        $s = ConvertTo-SetupState @{ VpnDone = $true; TrustDone = 'ja'; CompletedAt = '2026-10-24T20:00:00'; Fremd = 1 }
        $s.VpnDone | Should -BeTrue
        $s.TrustDone | Should -BeFalse
        $back = ConvertTo-SetupState (([pscustomobject]$s | ConvertTo-Json) | ConvertFrom-Json)
        $back.VpnDone | Should -BeTrue
        $back.Contains('Fremd') | Should -BeFalse
    }
    It 'speichert und liest state.json' {
        $s = ConvertTo-SetupState @{ DevModeDone = $true }
        Save-SetupState $s
        (Read-SetupState).DevModeDone | Should -BeTrue
    }
    It 'schreibt den Bericht' {
        Write-SetupLog 'Pester-Test'
        Get-Content (Get-LogPath) -Raw | Should -Match 'Pester-Test'
    }
}

Describe 'Texte und Formatierung' {
    It 'zerlegt **fett**' {
        $parts = ConvertFrom-SimpleMarkup 'Tippe **Vertrauen** und dann **OK**.'
        $parts.Count | Should -Be 5
        $parts[1].Text | Should -Be 'Vertrauen'
        $parts[1].Bold | Should -BeTrue
        $parts[0].Bold | Should -BeFalse
        $bold = ConvertFrom-SimpleMarkup '**ganz fett**'
        $bold[0].Bold | Should -BeTrue
        $empty = ConvertFrom-SimpleMarkup ''
        $empty.Count | Should -Be 0
        $n = 0; foreach ($p in (ConvertFrom-SimpleMarkup 'a **b** c')) { $p.Text | Should -BeOfType [string]; $n++ }
        $n | Should -Be 3
    }
    It 'zeigt Größen auf Deutsch' {
        Format-ByteSize 8892416 | Should -Be '8,5 MB'
        Format-ByteSize 2048 | Should -Be '2 KB'
        Format-ByteSize 10 | Should -Be '10 Bytes'
    }
}

Describe 'Links und QR-Codes' {
    It 'baut den SideStore-Link zum Hinzufügen der Quelle' {
        Get-SideStoreSourceDeepLink 'https://raw.githubusercontent.com/DavThosty/Whoop-plus/sidestore/source.json' |
            Should -Be 'sidestore://source?url=https%3A%2F%2Fraw.githubusercontent.com%2FDavThosty%2FWhoop-plus%2Fsidestore%2Fsource.json'
    }
    It 'Adressen im Bild-Generator passen zu den Einstellungen im Skript' {
        $generator = Get-Content (Join-Path $PSScriptRoot '../assets/render-assets.cjs') -Raw
        $generator | Should -Match ([regex]::Escape("LOCALDEVVPN_URL = '$($script:Config.LocalDevVpnUrl)'"))
        $generator | Should -Match ([regex]::Escape("SOURCE_URL = '$($script:Config.SourceUrl)'"))
    }
    It 'alle eingebetteten Bilder sind PNGs' {
        $data = Get-EmbeddedAssetData
        $data.Count | Should -BeGreaterThan 10
        foreach ($key in $data.Keys) {
            $bytes = [System.Convert]::FromBase64String($data[$key])
            $bytes[0..3] | Should -Be @(0x89, 0x50, 0x4E, 0x47) -Because $key
        }
    }
}

Describe 'iPhone-Erkennung' {
    It 'erkennt Apple-Geräte-Kennungen' {
        Test-IsAppleMobileDeviceId 'USB\VID_05AC&PID_12A8\00008110000A1B2C3D4E5F6A' | Should -BeTrue
        Test-IsAppleMobileDeviceId 'USB\VID_05AC&PID_12A8&MI_00\7&2B3C&0&0000' | Should -BeTrue
        Test-IsAppleMobileDeviceId 'USB\VID_05AC&PID_024F\5&1' | Should -BeFalse   # Apple-Tastatur
        Test-IsAppleMobileDeviceId 'USB\VID_046D&PID_1234\1' | Should -BeFalse
        Test-IsAppleMobileDeviceId $null | Should -BeFalse
    }
    It 'baut ein gültiges usbmuxd-Paket' {
        $xml = New-UsbmuxListDevicesPlist
        $packet = New-UsbmuxPlistPacket -PlistXml $xml -Tag 7
        $header = ConvertFrom-UsbmuxHeader $packet
        $header.Length | Should -Be $packet.Length
        $header.Version | Should -Be 1
        $header.Message | Should -Be 8
        $header.Tag | Should -Be 7
        [System.Text.Encoding]::UTF8.GetString($packet, 16, $packet.Length - 16) | Should -Match '<string>ListDevices</string>'
        $packet[0..3] | Should -Be ([System.BitConverter]::GetBytes([uint32]$packet.Length))
    }
    It 'liest die Geräteliste aus der Antwort' {
        $answer = @'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>DeviceList</key>
  <array>
    <dict>
      <key>DeviceID</key><integer>3</integer>
      <key>MessageType</key><string>Attached</string>
      <key>Properties</key>
      <dict>
        <key>ConnectionSpeed</key><integer>480000000</integer>
        <key>ConnectionType</key><string>USB</string>
        <key>DeviceID</key><integer>3</integer>
        <key>LocationID</key><integer>0</integer>
        <key>ProductID</key><integer>4776</integer>
        <key>SerialNumber</key><string>00008110-000A1B2C3D4E5F6A</string>
        <key>Remote</key><false/>
      </dict>
    </dict>
    <dict>
      <key>DeviceID</key><integer>9</integer>
      <key>Properties</key>
      <dict>
        <key>ConnectionType</key><string>Network</string>
        <key>SerialNumber</key><string>WLAN-GERAET</string>
        <key>EscapedFullServiceName</key><data>YWJj</data>
      </dict>
    </dict>
  </array>
</dict>
</plist>
'@
        $plist = ConvertFrom-PlistXml $answer
        $devices = Get-UsbmuxDeviceList -Plist $plist
        @($devices).Count | Should -Be 2
        $devices[0].ConnectionType | Should -Be 'USB'
        $devices[0].Udid | Should -Be '00008110-000A1B2C3D4E5F6A'
        $devices[0].DeviceId | Should -Be 3
        $devices[1].ConnectionType | Should -Be 'Network'
    }
    It 'kommt mit leerer Liste zurecht' {
        $plist = ConvertFrom-PlistXml '<?xml version="1.0"?><plist version="1.0"><dict><key>DeviceList</key><array/></dict></plist>'
        @(Get-UsbmuxDeviceList -Plist $plist).Count | Should -Be 0
    }
}

Describe 'Hilfsfunktionen' {
    It 'Get-PropValue liest Hashtables und Objekte, fehlend = $null' {
        Get-PropValue @{ a = 1 } 'a' | Should -Be 1
        Get-PropValue ([pscustomobject]@{ a = 2 }) 'a' | Should -Be 2
        Get-PropValue ([pscustomobject]@{ a = 2 }) 'b' | Should -BeNullOrEmpty
        Get-PropValue $null 'a' | Should -BeNullOrEmpty
    }
    It 'erkennt eine abgelehnte Windows-Abfrage' {
        $inner = New-Object System.ComponentModel.Win32Exception -ArgumentList 1223
        $outer = New-Object System.InvalidOperationException -ArgumentList 'x', $inner
        Test-IsUserCancelled $outer | Should -BeTrue
        Test-IsUserCancelled (New-Object System.Exception 'y') | Should -BeFalse
    }
}
