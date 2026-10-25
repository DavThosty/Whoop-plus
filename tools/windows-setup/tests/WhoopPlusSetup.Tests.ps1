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
        $info.SignatureBase64 | Should -Be 's'
    }
    It 'installiert nur geprüfte Downloads: <Name>' -TestCases @(
        @{ Name = 'Größe laut GitHub passt'; Size = 100; Expected = 100; Sha = $null; ExpSha = $null; Sig = 'Unavailable'; Kind = 'Verified' }
        @{ Name = 'Größe falsch'; Size = 99; Expected = 100; Sha = $null; ExpSha = $null; Sig = 'Unavailable'; Kind = 'Corrupt' }
        @{ Name = 'leer'; Size = 0; Expected = 0; Sha = $null; ExpSha = $null; Sig = 'Valid'; Kind = 'Corrupt' }
        @{ Name = 'nichts bekannt (latest.json ohne Signatur)'; Size = 5; Expected = 0; Sha = $null; ExpSha = $null; Sig = 'Unavailable'; Kind = 'Unverifiable' }
        @{ Name = 'nur Signatur (latest.json)'; Size = 5; Expected = 0; Sha = $null; ExpSha = $null; Sig = 'Valid'; Kind = 'Verified' }
        @{ Name = 'Signatur ungültig trotz passender Größe'; Size = 5; Expected = 5; Sha = $null; ExpSha = $null; Sig = 'Invalid'; Kind = 'Corrupt' }
        @{ Name = 'SHA-256 passt (Groß/klein egal)'; Size = 5; Expected = 5; Sha = 'aa'; ExpSha = 'AA'; Sig = 'Unavailable'; Kind = 'Verified' }
        @{ Name = 'SHA-256 falsch'; Size = 5; Expected = 5; Sha = 'aa'; ExpSha = 'bb'; Sig = 'Valid'; Kind = 'Corrupt' }
        @{ Name = 'SHA-256 erwartet, aber nicht berechnet'; Size = 5; Expected = 5; Sha = $null; ExpSha = 'bb'; Sig = 'Unavailable'; Kind = 'Corrupt' }
    ) {
        $v = Get-DownloadVerdict -ActualSize $Size -ExpectedSize $Expected -ActualSha256 $Sha -ExpectedSha256 $ExpSha -Signature $Sig
        $v.Kind | Should -Be $Kind
        $v.Ok | Should -Be ($Kind -eq 'Verified')
        $v.Reason | Should -Not -BeNullOrEmpty
    }
    It 'lädt nur von den iloader-Releases: <Url> = <Ok>' -TestCases @(
        @{ Url = 'https://github.com/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi'; Ok = $true }
        @{ Url = 'https://github.com/nab138/iloader/releases/download/v2.4.0/iloader_2.5.0_x64_en-US.exe'; Ok = $true }
        @{ Url = 'http://github.com/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi'; Ok = $false }
        @{ Url = 'https://github.com/evil/iloader/releases/download/v2.4.0/iloader-windows-x64.msi'; Ok = $false }
        @{ Url = 'https://github.com.evil.example/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi'; Ok = $false }
        @{ Url = 'https://github.com/nab138/iloader/releases/download/v2.4.0/../../x/iloader.msi'; Ok = $false }
        @{ Url = 'https://github.com/nab138/iloader/releases/download/v2.4.0/iloader windows.msi'; Ok = $false }
        @{ Url = 'https://github.com/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi?x=1'; Ok = $false }
        @{ Url = 'https://github.com/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.bat'; Ok = $false }
        @{ Url = 'https://github.com/NAB138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi'; Ok = $false }
    ) {
        Test-ILoaderDownloadUrl $Url | Should -Be $Ok
    }
    It 'prüft auch die Adresse der Signatur' {
        Test-ILoaderDownloadUrl 'https://github.com/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi.sig' -Signature | Should -BeTrue
        Test-ILoaderDownloadUrl 'https://github.com/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi.sig' | Should -BeFalse
        Test-ILoaderDownloadUrl 'https://example.com/iloader-windows-x64.msi.sig' -Signature | Should -BeFalse
    }
    It 'baut sichere Dateinamen' {
        Get-SafeFileName 'https://github.com/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi' | Should -Be 'iloader-windows-x64.msi'
        # Je nach .NET wird %2E%2E%5C anders normalisiert – entscheidend: nie Pfadteile im Namen.
        $tricky = Get-SafeFileName 'https://x/a/%2E%2E%5Cevil.msi'
        if ($tricky) { $tricky | Should -Not -Match '[\\/]|\.\.' }
        Get-SafeFileName 'https://x/a/b%20c.msi' | Should -BeNullOrEmpty
        Get-SafeFileName 'https://x/a/.hidden.msi' | Should -BeNullOrEmpty
        Get-SafeFileName 'kein link' | Should -BeNullOrEmpty
        Get-SafeFileName '' | Should -BeNullOrEmpty
    }
    It 'verwirft Releases mit fremden Adressen' {
        $evil = [pscustomobject]@{ name = 'iloader-windows-x64.msi'; size = 1; browser_download_url = 'https://evil.example/iloader-windows-x64.msi' }
        ConvertFrom-ILoaderApiRelease ([pscustomobject]@{ tag_name = 'v9.9.9'; assets = @($evil) }) | Should -BeNullOrEmpty
        $json = '{"version":"9.9.9","platforms":{"windows-x86_64":{"signature":"abc","url":"https://evil.example/iloader-windows-x64.msi"}}}' | ConvertFrom-Json
        ConvertFrom-ILoaderLatestJson $json | Should -BeNullOrEmpty
    }
    It 'findet die .sig-Datei der Release' {
        $info = ConvertFrom-ILoaderApiRelease ([pscustomobject]@{ tag_name = 'v2.4.0'; assets = $script:Iloader240Assets })
        $info.SignatureUrl | Should -Be 'https://github.com/nab138/iloader/releases/download/v2.4.0/iloader-windows-x64.msi.sig'
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
    It 'nur iTunes von Apple: mit winget <Expected>' -TestCases @(
        @{ Winget = $true; Expected = @('ITunesWinget', 'ITunesDirect', 'Manual') }
        @{ Winget = $false; Expected = @('ITunesDirect', 'Manual') }
    ) {
        $methods = @(Get-AppleInstallMethods -WingetAvailable $Winget)
        $methods | Should -Be $Expected
        $methods | Should -Not -Contain 'AppleDevicesStore'
    }
    It 'baut den winget-Aufruf für iTunes (Reparatur mit --force)' {
        $normal = Get-WingetArguments
        $normal -join ' ' | Should -Match '--id Apple\.iTunes --exact --source winget'
        $normal | Should -Contain '--accept-package-agreements'
        $normal | Should -Not -Contain '--force'
        Get-WingetArguments -Force | Should -Contain '--force'
        (Get-WingetArguments) -join ' ' | Should -Not -Match 'msstore|9NP83LWLPZ9K'
    }
    It 'nach Erfolg nie einen weiteren Weg: <Kind> -> <Step>' -TestCases @(
        @{ Kind = 'Success'; Step = 'Verify' }
        @{ Kind = 'AlreadyInstalled'; Step = 'Verify' }
        @{ Kind = 'HashMismatch'; Step = 'Problem' }
        @{ Kind = 'NotFound'; Step = 'Next' }
        @{ Kind = 'Failed'; Step = 'Next' }
        @{ Kind = 'SuccessRebootRequired'; Step = 'VerifyReboot' }
        @{ Kind = 'Cancelled'; Step = 'Stop' }
    ) {
        Get-NextInstallStep $Kind | Should -Be $Step
    }
    It 'Reparatur: „schon installiert“ zählt nicht als erledigt' {
        Get-NextInstallStep 'AlreadyInstalled' -Repair | Should -Be 'Next'
        Get-NextInstallStep 'Success' -Repair | Should -Be 'Verify'
    }
    It 'nach der Reparatur: <Before> -> <After>, Fehlversuche <Failed> = <Outcome>' -TestCases @(
        @{ Before = 'Broken'; After = 'Ok'; Failed = 0; Outcome = 'RebootOffer' }
        @{ Before = 'Broken'; After = 'ServiceStopped'; Failed = 1; Outcome = 'RebootOffer' }
        @{ Before = 'Broken'; After = 'Broken'; Failed = 1; Outcome = 'Retry' }
        @{ Before = 'Broken'; After = 'Broken'; Failed = 2; Outcome = 'Manual' }
    ) {
        Get-RepairOutcome -StatusBefore $Before -StatusAfter $After -FailedAttempts $Failed | Should -Be $Outcome
    }
    It 'pnputil-Rückgabewerte' {
        foreach ($ok in '0', '3010', '259') { Test-PnputilSuccess $ok | Should -BeTrue }
        foreach ($bad in '1', '5', 'Failed', 'Unknown', '') { Test-PnputilSuccess $bad | Should -BeFalse }
    }
    It 'deutet Rückgabewerte' {
        Get-WingetResultKind 0 | Should -Be 'Success'
        Get-WingetResultKind -1978335189 | Should -Be 'AlreadyInstalled'
        Get-WingetResultKind -1978335212 | Should -Be 'NotFound'
        Get-WingetResultKind 5 | Should -Be 'Failed'
        Get-WingetResultKind -1978335215 | Should -Be 'HashMismatch'   # 0x8A150011 INSTALLER_HASH_MISMATCH
        Get-WingetResultKind ([int]0x8A150109) | Should -Be 'SuccessRebootRequired'
        Get-WingetResultKind ([int]0x8A15010A) | Should -Be 'SuccessRebootRequired'
        Get-WingetResultKind ([int]0x8A15010C) | Should -Be 'Cancelled'
        Get-WingetResultKind ([int]0x8A15010D) | Should -Be 'AlreadyInstalled'
        Get-WingetResultKind 1602 | Should -Be 'Cancelled'
        Get-WingetResultKind 1223 | Should -Be 'Cancelled'
        Get-WingetResultKind ([int]0x8A150011) | Should -Be 'HashMismatch'
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
    It 'iPhone wird nicht erkannt: Apple-Programm und Verbindung prüfen' {
        $plan = Get-SetupPlan -Mode Diagnose -State $null
        $plan | Should -Be @('Windows', 'AppleSoftware', 'Connect', 'ConnectDone')
        (Get-ScreenDefinition 'Changed').Tiles.Action | Should -Contain 'Mode:Diagnose'
        (Get-ScreenDefinition 'Welcome').Links.Action | Should -Contain 'Mode:Diagnose'
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
        foreach ($mode in 'First', 'Full', 'NewPhone', 'Check', 'Expired', 'Pairing', 'Diagnose') {
            foreach ($id in (Get-SetupPlan -Mode $mode -State $null) + @('Welcome', 'Changed', 'AppleConflict', 'ConnectUnresolved', 'AppleManualRepair', 'SignIn80045')) {
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
        'PairingDelete', 'PairingSelect', 'PairingPlace', 'PairingDone', 'AppleConflict', 'ConnectDone', 'ConnectUnresolved',
        'AppleManualRepair', 'SignIn80045'
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
        foreach ($id in 'VpnInstall', 'VpnConnect', 'Connect', 'ILoaderLogin', 'ILoaderInstall', 'PhoneTrust', 'DevMode', 'SideStoreOpen', 'SideStoreRefresh', 'AddSource', 'SignIn80045', 'AppleManualRepair', 'AppleConflict') {
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
    It 'merkt sich den Schritt für nach dem Neustart' {
        $s = ConvertTo-SetupState @{ ResumeStep = 'Connect'; ResumeMode = 'First' }
        $back = ConvertTo-SetupState (([pscustomobject]$s | ConvertTo-Json) | ConvertFrom-Json)
        $back.ResumeStep | Should -Be 'Connect'
        $back.ResumeMode | Should -Be 'First'
        (ConvertTo-SetupState @{ RepairAttempts = 2 }).RepairAttempts | Should -Be 2
        (ConvertTo-SetupState @{ RepairAttempts = 'x' }).RepairAttempts | Should -Be 0
        Get-ResumeIndex -Plan @('Windows', 'AppleSoftware', 'Connect') -Step 'Connect' | Should -Be 2
        Get-ResumeIndex -Plan @('Windows', 'AppleSoftware') -Step 'Gibtsnicht' | Should -Be 0
        Get-ResumeIndex -Plan @('Windows') -Step $null | Should -Be 0
    }
    It 'Autostart nach dem Neustart (RunOnce)' {
        New-RunOnceCommand -ExePath 'C:\Users\a b\Downloads\WhoopPlus-Setup.exe' | Should -Be '"C:\Users\a b\Downloads\WhoopPlus-Setup.exe"'
        New-RunOnceCommand -ScriptPath 'C:\x\WhoopPlusSetup.ps1' | Should -Match '^powershell\.exe .*-File "C:\\x\\WhoopPlusSetup\.ps1"$'
        { New-RunOnceCommand -ExePath 'C:\x" & calc "' } | Should -Throw
        New-RunOnceCommand | Should -BeNullOrEmpty
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
    It 'Hilfe-Links zeigen auf die Anleitung (docs/ANLEITUNG.md) mit gültigem Abschnitt' {
        $script:Config.RefreshHelpUrl | Should -Match '/docs/ANLEITUNG\.md#4-nie-mehr-dran-denken-automatisch-verl%C3%A4ngern$'
        $guide = Join-Path $PSScriptRoot '../../../docs/ANLEITUNG.md'
        if (Test-Path $guide) {
            # GitHub-Anker: Kleinbuchstaben, Satzzeichen weg, Leerzeichen -> Bindestrich
            $anchors = foreach ($h in (Get-Content $guide -Encoding UTF8 | Where-Object { $_ -match '^#{1,6} ' })) {
                (($h -replace '^#+\s+', '').ToLowerInvariant() -replace '[^\p{L}\p{Nd} -]', '') -replace ' ', '-'
            }
            $anchor = [System.Uri]::UnescapeDataString(($script:Config.RefreshHelpUrl -split '#')[1])
            $anchors | Should -Contain $anchor
        }
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

Describe 'Apple-Programm: Bewertung' {
    BeforeAll {
        $script:App = { param($kind) [pscustomobject]@{ Name = "AppleInc.$kind"; Version = '1.0'; Kind = $kind } }
        $script:Facts = {
            param([string]$ITunes, [string]$Amds, [bool]$Service, [string]$Status, [object[]]$Store, [bool]$Usbmux = ($Status -eq 'Running'))
            [pscustomobject]@{ UsbmuxReachable = $Usbmux; ITunesVersion = $ITunes; AmdsVersion = $Amds; ServiceExists = $Service; ServiceName = $(if ($Service) { 'Apple Mobile Device Service' } else { $null })
                ServiceStatus = $Status; ServiceStartType = 'Automatic'; StoreApps = @($Store) }
        }
    }
    It 'erkennt Store-Apps' {
        Get-AppleStoreAppKind 'AppleInc.AppleDevices' | Should -Be 'AppleDevices'
        Get-AppleStoreAppKind 'AppleInc.AppleMusicWin' | Should -Be 'AppleMusic'
        Get-AppleStoreAppKind 'AppleInc.AppleTVWin' | Should -Be 'AppleTV'
        Get-AppleStoreAppKind 'AppleInc.iTunes' | Should -Be 'iTunesStore'
        Get-AppleStoreAppKind 'AppleInc.iCloud' | Should -Be 'Other'
        Get-AppleStoreAppLabel 'AppleDevices' | Should -Be 'Apple-Geräte'
    }
    It 'nichts installiert -> Missing' {
        (Get-AppleSoftwareDiagnosis (& $script:Facts '' '' $false '' @())).Status | Should -Be 'Missing'
    }
    It 'iTunes mit laufendem Dienst -> Ok' {
        (Get-AppleSoftwareDiagnosis (& $script:Facts '12.13.11.1' '19.0' $true 'Running' @())).Status | Should -Be 'Ok'
    }
    It 'Dienst gestoppt -> ServiceStopped' {
        (Get-AppleSoftwareDiagnosis (& $script:Facts '12.13.11.1' '19.0' $true 'Stopped' @())).Status | Should -Be 'ServiceStopped'
    }
    It 'iTunes da, Apple Mobile Device Support/Dienst weg (nach Entfernen von Apple-Geräte) -> Broken' {
        (Get-AppleSoftwareDiagnosis (& $script:Facts '12.13.11.1' '' $false '' @())).Status | Should -Be 'Broken'
        (Get-AppleSoftwareDiagnosis (& $script:Facts '' '19.0' $false '' @())).Status | Should -Be 'Broken'
    }
    It '„Apple-Geräte“ stört nur, wenn Dienst oder usbmuxd nicht gehen' {
        $dev = & $script:App 'AppleDevices'
        $d = Get-AppleSoftwareDiagnosis (& $script:Facts '12.13.11.1' '' $false '' @($dev) $false)
        $d.Status | Should -Be 'Conflict'
        $d.Conflicts[0].Kind | Should -Be 'AppleDevices'
        (Get-AppleSoftwareDiagnosis (& $script:Facts '12.13.11.1' '19.0' $true 'Stopped' @($dev) $false)).Status | Should -Be 'Conflict'
        (Get-AppleSoftwareDiagnosis (& $script:Facts '12.13.11.1' '19.0' $true 'Running' @($dev) $false)).Status | Should -Be 'Conflict'
        # Dienst läuft und usbmuxd antwortet: kein Grund, etwas zu entfernen.
        (Get-AppleSoftwareDiagnosis (& $script:Facts '12.13.11.1' '19.0' $true 'Running' @($dev) $true)).Status | Should -Be 'Ok'
    }
    It 'Apple Music und Apple TV sind kein Konflikt: <Kind>' -TestCases @(@{ Kind = 'AppleMusic' }, @{ Kind = 'AppleTV' }) {
        (Get-AppleSoftwareDiagnosis (& $script:Facts '12.13.11.1' '19.0' $true 'Running' @((& $script:App $Kind)))).Status | Should -Be 'Ok'
        (Get-AppleSoftwareDiagnosis (& $script:Facts '12.13.11.1' '' $false '' @((& $script:App $Kind)))).Status | Should -Be 'Broken'
    }
    It 'nur „Apple-Geräte“ ohne iTunes und ohne Dienst -> Conflict' {
        (Get-AppleSoftwareDiagnosis (& $script:Facts '' '' $false '' @((& $script:App 'AppleDevices')))).Status | Should -Be 'Conflict'
    }
    It 'iTunes aus dem Store allein -> Ok' {
        (Get-AppleSoftwareDiagnosis (& $script:Facts '' '' $false '' @((& $script:App 'iTunesStore')))).Status | Should -Be 'Ok'
    }
    It 'prüft Apples Signatur und Download-Adresse' {
        Test-AppleAuthenticode -Status 'Valid' -Subject 'CN=Apple Inc., O=Apple Inc., L=Cupertino, S=California, C=US' | Should -BeTrue
        Test-AppleAuthenticode -Status 'NotSigned' -Subject 'CN=Apple Inc., O=Apple Inc.' | Should -BeFalse
        Test-AppleAuthenticode -Status 'Valid' -Subject 'CN=Apple Inc. Fake Ltd, O=Evil' | Should -BeFalse
        Test-AppleDownloadUrl 'https://secure-appldnld.apple.com/itunes12/140-75773/iTunes64Setup.exe' | Should -BeTrue
        Test-AppleDownloadUrl 'https://apple.com.evil.example/iTunes64Setup.exe' | Should -BeFalse
        Test-AppleDownloadUrl 'http://secure-appldnld.apple.com/iTunes64Setup.exe' | Should -BeFalse
    }
    It 'Dienst-Befehl nur mit harmlosem Namen' {
        New-ServiceStartArguments 'Apple Mobile Device Service' | Should -Be '/c sc.exe config "Apple Mobile Device Service" start= auto & sc.exe start "Apple Mobile Device Service"'
        { New-ServiceStartArguments 'x" & calc & "' } | Should -Throw
    }
}

Describe 'Apple-Programm: Ablauf (System gemockt)' {
    BeforeAll {
        foreach ($f in 'Set-Status', 'Set-Busy', 'Set-PrimaryButton', 'Set-SecondaryButtons', 'Set-ActivityProgress') {
            if (-not (Get-Command $f -ErrorAction SilentlyContinue)) { throw "$f fehlt" }
        }
    }
    It 'winget-Erfolg: kein zweiter Weg' {
        Mock Find-Winget { 'C:\winget.exe' }
        Mock Set-Status { }
        Mock Invoke-ITunesWinget { 'Success' }
        Mock Install-ITunesDirect { 'Success' }
        Invoke-ITunesInstall | Should -Be 'Success'
        Should -Invoke Invoke-ITunesWinget -Times 1 -Exactly
        Should -Invoke Install-ITunesDirect -Times 0 -Exactly
    }
    It 'winget schlägt fehl -> Apples Installationsprogramm direkt' {
        Mock Find-Winget { 'C:\winget.exe' }
        Mock Set-Status { }
        Mock Invoke-ITunesWinget { 'Failed' }
        Mock Install-ITunesDirect { 'Success' }
        Invoke-ITunesInstall | Should -Be 'Success'
        Should -Invoke Install-ITunesDirect -Times 1 -Exactly
    }
    It 'beschädigter Download -> abbrechen, kein anderer Weg' {
        Mock Find-Winget { 'C:\winget.exe' }
        Mock Set-Status { }
        Mock Invoke-ITunesWinget { 'HashMismatch' }
        Mock Install-ITunesDirect { 'Success' }
        Invoke-ITunesInstall | Should -Be 'HashMismatch'
        Should -Invoke Install-ITunesDirect -Times 0 -Exactly
    }
    It 'ohne winget direkt von Apple; Reparatur übergibt --force' {
        Mock Find-Winget { $null }
        Mock Set-Status { }
        Mock Invoke-ITunesWinget { 'Success' }
        Mock Install-ITunesDirect { 'Failed' }
        Invoke-ITunesInstall | Should -Be 'Failed'
        Should -Invoke Invoke-ITunesWinget -Times 0 -Exactly
        Mock Find-Winget { 'C:\winget.exe' }
        Invoke-ITunesInstall -Repair | Should -Be 'Success'
        Should -Invoke Invoke-ITunesWinget -Times 1 -Exactly -ParameterFilter { $Repair }
    }
    It 'Reparatur: winget sagt „schon installiert“ -> Apples Installationsprogramm direkt' {
        Mock Find-Winget { 'C:\winget.exe' }
        Mock Set-Status { }
        Mock Invoke-ITunesWinget { 'AlreadyInstalled' }
        Mock Install-ITunesDirect { 'Success' }
        Invoke-ITunesInstall -Repair | Should -Be 'Success'
        Should -Invoke Install-ITunesDirect -Times 1 -Exactly
    }
    It 'abgebrochen (Windows-Abfrage „Nein“) -> kein zweiter Versuch' {
        Mock Find-Winget { 'C:\winget.exe' }
        Mock Set-Status { }
        Mock Invoke-ITunesWinget { 'Cancelled' }
        Mock Install-ITunesDirect { 'Success' }
        Invoke-ITunesInstall | Should -Be 'Cancelled'
        Should -Invoke Install-ITunesDirect -Times 0 -Exactly
    }
    It 'winget: Neustart nötig -> Erfolg mit Neustart' {
        Mock Find-Winget { 'C:\winget.exe' }
        Mock Set-Status { }
        Mock Invoke-ITunesWinget { 'SuccessRebootRequired' }
        Mock Install-ITunesDirect { 'Success' }
        Invoke-ITunesInstall | Should -Be 'SuccessReboot'
        Should -Invoke Install-ITunesDirect -Times 0 -Exactly
    }
    It 'Reparatur hilft -> Neustart anbieten, Zähler bleibt' {
        $script:State = ConvertTo-SetupState $null
        Mock Set-Busy { }
        Mock Set-Status { }
        Mock Save-SetupState { }
        Mock Invoke-Check { [pscustomobject]@{ Status = 'Broken' } }
        Mock Invoke-ITunesInstall { 'Success' }
        Mock Wait-AppleReady { [pscustomobject]@{ Status = 'Ok' } }
        Mock Show-RebootOffer { }
        Repair-AppleSoftwareUi
        Should -Invoke Show-RebootOffer -Times 1 -Exactly
        $script:State.RepairAttempts | Should -Be 0
    }
    It 'Reparatur ändert nichts: erst nochmal versuchen, beim 2. Mal Schritte von Hand' {
        $script:State = ConvertTo-SetupState $null
        $script:Plan = [string[]]@('Windows', 'AppleSoftware', 'Connect'); $script:Index = 1
        Mock Set-Busy { }
        Mock Set-Status { }
        Mock Set-PrimaryButton { }
        Mock Save-SetupState { }
        Mock Show-Problem { }
        Mock Move-Next { }
        Mock Show-RebootOffer { }
        Mock Invoke-Check { [pscustomobject]@{ Status = 'Broken' } }
        Mock Invoke-ITunesInstall { 'Success' }
        Mock Wait-AppleReady { [pscustomobject]@{ Status = 'Broken' } }
        Repair-AppleSoftwareUi
        $script:State.RepairAttempts | Should -Be 1
        Should -Invoke Show-Problem -Times 1 -Exactly
        Repair-AppleSoftwareUi
        $script:State.RepairAttempts | Should -Be 2
        $script:Plan | Should -Contain 'AppleManualRepair'
        Should -Invoke Move-Next -Times 1 -Exactly
        Should -Invoke Show-RebootOffer -Times 0 -Exactly
    }
    It '„Trotzdem weiter“ im Modus „nicht erkannt“ meldet nicht „gefunden“' {
        $script:Mode = 'Diagnose'
        $script:Plan = [string[]]@('Windows', 'AppleSoftware', 'Connect', 'ConnectDone'); $script:Index = 2
        Mock Move-Next { }
        Invoke-UiAction 'SkipConnect'
        $script:Plan[3] | Should -Be 'ConnectUnresolved'
        Should -Invoke Move-Next -Times 1 -Exactly
    }
    It 'Fehler -80045: Hilfe-Bildschirm vor der Anmeldung einfügen' {
        $script:Mode = 'First'
        $script:Plan = [string[]]@('SideStoreOpen', 'SideStoreRefresh'); $script:Index = 0
        Mock Enter-Screen { }
        Invoke-UiAction 'SignInHelp'
        $script:Plan | Should -Be @('SignIn80045', 'SideStoreOpen', 'SideStoreRefresh')
        Should -Invoke Enter-Screen -Times 1 -Exactly -ParameterFilter { $Index -eq 0 }
        (Get-ScreenDefinition 'SideStoreOpen').Secondary.Action | Should -Contain 'SignInHelp'
        $d = Get-ScreenDefinition 'SignIn80045'
        $d.Body | Should -Match 'On-Device Anisette'
        $d.Body | Should -Match 'SideStore \(New\)'
        $d.Body | Should -Match 'Enable auto rotation'
        $d.Body | Should -Match 'Save as overrides'
        $d.Body | Should -Match 'Reset adi\.pb'
        $d.Links.Action | Should -Contain 'OpenUrl:https://github.com/SideStore/SideStore/issues/1675'
        $d.Links.Action | Should -Contain 'OpenUrl:https://github.com/nab138/iloader/issues/965'
    }
    It 'nur ein Helfer gleichzeitig (Mutex)' {
        $name = 'Local\WhoopPlusSetupTest-' + [guid]::NewGuid()
        $first = Enter-SingleInstance -Name $name
        $first | Should -Not -BeNullOrEmpty
        $second = Invoke-InBackground -ScriptBlock { param($n) $m = New-Object System.Threading.Mutex -ArgumentList $false, $n; $got = $m.WaitOne(0); if ($got) { $m.ReleaseMutex() }; $m.Dispose(); $got } -ArgumentList @($name) -ForceRunspace
        $second | Should -BeFalse
        $first.ReleaseMutex(); $first.Dispose()
    }
    It 'nach der Installation: Erfolg -> Abschluss, kein Handbuch-Weg' {
        Mock Set-Busy { }
        Mock Invoke-ITunesInstall { 'Success' }
        Mock Complete-AppleInstall { }
        Mock Show-AppleManualInstall { }
        Install-AppleSoftwareUi
        Should -Invoke Complete-AppleInstall -Times 1 -Exactly
        Should -Invoke Show-AppleManualInstall -Times 0 -Exactly
    }
    It 'Dienst nach 60 s noch nicht da -> Neustart anbieten' {
        Mock Set-Status { }
        Mock Set-Busy { }
        Mock Set-SecondaryButtons { }
        Mock Set-PrimaryButton { }
        Mock Wait-AppleReady { [pscustomobject]@{ Status = 'Broken'; Source = 'iTunes'; Facts = [pscustomobject]@{ ServiceExists = $false; ServiceStatus = '' } } }
        Complete-AppleInstall
        Should -Invoke Set-PrimaryButton -ParameterFilter { $Action -eq 'Restart' } -Times 1 -Exactly
        $script:FreshAppleInstall | Should -BeTrue
        $script:FreshAppleInstall = $false
    }
    It 'Store-Apps entfernt -> iTunes automatisch reparieren' {
        $script:AppleConflicts = @([pscustomobject]@{ Name = 'AppleInc.AppleDevices'; Version = '1'; Kind = 'AppleDevices' })
        Mock Confirm-Action { $true }
        Mock Set-Busy { }
        Mock Set-Status { }
        Mock Invoke-InBackground { 'ok' }
        Mock Invoke-Check { [pscustomobject]@{ Status = 'Broken'; Source = 'iTunes' } }
        Mock Repair-AppleSoftwareUi { }
        Remove-AppleConflictsUi
        Should -Invoke Invoke-InBackground -Times 1 -Exactly
        Should -Invoke Repair-AppleSoftwareUi -Times 1 -Exactly
        @($script:AppleConflicts).Count | Should -Be 0
    }
    It 'ohne Zustimmung wird nichts entfernt' {
        $script:AppleConflicts = @([pscustomobject]@{ Name = 'AppleInc.AppleDevices'; Version = '1'; Kind = 'AppleDevices' })
        Mock Confirm-Action { $false }
        Mock Invoke-InBackground { 'ok' }
        Mock Repair-AppleSoftwareUi { }
        Remove-AppleConflictsUi
        Should -Invoke Invoke-InBackground -Times 0 -Exactly
        Should -Invoke Repair-AppleSoftwareUi -Times 0 -Exactly
        $script:AppleConflicts = @()
    }
}

Describe 'iPhone-Verbindung: Fehlersuche' {
    BeforeAll {
        $script:Apple = { param($status, [bool]$exists, [string]$svc) [pscustomobject]@{ Status = $status; Facts = [pscustomobject]@{ ServiceExists = $exists; ServiceStatus = $svc } } }
        $script:Dev = { param($inf, $provider, [int]$problem) [pscustomobject]@{ DeviceId = 'USB\VID_05AC&PID_12A8\00008110000A1B2C3D4E5F6A'; Status = 'OK'; ProblemCode = $problem; DriverProvider = $provider; InfName = $inf; DriverVersion = '1.0' } }
        $script:Conn = {
            param([bool]$reachable, [int]$count, [object[]]$pnp, $apple)
            [pscustomobject]@{ UsbmuxReachable = $reachable; UsbmuxDeviceCount = $count; PnpDevices = @($pnp); Apple = $apple; DriverInfPresent = $true }
        }
        $script:OkApple = & $script:Apple 'Ok' $true 'Running'
        $script:AppleDrv = & $script:Dev 'oem42.inf' 'Apple, Inc.' 0
    }
    It 'nur der Apple-Gerätedienst zählt als Erfolg' {
        (Get-ConnectDiagnosis (& $script:Conn $true 1 @() $script:OkApple)).Kind | Should -Be 'Ok'
    }
    It 'Apple-Programm kaputt/fehlt/Konflikt -> Apple-Programm reparieren' {
        foreach ($st in 'Broken', 'Missing', 'Conflict') {
            $d = Get-ConnectDiagnosis (& $script:Conn $false 0 @($script:AppleDrv) (& $script:Apple $st $false ''))
            $d.Kind | Should -Be 'AppleSoftware'
            $d.ButtonAction | Should -Be 'FixApple'
        }
    }
    It 'kein iPhone am USB -> Kabel-Tipp' {
        (Get-ConnectDiagnosis (& $script:Conn $true 0 @() $script:OkApple)).Kind | Should -Be 'NoDevice'
    }
    It 'frisch installiert und iPhone nur von Windows gesehen -> Neustart anbieten' {
        $d = Get-ConnectDiagnosis (& $script:Conn $true 0 @($script:AppleDrv) $script:OkApple) -FreshInstall
        $d.Kind | Should -Be 'NeedsRestart'
        $d.ButtonAction | Should -Be 'Restart'
    }
    It 'Dienst gestoppt -> Dienst starten' {
        $d = Get-ConnectDiagnosis (& $script:Conn $false 0 @($script:AppleDrv) (& $script:Apple 'ServiceStopped' $true 'Stopped'))
        $d.Kind | Should -Be 'ServiceNotRunning'
        $d.ButtonAction | Should -Be 'StartAppleService'
    }
    It 'Dienst läuft, antwortet aber nicht -> iTunes reparieren' {
        $d = Get-ConnectDiagnosis (& $script:Conn $false 0 @($script:AppleDrv) $script:OkApple)
        $d.Kind | Should -Be 'ServiceBroken'
        $d.ButtonAction | Should -Be 'RepairApple'
    }
    It 'Windows-Treiber statt Apple-Treiber oder Gerätefehler -> Reparieren' {
        (Get-ConnectDiagnosis (& $script:Conn $true 0 @((& $script:Dev 'wpdmtp.inf' 'Microsoft' 0)) $script:OkApple)).Kind | Should -Be 'DriverMissing'
        (Get-ConnectDiagnosis (& $script:Conn $true 0 @((& $script:Dev 'usbaapl64.inf' 'Apple, Inc.' 28)) $script:OkApple)).ButtonAction | Should -Be 'InstallAppleDriver'
    }
    It 'Treiber ok, Dienst ok, aber nicht gemeldet -> entsperren, neu anstecken, neu starten (kein Zurücksetzen)' {
        $d = Get-ConnectDiagnosis (& $script:Conn $true 0 @($script:AppleDrv) $script:OkApple)
        $d.Kind | Should -Be 'Replug'
        $d.Action | Should -Match 'entsperren'
        $d.Action | Should -Match 'abziehen und wieder anstecken'
        $d.ButtonAction | Should -Be 'Restart'
        $d.Action | Should -Not -Match 'Zurücksetzen|Standort'
    }
    It 'Test-IPhoneConnected: Windows allein reicht nicht' {
        if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) { function global:Get-CimInstance { param($ClassName, $Filter) } }
        Mock Get-UsbmuxDevices { throw 'kein Dienst' }
        Mock Get-CimInstance { [pscustomobject]@{ PNPDeviceID = 'USB\VID_05AC&PID_12A8\00008110000A1B2C3D4E5F6A'; Present = $true } }
        $r = Test-IPhoneConnected
        $r.Connected | Should -BeFalse
        $r.PnpSeen | Should -BeTrue
        $r.Via | Should -Be 'pnp'
        $r.UsbmuxReachable | Should -BeFalse
        Mock Get-UsbmuxDevices { [pscustomobject]@{ DeviceId = 1; Udid = 'x'; ConnectionType = 'USB' } }
        $ok = Test-IPhoneConnected
        $ok.Connected | Should -BeTrue
        $ok.Via | Should -Be 'usbmux'
    }
    It 'Bericht ohne Seriennummer, mit Programmen, Dienst und Treiber' {
        $appleFacts = [pscustomobject]@{ ITunesVersion = '12.13.11.1'; AmdsVersion = '19.0'; ServiceExists = $true; ServiceName = 'Apple Mobile Device Service'
            ServiceStatus = 'Running'; ServiceStartType = 'Automatic'; StoreApps = @([pscustomobject]@{ Name = 'AppleInc.AppleDevices'; Version = '1.2'; Kind = 'AppleDevices' }) }
        $conn = & $script:Conn $true 0 @($script:AppleDrv) ([pscustomobject]@{ Status = 'Conflict'; Facts = $appleFacts })
        $text = (Format-DiagnosticsReport $appleFacts $conn) -join "`n"
        $text | Should -Match 'iTunes: 12\.13\.11\.1'
        $text | Should -Match 'AppleInc\.AppleDevices 1\.2'
        $text | Should -Match 'Dienst: vorhanden=True Status=Running'
        $text | Should -Match 'USB\\VID_05AC&PID_12A8 '
        $text | Should -Match 'Apple, Inc\. oem42\.inf'
        $text | Should -Match 'Diagnose Apple-Programm: Conflict'
        $text | Should -Not -Match '00008110'
        ConvertTo-SafeDeviceId 'USB\VID_05AC&PID_12A8&MI_01\7&2B3C&0&0001' | Should -Be 'USB\VID_05AC&PID_12A8&MI_01'
    }
}

Describe 'Signaturprüfung (minisign wie der iloader-Updater)' {
    BeforeAll {
        $script:Fixtures = Join-Path $PSScriptRoot 'fixtures'
        $script:SamplePath = Join-Path $script:Fixtures 'signed-sample.bin'
        $script:SampleSig = (Get-Content (Join-Path $script:Fixtures 'signed-sample.bin.sig') -Raw).Trim()
        $script:SamplePub = (Get-Content (Join-Path $script:Fixtures 'signed-sample.pub') -Raw).Trim()
        $script:ILoaderSig = (Get-Content (Join-Path $script:Fixtures 'iloader-2.4.0-windows-x64.msi.sig') -Raw).Trim()
        Initialize-SignatureVerifier
        $script:Hex = { param($h) [byte[]]@(for ($i = 0; $i -lt $h.Length; $i += 2) { [System.Convert]::ToByte($h.Substring($i, 2), 16) }) }
    }
    It 'BLAKE2b-512 stimmt (RFC 7693)' {
        $abc = -join ([WhoopPlusSetup.Blake2b]::Hash512([System.Text.Encoding]::ASCII.GetBytes('abc')) | ForEach-Object { $_.ToString('x2') })
        $abc | Should -Be 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'
        $empty = -join ([WhoopPlusSetup.Blake2b]::Hash512([byte[]]@()) | ForEach-Object { $_.ToString('x2') })
        $empty | Should -Be '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce'
    }
    It 'Ed25519 stimmt (RFC 8032, Test 1 und 2)' {
        $pk1 = & $script:Hex 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
        $sig1 = & $script:Hex 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
        [WhoopPlusSetup.Ed25519]::Verify($pk1, [byte[]]@(), $sig1) | Should -BeTrue
        $pk2 = & $script:Hex '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
        $sig2 = & $script:Hex '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'
        [WhoopPlusSetup.Ed25519]::Verify($pk2, [byte[]]@(0x72), $sig2) | Should -BeTrue
        [WhoopPlusSetup.Ed25519]::Verify($pk2, [byte[]]@(0x73), $sig2) | Should -BeFalse
        $sig2[63] = $sig2[63] -bxor 1
        [WhoopPlusSetup.Ed25519]::Verify($pk2, [byte[]]@(0x72), $sig2) | Should -BeFalse
    }
    It 'Testdaten sind byte-genau ausgecheckt (kein CRLF, siehe fixtures/.gitattributes)' {
        [System.IO.File]::ReadAllBytes($script:SamplePath) | Should -Not -Contain ([byte]13)
    }
    It 'gültige Signatur -> Valid' {
        Test-MinisignSignature -Path $script:SamplePath -SignatureBase64 $script:SampleSig -PublicKey $script:SamplePub | Should -Be 'Valid'
    }
    It 'veränderte Datei -> Invalid' {
        $copy = Join-Path ([System.IO.Path]::GetTempPath()) ('wps-' + [guid]::NewGuid() + '.bin')
        $bytes = [System.IO.File]::ReadAllBytes($script:SamplePath)
        $bytes[10] = $bytes[10] -bxor 1
        [System.IO.File]::WriteAllBytes($copy, $bytes)
        try { Test-MinisignSignature -Path $copy -SignatureBase64 $script:SampleSig -PublicKey $script:SamplePub | Should -Be 'Invalid' }
        finally { Remove-Item $copy -Force }
    }
    It 'echte iloader-Signatur passt nicht zu fremder Datei -> Invalid' {
        Test-MinisignSignature -Path $script:SamplePath -SignatureBase64 $script:ILoaderSig | Should -Be 'Invalid'
    }
    It 'Signatur eines anderen Schlüssels -> Unavailable (nicht prüfbar, nicht „kaputt“)' {
        Test-MinisignSignature -Path $script:SamplePath -SignatureBase64 $script:SampleSig | Should -Be 'Unavailable'
    }
    It 'keine oder kaputte Signatur' {
        Test-MinisignSignature -Path $script:SamplePath -SignatureBase64 '' | Should -Be 'Unavailable'
        Test-MinisignSignature -Path $script:SamplePath -SignatureBase64 '%%%' | Should -Be 'Invalid'
    }
    It 'der eingebaute iloader-Schlüssel passt zur Schlüssel-ID der echten Signatur' {
        $pk = [System.Convert]::FromBase64String($script:Config.ILoaderPublicKey)
        $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($script:ILoaderSig))
        $sig = [System.Convert]::FromBase64String(($text -split "`n")[1].Trim())
        [System.Text.Encoding]::ASCII.GetString($sig, 0, 2) | Should -Be 'ED'
        ($pk[2..9] -join ',') | Should -Be ($sig[2..9] -join ',')
    }
}

Describe 'Hilfsfunktionen' {
    It 'Get-PropValue liest Hashtables und Objekte, fehlend = $null' {
        Get-PropValue @{ a = 1 } 'a' | Should -Be 1
        Get-PropValue ([pscustomobject]@{ a = 2 }) 'a' | Should -Be 2
        Get-PropValue ([pscustomobject]@{ a = 2 }) 'b' | Should -BeNullOrEmpty
        Get-PropValue $null 'a' | Should -BeNullOrEmpty
    }
    It 'erkennt eine abgelehnte Windows-Abfrage (echte Form der Ausnahme)' {
        # So kommt ein Fehler aus [Diagnostics.Process]::Start in PowerShell an: MethodInvocationException -> Win32Exception.
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = Join-Path ([System.IO.Path]::GetTempPath()) ('gibt-es-nicht-' + [guid]::NewGuid() + '.exe')
        $psi.UseShellExecute = $false
        $caught = $null
        try { $null = [System.Diagnostics.Process]::Start($psi) } catch { $caught = $_.Exception }
        $caught | Should -BeOfType ([System.Management.Automation.MethodInvocationException])
        Get-Win32ErrorCode $caught | Should -Be 2              # Datei nicht gefunden
        Test-IsUserCancelled $caught | Should -BeFalse
        # Gleiche Form mit 1223 (ERROR_CANCELLED) = „Nein“ in der Windows-Abfrage.
        $uac = New-Object System.Management.Automation.MethodInvocationException -ArgumentList 'Start', (New-Object System.ComponentModel.Win32Exception -ArgumentList 1223)
        Test-IsUserCancelled $uac | Should -BeTrue
        Test-IsUserCancelled (New-Object System.ComponentModel.Win32Exception -ArgumentList 1223) | Should -BeTrue
        Test-IsUserCancelled (New-Object System.Exception 'y') | Should -BeFalse
        Test-IsUserCancelled $null | Should -BeFalse
    }
    It 'Prüfungen laufen im eigenen Runspace und sehen die Einstellungen' {
        $r = Invoke-InBackground -ScriptBlock { [pscustomobject]@{ Port = $Config.UsbmuxPort; Check = (Test-IPhoneConnected) } } -Shared -ForceRunspace
        Close-CheckRunspace
        $r.Port | Should -Be 27015
        $r.Check.PSObject.Properties.Name | Should -Contain 'Connected'
    }
    It 'meldet Netzfehler beim Download und hinterlässt keine Teildatei' {
        $part = Join-Path ([System.IO.Path]::GetTempPath()) ('wps-' + [guid]::NewGuid() + '.part')
        Set-Content -LiteralPath $part -Value 'alt'
        $progress = [hashtable]::Synchronized(@{ Done = 0L; Total = 0L; Cancel = $false })
        { Invoke-InBackground -ScriptBlock $script:DownloadScript -ArgumentList @('https://127.0.0.1:9/x.msi', $part, $progress, 'test') -ForceRunspace } | Should -Throw
        Test-Path -LiteralPath $part | Should -BeFalse
    }
}
