# Whoop Plus Einrichtungshelfer (Windows)

Ein kleines Windows-Programm, das dich Schritt für Schritt durch die Einrichtung führt, damit
**Whoop Plus** kostenlos auf dein iPhone kommt. Es installiert, was auf dem PC fehlt, und zeigt dir
genau, was du am iPhone tippen musst.

## So geht's

1. Programm herunterladen:
   <https://github.com/DavThosty/Whoop-plus/releases/download/setup-helper/WhoopPlus-Setup.exe>
2. Doppelklick auf **WhoopPlus-Setup.exe**.
3. Erscheint „Der Computer wurde durch Windows geschützt“: auf **Weitere Informationen** klicken, dann auf
   **Trotzdem ausführen**. (Das Programm hat keine gekaufte Signatur, deshalb fragt Windows nach.)
4. Auf **Los geht's** klicken und den Anweisungen folgen.

Du brauchst: einen Windows-PC (Windows 10 oder 11, 64 Bit), dein iPhone, das Kabel, WLAN und deine Apple-ID.
Das dauert etwa 20 Minuten.

## Was das Programm für dich erledigt

- Es prüft, ob dein Windows passt.
- Es installiert das kostenlose **Apple-Programm** iTunes von Apple, damit der PC das iPhone erkennt.
  Stören Store-Apps wie **Apple-Geräte**, Apple Music oder Apple TV, entfernt es sie nach Rückfrage, repariert iTunes
  und startet den PC einmal neu (danach geht es von selbst weiter).
  Was schon da ist, wird übersprungen.
- Es erkennt von selbst, wenn das iPhone per Kabel angeschlossen ist.
- Es lädt das Programm **iloader** (bringt SideStore aufs iPhone), installiert es und hält es aktuell.
- Am Ende zeigt es einen QR-Code: Mit der iPhone-Kamera scannen, und SideStore fügt Whoop Plus hinzu.
  Danach kommen Updates direkt in SideStore.

Fragt Windows „Möchten Sie zulassen, dass …“, klicke auf **Ja**. Das passiert nur beim Installieren.

## Was du selbst machst

- Am iPhone: die App **LocalDevVPN** laden und einschalten, dem Entwickler vertrauen, den Entwicklermodus
  einschalten. Das Programm zeigt dir dabei jeden Knopf.
- In **iloader**: mit deiner Apple-ID anmelden und **SideStore (Stable)** anklicken.

**Deine Apple-ID gibst du nur in iloader ein.** Der Einrichtungshelfer fragt nie danach und speichert
sie nicht.

## Später wieder starten

Das Programm merkt sich, was schon erledigt ist. Beim nächsten Start fragt es „Hat sich etwas geändert?“:

| Auswahl | Was dann passiert |
|---|---|
| Alles gut – nur prüfen | PC prüfen, iloader auf den neuesten Stand bringen. |
| SideStore öffnet nicht oder ist abgelaufen | SideStore wird mit iloader neu aufgespielt. Whoop Plus und deine Daten bleiben erhalten – **Whoop Plus nicht löschen**. |
| Fehlermeldung zur Verbindung, z. B. nach einem iOS-Update | Die Verbindung zwischen iPhone und SideStore wird mit iloader erneuert. |
| Mein iPhone wird am PC nicht erkannt | Sucht die Ursache (Apple-Programm, Dienst, Kabelverbindung, Vertrauen) und repariert, was geht. |
| Ich habe ein neues iPhone | Alle iPhone-Schritte noch einmal. |

Ganz unten gibt es außerdem „Erweitert: alles von vorne einrichten“.

## Wenn etwas nicht klappt

Klicke auf **Hilfe**. Dann ist ein Fehlerbericht kopiert: In eine Nachricht einfügen (Strg + V) und an die
Person schicken, die dir hilft. Der Bericht liegt auch hier:
`%LOCALAPPDATA%\WhoopPlusSetup\log.txt`. Er enthält keine Apple-ID und keine Passwörter.

Die Anleitung für alles Weitere (Whoop Plus installieren, automatisch verlängern, Updates) steht in
[docs/ANLEITUNG.md](../../docs/ANLEITUNG.md), die Einrichtung von Hand in [docs/TECHNIK.md](../../docs/TECHNIK.md).

---

## Für Entwickler

| Datei | Inhalt |
|---|---|
| `WhoopPlusSetup.ps1` | Das Programm (Windows PowerShell 5.1, Windows Forms). Bilder sind als Base64 eingebettet. |
| `build.ps1` | Baut mit [ps2exe](https://github.com/MScholtes/PS2EXE) die `WhoopPlus-Setup.exe`. |
| `icon.ico` | Programmsymbol, erzeugt aus `resources/app-icon.svg`. |
| `assets/render-assets.cjs` | Erzeugt `icon.ico`, die Schritt-Bilder und QR-Codes und bettet sie ins Skript ein. |
| `tests/WhoopPlusSetup.Tests.ps1` | Pester-5-Tests der reinen Funktionen (Versionen, Ablauf, Texte, iPhone-Erkennung …). |
| `PSScriptAnalyzerSettings.psd1` | Regeln für PSScriptAnalyzer. |

Der Workflow [`.github/workflows/windows-setup.yml`](../../.github/workflows/windows-setup.yml) läuft bei
Änderungen in diesem Ordner: PSScriptAnalyzer → Pester (PowerShell 5.1 und 7) → EXE bauen → Selbsttest
(`-SelfTest`, ohne Fenster) → auf `main` Release **`setup-helper`** mit `WhoopPlus-Setup.exe` und
`WhoopPlus-Setup.exe.sha256`.

```powershell
# Tests
Invoke-Pester -Path tools/windows-setup/tests
# Selbsttest ohne Fenster (Exit 0 = ok)
powershell -ExecutionPolicy Bypass -File tools\windows-setup\WhoopPlusSetup.ps1 -SelfTest
# EXE bauen (Windows)
powershell -ExecutionPolicy Bypass -File tools\windows-setup\build.ps1
# Bilder neu erzeugen (Playwright + Python mit Pillow und segno)
NODE_PATH=$(npm root -g) node tools/windows-setup/assets/render-assets.cjs
```

Hinweise:

- `WhoopPlusSetup.ps1` muss **UTF-8 mit BOM** bleiben (sonst zeigt Windows PowerShell 5.1 Umlaute falsch).
- Deutsche Anführungszeichen „ “ beenden in PowerShell einen `"…"`-Text. In doppelt gequoteten Texten
  deshalb mit Backtick schreiben (`` `„ `` und `` `“ ``) oder einfache Anführungszeichen verwenden.
- Gemerkte Schritte: `%LOCALAPPDATA%\WhoopPlusSetup\state.json`. Löschen = wie ein erster Start.
- Erkennung des iPhones: Apple-Gerätedienst (usbmuxd auf `127.0.0.1:27015`, Anfrage `ListDevices`),
  ersatzweise USB-Gerät mit Hersteller `05AC`.
- iloader: neueste Version über die GitHub-API (`nab138/iloader`), ersatzweise `latest.json`. Geladen wird nur von
  `https://github.com/nab138/iloader/releases/download/…/*.msi|exe` (Positivliste, sicherer Dateiname).
  Installiert wird nur, wenn mindestens eine Prüfung passt und keine fehlschlägt: **minisign-Signatur** des
  iloader-Updaters (fest eingebauter öffentlicher Schlüssel aus `src-tauri/tauri.conf.json`, ID `E0D7460DFA37E536`;
  BLAKE2b + Ed25519 als kleines C#-Stück, das per `Add-Type` übersetzt wird), **SHA-256** und **Größe** laut GitHub-API.
  Lässt sich nichts prüfen (z. B. neuer Schlüssel), öffnet der Helfer die iloader-Seite zum Selbst-Laden.
  Installation mit `msiexec /qb!` über die Windows-Abfrage (`runas`); „Nein“ wird als Win32-Fehler 1223 erkannt.
- iPhone- und Apple-Programm-Suche laufen in einem eigenen Runspace (das Fenster ruckelt nicht).
- Modul-Versionen sind fest: Pester 5.9.0, PSScriptAnalyzer 1.25.0, ps2exe 1.0.18 (Workflow und `build.ps1`).
- Apple-Programm: nur iTunes von Apple – winget `Apple.iTunes` (lädt Apples `iTunes64Setup.exe`), sonst das
  Installationsprogramm direkt von apple.com (Weiterleitung nur auf `*.apple.com`, Authenticode „Apple Inc.“ geprüft,
  `/quiet`), zuletzt die Apple-Seite im Browser. Nach einem Erfolg wird nie ein weiterer Weg installiert.
  Danach bis zu 60 s auf „Apple Mobile Device Service“ warten (gestoppt → mit Rückfrage starten, fehlt → Neustart).
- Bewertung (`Get-AppleSoftwareDiagnosis`): Store-Apps „Apple-Geräte“/Apple Music/Apple TV → *Conflict* (entfernen,
  iTunes mit `winget … --force` neu installieren, Neustart); iTunes ohne Apple Mobile Device Support/Dienst → *Broken*
  (iTunes neu installieren, Neustart).
- Verbindung zählt nur, wenn usbmuxd das iPhone meldet. Sieht nur Windows es, sucht `Get-ConnectDiagnosis` die Ursache:
  Dienst gestoppt (starten), Dienst antwortet nicht (iTunes reparieren), kein Apple-Treiber/Gerätefehler
  (`pnputil /add-driver …\usbaapl64.inf /install`), sonst Vertrauen fehlt. Nach frischer Installation: nach ~30 s Neustart anbieten.
- Neustart: `state.json` merkt Modus und Schritt, `HKCU\…\RunOnce` öffnet den Helfer danach einmal von selbst.
