@{
    # Der CI-Lauf bricht nur bei Fehlern (Severity Error) ab; Warnungen werden angezeigt.
    ExcludeRules = @(
        # Write-Host nur im Selbsttest in der Konsole (in der .exe wird nichts ausgegeben).
        'PSAvoidUsingWriteHost',
        # Interne Funktionen eines Fenster-Programms, keine Cmdlets für andere Nutzer.
        'PSUseShouldProcessForStateChangingFunctions',
        'PSUseSingularNouns'
    )
    Rules        = @{
        # Muss mit Windows PowerShell 5.1 laufen (in Windows enthalten).
        PSUseCompatibleSyntax = @{
            Enable         = $true
            TargetVersions = @('5.1', '7.0')
        }
    }
}
