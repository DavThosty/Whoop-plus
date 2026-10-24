# Whoop Plus

Eigene iPhone-App für das **Whoop 4.0** – ohne Abo, ohne Whoop-Cloud, ohne Server. Die App verbindet sich
per Bluetooth direkt mit dem Band, lädt den Verlauf herunter und berechnet Schlaf, HRV, Ruhepuls, Recovery,
Strain und Kalorien **lokal auf dem iPhone** mit nachvollziehbaren Formeln.

Die App ist eine native iOS-App (Capacitor). Sie wird von GitHub Actions gebaut und kostenlos mit
**SideStore** und einer normalen Apple-ID installiert – ohne Mac und ohne bezahlten Entwickler-Account.
Schritt-für-Schritt-Anleitung: **[docs/IOS.md](docs/IOS.md)**.

## Funktionen

- Live-Puls, Verlauf vom Band (ca. 14 Tage Speicher) mit Bestätigung erst nach dem Speichern
- Verbindet sich beim Öffnen und bei jeder Rückkehr in die App selbst mit dem gemerkten Band und synchronisiert;
  ist das Band nicht in Reichweite, nur ein dezenter Hinweis statt Fehlermeldung
- Live-Puls nach dem Verbinden automatisch an (abschaltbar)
- Schlaferkennung aus Armwinkel (Beschleunigung) und Puls, HRV (RMSSD), Ruhepuls
- Recovery (z-Werte gegen die eigene 30-Tage-Baseline), Strain 0–21 (Edwards-TRIMP), Kalorien (Keytel)
- Trends über 7/30/90 Tage, Vibrationswecker, „Band vibrieren“
- Alle Daten bleiben in der App auf dem iPhone; Sicherung als JSON über das Teilen-Menü

## Aufbau

| Ordner | Inhalt |
|---|---|
| `src/protocol` | Whoop-4.0-Protokoll: Framing, CRC, Befehle, Parser |
| `src/ble` | `WhoopDevice` (Verbindung, Sync, Live-Puls über die Web-Bluetooth-API), Capacitor-Adapter, Plattformwahl |
| `src/sim` | Simuliertes Band für Tests und Demo (`/?demo`) |
| `src/analytics` | Schlaf, HRV, Strain, Recovery, Kalorien + Erklärtexte |
| `src/store` | IndexedDB, Neuberechnung der Tageswerte, Export über das Teilen-Menü |
| `src/ui` | Oberfläche (Preact) |
| `ios` | Xcode-Projekt (Capacitor, Swift Package Manager) |
| `resources` | Quellen für App-Icon und Startbild |
| `.github/workflows/ios.yml` | Baut die IPA und veröffentlicht sie als Release `ios-latest` |
| `docs` | [iOS-Installation](docs/IOS.md) und [Protokoll](docs/PROTOCOL.md) |

In der App spricht `WhoopDevice` weiter die Web-Bluetooth-API; `src/ble/capacitor-bluetooth.ts` bildet sie
auf das Plugin `@capacitor-community/bluetooth-le` (CoreBluetooth) ab. Im Desktop-Browser wird echtes
Web Bluetooth verwendet (z. B. Chrome), die Demo `?demo` läuft überall.

## Entwicklung

```bash
npm install
npm run dev          # http://localhost:5173/?demo  – Demo mit simuliertem Band
npm test             # Protokoll-, BLE-, Adapter- und Analyse-Tests
npm run build        # Web-Oberfläche nach dist/
npm run ios:sync     # build + npx cap sync ios (Web-Dateien und Plugins ins Xcode-Projekt)
```

Ein Push auf `main` (oder ein manueller Start unter *Actions → iOS-Build*) baut die App auf einem
macOS-Runner und legt `WhoopPlus.ipa` in das Release **ios-latest**. Details in [docs/IOS.md](docs/IOS.md).

## Lizenz

[PolyForm Noncommercial 1.0.0](LICENSE) – Copyright (c) 2026 DavThosty.

- Private, nicht-kommerzielle Nutzung ist erlaubt: verwenden, anpassen und weitergeben, solange die
  Lizenzbedingungen und der Hinweis „Required Notice“ mitgegeben werden.
- **Kommerzielle Nutzung ist verboten** (z. B. Verkauf, Einbau in kommerzielle Produkte oder Dienste).
- Kein offizielles WHOOP-Produkt; nicht mit WHOOP, Inc. verbunden. „WHOOP“ ist eine Marke ihres Inhabers.
  Keine Medizin-App – alle Werte sind Schätzungen ohne Gewähr.

## Danke

Das Protokoll wurde von der Community entschlüsselt – u. a. OpenStrap, NOOP, whoop-rs, my-whoop und
der Reverse-Engineering-Bericht von bWanShiTong. Dieser Code ist eine eigene Implementierung.
