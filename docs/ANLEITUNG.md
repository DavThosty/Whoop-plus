# Whoop Plus aufs iPhone – die Anleitung

Diese Anleitung ist alles, was du brauchst. Einmal einrichten (ca. 30 Minuten), danach läuft alles am iPhone.

---

## 1. Was du brauchst

- ein **iPhone** (iOS 15 oder neuer) mit Code-Sperre und **WLAN**
- einen **Windows-PC** und ein **USB-Kabel** fürs iPhone – nur für die Einrichtung
- eine **Apple-ID** (die normale, kostenlose reicht)

---

## 2. Einmal einrichten

**Am iPhone zuerst:**

1. Im App Store die App **LocalDevVPN** laden: <https://apps.apple.com/app/localdevvpn/id6755608044>
2. LocalDevVPN öffnen → **Connect** → bei der Frage nach der VPN-Konfiguration **Erlauben** → Code eingeben.

**Am PC:**

3. Den Einrichtungs-Helfer laden:
   **[WhoopPlus-Setup.exe](https://github.com/DavThosty/Whoop-plus/releases/download/setup-helper/WhoopPlus-Setup.exe)**
4. Die Datei starten. Windows fragt einmal nach: auf **Weitere Informationen** → **Trotzdem ausführen** klicken.
5. iPhone per USB anschließen. Fragt das iPhone **„Diesem Computer vertrauen?“** → **Vertrauen** → Code eingeben.
6. Den Anweisungen des Helfers folgen und dich mit deiner **Apple-ID** anmelden. Der Helfer bringt die App
   **SideStore** aufs iPhone.

**Wieder am iPhone:**

7. **Einstellungen** → **Allgemein** → **VPN & Geräteverwaltung** → deine Apple-ID antippen → **Vertrauen**
   (bei neuerem iOS: **Erlauben & Neustarten**).
8. Ab iOS 16: **Einstellungen** → **Datenschutz & Sicherheit** → ganz unten **Entwicklermodus** einschalten.
   Das iPhone startet neu; danach **Einschalten** bestätigen.
9. **SideStore** öffnen und mit **derselben Apple-ID** anmelden.
10. Unten auf **My Apps** → neben SideStore auf **7 DAYS** tippen. Fragt SideStore nach, mit **Yes** bzw.
    **Refresh Now** bestätigen. SideStore verschwindet kurz und ist gleich wieder da.

Fertig – **den PC brauchst du jetzt nicht mehr**. Das Kabel kann ab.

> Klappt der Helfer nicht? Die Einrichtung geht auch von Hand: [TECHNIK.md, Abschnitt 2](TECHNIK.md#2-einmalig-sidestore-installieren-windows-pc).

---

## 3. Whoop Plus installieren

1. **LocalDevVPN** öffnen → **Connect** (WLAN muss an sein).
2. **SideStore** öffnen → unten **Sources** → oben **+**.
3. Diese Adresse einfügen und auf **Add** tippen:

   ```
   https://raw.githubusercontent.com/DavThosty/Whoop-plus/sidestore/source.json
   ```

   Oder schneller: Diesen Text kopieren, in **Safari** oben in die Adresszeile einfügen und öffnen –
   SideStore geht dann von selbst auf und fragt, ob die Quelle hinzugefügt werden soll:

   ```
   sidestore://source?url=https://raw.githubusercontent.com/DavThosty/Whoop-plus/sidestore/source.json
   ```

4. In der Liste auf **Whoop Plus** tippen → **Free** (bzw. **Install**). Kurz warten – die App erscheint auf dem
   Home-Bildschirm.
5. Whoop Plus öffnen → **Band verbinden** → **Erlauben** → dein Band antippen → **Koppeln**.
   (Vorher die offizielle WHOOP-App schließen – das Band kann nur mit einer App gleichzeitig reden.)

---

## 4. Nie mehr dran denken: automatisch verlängern

Ohne Bezahl-Konto laufen SideStore und Whoop Plus **7 Tage** und müssen dann „verlängert“ werden. Das erledigt
das iPhone jede Nacht selbst, wenn du einmal das hier einrichtest:

**Kurzbefehl anlegen**

1. App **Kurzbefehle** öffnen → unten **Kurzbefehle** → oben **+**.
2. **Aktion hinzufügen** → **LocalDevVPN** suchen → die Aktion **LocalDevVPN** antippen (Einstellung: **Enable**).
3. **Warten** suchen und hinzufügen → **3** Sekunden.
4. **SideStore** suchen → **Refresh All Apps** hinzufügen. Auf den kleinen Pfeil daneben tippen und
   **Beim Ausführen anzeigen** ausschalten.
5. Oben den Namen auf **Apps verlängern** ändern → **Fertig**.
6. Den neuen Kurzbefehl **einmal antippen** und alle Fragen mit **Erlauben** beantworten.

**Jede Nacht automatisch starten**

7. Unten **Automation** → **+** (bzw. **Persönliche Automation erstellen**).
8. **Tageszeit** → **03:00** → **Täglich**.
9. **Sofort ausführen** wählen und **Bei Ausführung mitteilen** ausschalten
   (bei älterem iOS: **Vor dem Ausführen fragen** ausschalten).
10. **Weiter** → den Kurzbefehl **Apps verlängern** auswählen → **Fertig**.

Nachts das iPhone **ans Ladekabel** und ins **WLAN**. Ab und zu morgens in SideStore unter **My Apps** schauen:
Dort sollten wieder **7 DAYS** stehen.

> Findest du die Aktion **LocalDevVPN** oder **Refresh All Apps** nicht? Beide Apps im App Store bzw. in
> SideStore aktualisieren. Geht es trotzdem nicht, LocalDevVPN einfach immer verbunden lassen und nur die
> SideStore-Aktion verwenden.

---

## 5. Updates

Gibt es eine neue Version, zeigt SideStore sie an:

1. **LocalDevVPN** → **Connect**.
2. **SideStore** → **My Apps** → nach unten ziehen → bei Whoop Plus auf **Update** tippen.

Deine Daten bleiben dabei erhalten. Beim nächsten Öffnen zeigt Whoop Plus kurz, **was neu ist**. Welche Version
du hast, steht in Whoop Plus ganz unten unter **Mehr**.

---

## Sicherungen und Erinnerungen – macht die App von selbst

- **Die App sichert sich jeden Tag selbst.** Die Sicherungen findest du in der **Dateien**-App unter
  **Auf meinem iPhone** → **Whoop Plus** → **Sicherungen** (immer die letzten 7 Tage). Wann zuletzt gesichert
  wurde, steht in Whoop Plus unter **Mehr** → **Daten**. Dort kannst du die neueste Sicherung auch mit einem
  Tipp wieder einspielen.
- **Die App erinnert dich rechtzeitig, falls du verlängern musst.** Nach dem ersten Verbinden mit dem Band
  fragt sie einmal, ob sie dir Mitteilungen schicken darf – bitte **Ja** und dann **Erlauben** tippen.
  Einen Tag und drei Stunden vor Ablauf kommt dann: „Whoop Plus läuft bald ab – Öffne SideStore und tippe auf
  Aktualisieren“. Bis wann die App gerade gültig ist, steht unter **Mehr**. Hast du schon verlängert (z. B.
  automatisch über den Kurzbefehl), kannst du die Erinnerung einfach antippen – die App merkt es sich dann.

> Die Sicherungen liegen in der App. Wird Whoop Plus gelöscht, sind sie mit weg – für einen Umzug die neueste
> Datei vorher z. B. nach iCloud Drive kopieren (in der Dateien-App lange drücken → **Kopieren**).

---

## 6. Wenn etwas nicht geht

**Whoop Plus oder SideStore startet nicht mehr.**
Wahrscheinlich sind die 7 Tage abgelaufen. **LocalDevVPN** → **Connect**, dann **SideStore** → **My Apps** →
**Refresh All**. Startet SideStore selbst nicht mehr, muss es noch einmal mit dem PC eingerichtet werden
(Abschnitt 2, Schritte 3–10). **Deine Whoop-Plus-Daten bleiben dabei erhalten.**

**SideStore meldet einen Fehler mit „Connection“, „VPN“ oder „Wi-Fi“.**
WLAN an? **LocalDevVPN** auf **Connect**? Beide Apps einmal ganz schließen und neu öffnen. Hilft das nicht
(oft nach einem iOS-Update): einmal mit dem PC die „Kopplung erneuern“ – Schritt für Schritt in
[TECHNIK.md unter „Pairing-Datei ersetzen“](TECHNIK.md#8-fehlerbehebung). Dauert etwa 2 Minuten.

**Das Band wird nicht gefunden.**
Offizielle WHOOP-App schließen, Band laden und näher ans iPhone legen. In **Einstellungen** → **Bluetooth** beim
WHOOP-Band auf **ⓘ** → **Dieses Gerät ignorieren**, dann in Whoop Plus erneut **Band verbinden**.

**Ich sehe kein Update.**
In SideStore unter **My Apps** nach unten ziehen. Eine neue Version braucht nach dem Erscheinen ein paar Minuten,
bis sie angezeigt wird.

**Ich bekomme ein neues iPhone.**
Vorher in Whoop Plus: **Mehr** → **Daten** → **Exportieren** und die Datei z. B. in iCloud Drive sichern
(oder die neueste Datei aus **Dateien** → **Auf meinem iPhone** → **Whoop Plus** → **Sicherungen** dorthin kopieren). Auf dem
neuen iPhone alles ab Abschnitt 2 einrichten und die Datei mit **Einspielen** zurückholen.

> **Wichtig:** Whoop Plus **nie löschen** – dabei gehen alle gespeicherten Werte verloren. Abgelaufen ist nicht
> schlimm: verlängern, und alles ist wieder da.

---

Mehr Details (für Neugierige und Fehlersuche): [TECHNIK.md](TECHNIK.md)
