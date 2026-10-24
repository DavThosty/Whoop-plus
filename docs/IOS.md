# Whoop Plus auf dem iPhone (kostenlos mit SideStore)

Diese Anleitung bringt Whoop Plus als **echte App** auf dein iPhone – mit einer **kostenlosen Apple-ID**,
einem **Windows-PC** (nur einmal für die Einrichtung) und **ohne Mac**.

So hängt alles zusammen:

```
Push auf main ──▶ GitHub Actions (macOS) baut WhoopPlus.ipa ──▶ Release "ios-latest"
                                                                    │
iPhone: Safari lädt die IPA ──▶ SideStore signiert sie mit deiner Apple-ID ──▶ App auf dem Home-Bildschirm
```

- Es gibt keinen Server mehr. Alle Daten bleiben in der App auf dem iPhone.
- Apps mit einer kostenlosen Apple-ID laufen **7 Tage**. SideStore verlängert sie direkt auf dem iPhone
  („Refresh“). Den PC brauchst du nur für die Ersteinrichtung und falls SideStore selbst abläuft.

> Stand der SideStore-Schritte: Oktober 2026, nach der offiziellen Anleitung auf
> [docs.sidestore.io](https://docs.sidestore.io/docs/installation/prerequisites). Falls sich dort etwas
> geändert hat, gilt die offizielle Anleitung.

---

## 1. Wie ein Build entsteht

1. Jeder Push auf den Branch `main` startet den Workflow **iOS-Build** (`.github/workflows/ios.yml`).
   Reine Doku-Änderungen (`docs/**`, `*.md`, `LICENSE`) lösen keinen Build aus.
2. Der Workflow läuft auf einem macOS-Runner mit Xcode: Tests → Web-Oberfläche bauen → `npx cap sync ios`
   → unsignierter Xcode-Build → `WhoopPlus.ipa`.
3. Die IPA landet
   - als **Artefakt** am Workflow-Lauf (30 Tage) und
   - im Release **`ios-latest`** (wird bei jedem Build ersetzt):
     <https://github.com/DavThosty/Whoop-plus/releases/tag/ios-latest>
4. Die Build-Nummer zählt automatisch hoch (Nummer des Workflow-Laufs), die Version kommt aus
   `package.json`. In der App siehst du sie in iOS unter *Einstellungen → Allgemein → iPhone-Speicher → Whoop Plus*.

**Manuell starten:** GitHub → *Actions* → *iOS-Build* → *Run workflow*.

**Kosten:** Das Repository ist öffentlich – dann sind GitHub-Actions-Minuten (auch macOS) kostenlos.
Wäre das Repository privat, zählen macOS-Minuten deutlich mehr (bisher Faktor 10): von den 2.000 Freiminuten
im Monat (Free-Plan) blieben rechnerisch nur ca. 200 macOS-Minuten, also grob **15–20 Builds pro Monat**
(ein Build dauert etwa 8–12 Minuten). Bei einem privaten Repository am besten nur manuell bauen: dazu im
Workflow den Block `push:` entfernen, sodass nur `workflow_dispatch` übrig bleibt. Aktuelle Preise:
[GitHub-Dokumentation zu Actions-Abrechnung](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions).

---

## 2. Einmalig: SideStore installieren (Windows-PC)

### Am einfachsten: Einrichtungshelfer herunterladen

Ein kleines Windows-Programm führt dich durch alle Schritte dieses Kapitels. Es installiert, was auf dem PC
fehlt, und zeigt dir genau, was du am iPhone tippen musst.

1. Herunterladen: <https://github.com/DavThosty/Whoop-plus/releases/download/setup-helper/WhoopPlus-Setup.exe>
2. Doppelklick auf **WhoopPlus-Setup.exe**.
3. Erscheint „Der Computer wurde durch Windows geschützt“: **Weitere Informationen** → **Trotzdem ausführen**.
4. **Los geht's** klicken und den Anweisungen folgen.

Deine Apple-ID gibst du nur im Programm iloader ein – der Helfer fragt nie danach. Später (SideStore abgelaufen,
Fehler nach einem iOS-Update, neues iPhone) einfach wieder starten. Mehr dazu:
[tools/windows-setup/README.md](../tools/windows-setup/README.md). Ohne Helfer geht es wie folgt von Hand.

### Was du brauchst

- iPhone mit **iOS 15.0 oder neuer** und gesetztem **Gerätecode**
- Windows-PC mit **Windows 8 oder neuer, 64 Bit** (nicht: 32-Bit-Windows, nicht: Windows 10 auf ARM)
- USB-Kabel für das iPhone
- deine Apple-ID (eine kostenlose reicht; sie muss nicht die Apple-ID des iPhones sein)
- **WLAN** auf dem iPhone (mobile Daten reichen für SideStore nicht)
- etwas Zeit

### 2.1 iPhone vorbereiten: LocalDevVPN

SideStore nutzt ein **VPN, das nur auf dem iPhone selbst läuft** (es geht kein Verkehr nach außen).
Darüber spricht SideStore mit iOS-internen Diensten.

1. **LocalDevVPN** aus dem App Store installieren:
   <https://apps.apple.com/app/localdevvpn/id6755608044>
2. LocalDevVPN öffnen und **verbinden**. Bei „VPN-Konfigurationen hinzufügen“ auf **Erlauben** tippen und
   den Code eingeben.

LocalDevVPN muss **immer verbunden sein, wenn du in SideStore Apps installierst, aktualisierst oder
verlängerst**. (Laut SideStore kostet es keinen Akku, da keine Verbindung nach außen aufgebaut wird.)

### 2.2 PC vorbereiten: iTunes und iloader

1. **iTunes** installieren – am besten direkt von Apple:
   <https://www.apple.com/itunes/download/win64>
   (alternativ aus dem Microsoft Store; klappt beides nicht, die App **Apple-Geräte** aus dem Microsoft Store).
2. **iloader** (Installationsprogramm für SideStore) herunterladen und installieren:
   <https://github.com/nab138/iloader/releases/latest/download/iloader-windows-x64.msi> (empfohlen, MSI)
   oder als EXE: <https://github.com/nab138/iloader/releases/latest/download/iloader-windows-x64.exe>

### 2.3 SideStore aufs iPhone bringen

Am PC:

1. iPhone per USB anschließen. Falls das iPhone fragt: **„Diesem Computer vertrauen“** → Code eingeben.
2. **iloader** öffnen.
3. Mit deiner **Apple-ID** anmelden (Groß-/Kleinschreibung beachten).
4. Dein iPhone auswählen.
5. **„Install SideStore (Stable)“** wählen.

iloader installiert SideStore und richtet dabei die **Pairing-Datei** (Kopplungsdatei) ein. Über diese Datei
spricht SideStore später ohne PC mit iOS. Meldet SideStore irgendwann einen Pairing-Fehler, wird sie mit
iloader ersetzt (siehe *Fehlerbehebung → Pairing-Datei ersetzen*).

Am iPhone (je nach iOS-Version):

**iOS 18 und neuer**

1. *Einstellungen → Allgemein → VPN & Geräteverwaltung*.
2. Unter „Entwickler-App“ deine Apple-ID antippen → **„[Apple-ID] vertrauen“** → **„Erlauben & Neustarten“**
   → Code eingeben.
3. *Einstellungen → Datenschutz & Sicherheit* → ganz unten **Entwicklermodus** einschalten. Das iPhone
   startet neu (danach ggf. „Einschalten“ bestätigen).

**iOS 16 bis 17**

1. *Einstellungen → Allgemein → VPN & Geräteverwaltung* → deine Apple-ID → **„[Apple-ID] vertrauen“** → **„Vertrauen“**.
2. *Einstellungen → Datenschutz & Sicherheit* → ganz unten **Entwicklermodus** einschalten (Neustart).

**iOS 15**

1. *Einstellungen → Allgemein → VPN & Geräteverwaltung* → deine Apple-ID → **„[Apple-ID] vertrauen“** → **„Vertrauen“**.

Danach bei allen Versionen:

1. **LocalDevVPN** öffnen → **Connect**.
2. **SideStore** öffnen und mit **derselben Apple-ID** anmelden, die du in iloader benutzt hast.
3. Unten auf **„My Apps“** → rechts neben SideStore auf den Zähler **„7 DAYS“** tippen. Damit verlängert sich
   SideStore selbst und die Einrichtung wird abgeschlossen. Fragt SideStore, ob ein Zertifikat widerrufen
   bzw. neu erstellt werden soll: **„Yes“** bzw. **„Refresh Now“**.
4. SideStore springt kurz zum Home-Bildschirm (mit Mitteilung) und ist nach wenigen Sekunden wieder da.

Wichtig: **Vor dem ersten eigenen App-Install SideStore einmal so verlängern** (Schritt 3).

### Grenzen der kostenlosen Apple-ID

| Grenze | Bedeutung für dich |
|---|---|
| **3 aktive Apps** gleichzeitig (SideStore zählt mit) | SideStore + Whoop Plus + höchstens eine weitere App |
| **10 App-IDs pro 7 Tage** | Jede *neu* installierte App verbraucht eine. Updates von Whoop Plus verbrauchen keine neue. |
| **7 Tage Laufzeit** | Danach startet die App nicht mehr, bis sie in SideStore verlängert wird – die Daten bleiben erhalten. |

---

## 3. Whoop Plus installieren

1. Am iPhone in **Safari** öffnen: <https://github.com/DavThosty/Whoop-plus/releases/tag/ios-latest>
   (das Repository ist öffentlich, eine Anmeldung bei GitHub ist nicht nötig; bei einem privaten Repository
   vorher in Safari bei GitHub anmelden).
2. Unter *Assets* auf **`WhoopPlus.ipa`** tippen → **Laden**. Die Datei liegt danach in der Dateien-App unter
   *Downloads*.
3. **LocalDevVPN** verbinden (WLAN an).
4. Installieren – eine der beiden Varianten:
   - In **SideStore** → *My Apps* → oben links **„+“** → in der Dateien-Auswahl `WhoopPlus.ipa` wählen, **oder**
   - in der Dateien-App die IPA lange drücken → **Teilen** → **SideStore** (falls SideStore dort angeboten wird).
5. SideStore signiert und installiert die App. „Whoop Plus“ erscheint auf dem Home-Bildschirm und in
   SideStore unter *My Apps* mit dem Zähler „7 DAYS“.

> Endet der Download in Safari als `.zip` statt `.ipa`: Datei in der Dateien-App in `WhoopPlus.ipa` umbenennen.

---

## 4. Alle 7 Tage verlängern

- SideStore versucht, Apps **im Hintergrund** zu verlängern. Dafür muss **LocalDevVPN verbunden** sein und
  WLAN an. Verlass dich nicht blind darauf.
- **Manuell:** LocalDevVPN verbinden → SideStore → *My Apps* → **„Refresh All“** (oder auf den Tage-Zähler
  der App tippen). Am besten einmal pro Woche zu einem festen Zeitpunkt, z. B. sonntags.
- **SideStore selbst** läuft ebenfalls nach 7 Tagen ab und wird mit „Refresh All“ mit verlängert. Ist
  SideStore abgelaufen, musst du es mit dem PC und iloader neu installieren (Abschnitt 2.3).
- Ist Whoop Plus abgelaufen, startet die App nicht. **Daten gehen dabei nicht verloren** – einfach verlängern.

## 5. Neue Version installieren

1. Neuen Build abwarten (GitHub → *Actions* → grüner Haken) oder manuell starten.
2. Wie in Abschnitt 3 die neue `WhoopPlus.ipa` aus dem Release `ios-latest` laden und über SideStore
   installieren. Sie ersetzt die alte Version, **alle Daten bleiben erhalten**, und die 7 Tage beginnen neu.

> **Achtung: Whoop Plus niemals löschen**, solange du die Daten behalten willst. Beim Löschen der App
> löscht iOS alle gespeicherten Messwerte. Vorher in der App unter *Mehr → Daten → Sicherung → Exportieren*
> eine Sicherung anlegen (z. B. in „Dateien“ oder iCloud Drive sichern) und nach der Neuinstallation mit
> „Einspielen“ zurückholen.

---

## 6. Erster Start und Kopplung mit dem Band

1. **Offizielle WHOOP-App löschen** (oder zumindest beenden). Das Band hält nur **eine** Verbindung.
2. *Einstellungen → Bluetooth* → bei „WHOOP …“ auf **ⓘ** → **„Dieses Gerät ignorieren“**. So startet die
   Kopplung mit Whoop Plus sauber neu.
3. Band laden und anlegen.
4. **Whoop Plus** öffnen und auf **„Band verbinden“** tippen (auf *Heute* oder unter *Mehr → Band*).
5. Beim ersten Tippen fragt iOS nach **Bluetooth** → **Erlauben**.
   (Abgelehnt? *Einstellungen → Whoop Plus → Bluetooth* einschalten.)
   Danach erscheint eine Liste „Suche WHOOP-Band …“ – dein Band (z. B. „WHOOP 4C…“) antippen.
6. iOS zeigt eine **Bluetooth-Kopplungsanfrage** → **Koppeln**. Ohne Kopplung ignoriert das Band alle
   Befehle. Du hast dafür ca. 30 Sekunden.
7. Danach stellt die App die Uhr des Bands und lädt den Verlauf. Der erste Sync kann bei vollem Bandspeicher
   (bis ca. 14 Tage) einige Minuten dauern – App dabei geöffnet lassen.
8. Unter *Mehr → Profil* Alter, Gewicht usw. eintragen.

Die App merkt sich das gewählte Band, damit später keine Auswahlliste mehr nötig ist.

## 7. So funktioniert der Sync im Alltag

- **Beim Öffnen der App und bei jeder Rückkehr in die App** verbindet sie sich ohne Auswahlliste mit dem
  gemerkten Band. Nach dem Verbinden lädt sie automatisch den Verlauf; ist sie schon verbunden, lädt sie neu,
  wenn der letzte Sync älter als 5 Minuten ist.
- Ist das Band nicht erreichbar, erscheint **keine Fehlermeldung** – oben steht nur dezent
  „Nicht in Reichweite“, Einzelheiten unter *Mehr → Protokoll*. Nach einem Verbindungsabbruch versucht die
  App es noch ein paar Mal von selbst (nach 5 s, 15 s und 60 s); danach erst wieder beim nächsten Öffnen.
  Ein Tipp auf „Band verbinden“ zeigt dagegen echte Fehler an.
- Hast du selbst auf **„Trennen“** getippt, verbindet sich die App bis zum nächsten Start nicht von selbst.
- Solange die App offen und verbunden ist, synchronisiert sie zusätzlich alle 15 Minuten.
- **Live-Puls** ist nach jedem Verbinden automatisch an (für den Puls in der Navigationsleiste). Das kostet
  etwas mehr Akku am Band und am iPhone; unter *Mehr → Band* lässt er sich mit „Live aus“ für die aktuelle
  Verbindung abschalten.
- Beim Wechsel in den Hintergrund trennt die App die Verbindung **nicht** (Hintergrundmodus
  „bluetooth-central“). Kurz zu einer anderen App wechseln und zurück geht also ohne neuen Verbindungsaufbau.
- **Realistische Grenzen:** iOS pausiert die App (und ihre Oberfläche) im Hintergrund nach kurzer Zeit und
  kann sie jederzeit beenden. Ein Sync im Hintergrund ist deshalb **nicht verlässlich**. Verlässlich ist:
  App öffnen → ein paar Sekunden bis Minuten warten, bis „Letzter Sync: gerade eben“ dasteht.
- Das Band speichert **ungefähr 14 Tage**. Öffne die App also mindestens alle paar Tage, sonst gehen die
  ältesten Daten auf dem Band verloren.

---

## 8. Fehlerbehebung

**Das Band taucht in der Auswahlliste nicht auf**
- Ist die offizielle WHOOP-App (oder ein anderes Gerät) noch verbunden? WHOOP-App beenden/löschen.
  Bereits verbundene Bänder zeigt iOS in der Suche nicht an.
- Bluetooth aus- und wieder einschalten, Band näher ans iPhone, Band laden.
- *Einstellungen → Whoop Plus → Bluetooth* muss an sein.

**„Keine Antwort vom Band … Kopplung bestätigt?“**
- Die Kopplungsanfrage wurde nicht bestätigt oder ist abgelaufen. In *Einstellungen → Bluetooth* das Band
  ignorieren und neu verbinden.

**Die App verbindet sich nicht mit dem Band**
- Band außer Reichweite oder mit einer anderen App verbunden (oben steht „Nicht in Reichweite“). Band in die
  Nähe bringen, die WHOOP-App schließen und unter *Mehr → Band* auf „Band verbinden“ tippen.
- Nach einem Band-Tausch: einmal „Band verbinden“ und das neue Band wählen – die App merkt sich dann das neue.

**„Bluetooth ist ausgeschaltet“ / „Bluetooth-Zugriff nicht erlaubt“**
- Bluetooth im Kontrollzentrum einschalten bzw. unter *Einstellungen → Whoop Plus* erlauben.

**Whoop Plus startet nicht / schließt sich sofort**
- Meist abgelaufen (7 Tage). In SideStore verlängern (LocalDevVPN verbinden!).

**SideStore: „AFC Connection Failure“ / „No Wi-Fi or VPN connection“**
- LocalDevVPN **und** WLAN verbunden? DNS-/Werbeblocker ausschalten.
- Nochmal versuchen, SideStore bzw. LocalDevVPN neu starten.
- Hilft nichts: **Pairing-Datei ersetzen** (siehe unten).

**Pairing-Datei ersetzen** (nötig z. B. nach einem iOS-Update oder Zurücksetzen – passiert laut SideStore
auch gelegentlich ohne erkennbaren Grund)
1. iPhone per USB an den PC, iloader öffnen (Update annehmen, falls angeboten).
2. **„Delete Stored Pairing“** klicken.
3. Das iPhone in der Geräteliste anklicken und am iPhone **Vertrauen** bestätigen.
4. **„Manage Pairing File“** → rechts neben **SideStore** auf **„Place“** klicken →
   „Pairing file placed successfully!“ erscheint grün.
   Anleitung: <https://docs.sidestore.io/docs/advanced/pairing-file>

**SideStore: Grenze von 3 Apps oder 10 App-IDs erreicht**
- Eine andere per SideStore installierte App entfernen. Bei der App-ID-Grenze bis zu 7 Tage warten.
  Ein *Update* von Whoop Plus braucht keine neue App-ID.

**SideStore-Anmeldung schlägt fehl**
- Oft ist der „Anisette“-Server kurz gestört: in SideStore unter *Settings → Anisette URL* einen anderen
  offiziellen Server wählen. Weitere Hilfe: <https://docs.sidestore.io/docs/troubleshooting/common-issues>

**Der GitHub-Build ist rot**
- GitHub → *Actions* → Lauf öffnen → fehlgeschlagenen Schritt ansehen. Häufig: ein Test schlägt fehl oder
  ein Swift-Paket konnte nicht geladen werden (dann einfach *Re-run jobs*).

**Daten sichern / umziehen**
- *Mehr → Daten → Sicherung → Exportieren* öffnet das iOS-Teilen-Menü (Dateien, AirDrop, Mail …).
  *Einspielen* liest eine solche JSON-Datei wieder ein.
