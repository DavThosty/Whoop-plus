# Whoop Plus

Eigene App für das **Whoop 4.0** – ohne Abo, ohne Whoop-Cloud. Die Web-App verbindet sich per Web Bluetooth
direkt mit dem Band (auf dem iPhone über den Browser **Bluefy**), lädt den Verlauf herunter und berechnet
Schlaf, HRV, Ruhepuls, Recovery, Strain und Kalorien **lokal auf dem Gerät** mit nachvollziehbaren Formeln.

## Funktionen

- Live-Puls, Verlauf vom Band (ca. 14 Tage Speicher) mit Bestätigung erst nach dem Speichern
- Schlaferkennung aus Armwinkel (Beschleunigung) und Puls, HRV (RMSSD), Ruhepuls
- Recovery (z-Werte gegen die eigene 30-Tage-Baseline), Strain 0–21 (Edwards-TRIMP), Kalorien (Keytel)
- Trends über 7/30/90 Tage, Vibrationswecker, „Band vibrieren“
- Alle Daten bleiben in IndexedDB auf dem iPhone
- Zugang nur für dein Gerät: Passkey-Registrierung mit Einrichtungscode, danach gesperrt; Kopplungslink für Bluefy

## Aufbau

| Ordner | Inhalt |
|---|---|
| `src/protocol` | Whoop-4.0-Protokoll: Framing, CRC, Befehle, Parser |
| `src/ble` | `WhoopDevice` – Verbindung, Sync, Live-Puls über Web Bluetooth |
| `src/sim` | Simuliertes Band für Tests und Demo (`/?demo`) |
| `src/analytics` | Schlaf, HRV, Strain, Recovery, Kalorien + Erklärtexte |
| `src/store` | IndexedDB und Neuberechnung der Tageswerte |
| `src/ui` | Oberfläche (Preact) |
| `server` | Passkey-Login, Kopplungslinks, Auslieferung der App |
| `docs` | [Deployment](docs/DEPLOY.md) und [Protokoll](docs/PROTOCOL.md) |

## Entwicklung

```bash
npm install
npm run dev          # http://localhost:5173/?demo  – Demo mit simuliertem Band
npm test             # Protokoll-, BLE- und Analyse-Tests
npm run build
npm install --prefix server && npm test --prefix server
```

Deployment über Portainer + Nginx Proxy Manager: siehe [docs/DEPLOY.md](docs/DEPLOY.md).

## Danke

Das Protokoll wurde von der Community entschlüsselt – u. a. OpenStrap, NOOP, whoop-rs, my-whoop und
der Reverse-Engineering-Bericht von bWanShiTong. Dieser Code ist eine eigene Implementierung.
Kein offizielles Whoop-Produkt.
