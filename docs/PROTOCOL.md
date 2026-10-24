# WHOOP 4.0 – BLE-Protokoll (so wie Whoop-plus es nutzt)

Kurzreferenz für `src/protocol/` und `src/ble/whoop.ts`. Alle Mehrbyte-Werte sind little-endian.
„inner“ bezeichnet die Bytes nach dem 4-Byte-Rahmenkopf, beginnend mit dem Pakettyp
(Rahmen-Offset = inner-Offset + 4).

## Quellen

Die Protokollfakten stammen aus öffentlichem Reverse Engineering. Danke an:

- **OpenStrap** (Dart, AGPL) – Datensatz-Layouts, HR-Offsets je Layout-Version, Ereignis-Bodies
- **NOOP** (Swift, PolyForm Noncommercial) – Verbindungsablauf, HISTORY_END-Layout, Hello-Seriennummer, Wecker/Haptik, Datenbereich
- **whoop-rs** (Rust, Apache-2.0) – Offload-Zustandsmaschine („erst speichern, dann bestätigen“)
- **my-whoop** – Protokoll-JSON und Befunde
- **bWanShiTong, „Reverse engineering WHOOP“** (Blog) – Mitschnitte von Kommandos, Echtzeit-, Verlaufs-, Metadaten- und Ereignispaketen; diese dienen in `protocol.test.ts` als Testvektoren

Es wurde kein Code aus den AGPL-/Noncommercial-Projekten übernommen; die Implementierung ist eigenständig.

## GATT

| Rolle | UUID | Art |
|---|---|---|
| Dienst | `61080001-8d6d-82b8-614a-1c8cb0f8dcc6` | – |
| CMD_TO_STRAP | `61080002-…` | Schreiben **mit Antwort** |
| CMD_FROM_STRAP | `61080003-…` | Notify (Antworten 0x24) |
| EVENTS_FROM_STRAP | `61080004-…` | Notify (Ereignisse 0x30) |
| DATA_FROM_STRAP | `61080005-…` | Notify (Echtzeit, Verlauf, Metadaten, Logs) – **fragmentiert** |
| MEMFAULT | `61080007-…` | Notify (ignoriert) |

Zusätzlich Standarddienste: Heart Rate `0x180D/0x2A37` (funktioniert ungekoppelt, muss aber mit
Kommando `0x0E` aktiviert werden, das im NV-Speicher bleibt – Whoop-plus sendet es nie automatisch),
Battery `0x180F/0x2A19` (liefert evtl. konstant 100).

Der eigene Dienst verlangt eine Kopplung (Bond). Auf iOS löst der **erste Schreibzugriff mit Antwort**
den Kopplungsdialog aus; ohne Bond werden Kommandos stillschweigend verworfen. Die offizielle App darf
nicht gleichzeitig verbunden sein (nur ein Bond).

## Rahmen

```
[0xAA][len u16][crc8(len)][inner, mit 0x00 auf Vielfaches von 4 aufgefüllt][crc32(inner) u32]
len = Länge(inner aufgefüllt) + 4      Gesamtlänge = len + 4
inner = [Pakettyp][seq][opcode/untertyp][Nutzdaten…]
```

- CRC8: Polynom 0x07, Init 0, nicht reflektiert, nur über die zwei Längenbytes.
- CRC32: zlib/IEEE über das aufgefüllte inner.
- Zusammensetzen (`FrameReassembler`): Rahmen über die deklarierte Länge abgrenzen, **nicht** an jedem
  0xAA neu beginnen (kommt im Inhalt vor). Länge erst nach gültiger CRC8 glauben, Obergrenze 4096.
  Bei CRC32-Fehler ab dem nächsten 0xAA neu synchronisieren, 0x00-Füllbytes überspringen.

Pakettypen: `0x23` Kommando, `0x24` Antwort, `0x28` Echtzeit-HR, `0x2B` Rohdaten, `0x2F` Verlauf,
`0x30` Ereignis, `0x31` Metadaten, `0x32` Konsolen-Log, `0x33/0x34` IMU.

## Kommandos

inner = `[0x23][seq][opcode][payload]`. Antwort `0x24`: `[1]` Band-Seq, `[2]` Opcode, `[3]` Seq der
Anfrage, `[4]` Ergebnis (0 Fehler, 1 OK, 2 ausstehend – finale Antwort folgt, 3 nicht unterstützt),
Body ab `[5]`. Zuordnung über (Opcode, Seq der Anfrage).

| Opcode | Name | Payload | Nutzung |
|---|---|---|---|
| 0x01 | LINK_VALID | `00` | Keepalive alle 10 s |
| 0x03 | TOGGLE_REALTIME_HR | `01`/`00` | Echtzeit-Puls ~1 Hz auf 0005 |
| 0x0A | SET_CLOCK | u32 s + u32 Subsek. (1/32768 s) | jede Verbindung, danach GET_CLOCK prüfen |
| 0x0B | GET_CLOCK | – | Antwort: u32 s @body[0], u32 Subsek. @body[4] |
| 0x14 | ABORT_HISTORICAL_TRANSMITS | `00` | Abbruch, wenn Speichern fehlschlägt |
| 0x16 | SEND_HISTORICAL_DATA | `00` | Verlauf anfordern |
| 0x17 | HISTORICAL_DATA_RESULT | `01` + 8-Byte-Token | Block bestätigen |
| 0x1A | GET_BATTERY_LEVEL | – | u16 @body[0] / 10 = %; erster bestätigter Write (Bonding) |
| 0x22 | GET_DATA_RANGE | `00` | Rev. 1 + 16×u32; @body[25] geschätzte Anzahl Datensätze |
| 0x23 | GET_HELLO_HARVARD | `00` | Seriennummer: 9 ASCII + NUL @body[14] |
| 0x42 | SET_ALARM_TIME | `01` + u32 s + u16 Subsek. + u16 Haptik (0) | Wecker |
| 0x43 / 0x45 | GET_ALARM / DISABLE_ALARM | `01` | |
| 0x44 | RUN_ALARM | `01` | zusammen mit 0x4F für „Band finden“ |
| 0x4C | GET_ADVERTISING_NAME | `00` | |
| 0x4F | RUN_HAPTICS_PATTERN | `[Muster, Loops, 0, 0, 0]` | Muster 2 / 3 Loops |

**Niemals senden** (`NEVER_SEND`, `buildCommand` wirft): `0x0F` FORGET_BONDS, `0x19` FORCE_TRIM,
`0x1D` REBOOT, `0x20` POWER_CYCLE, `0x21` SET_READ_POINTER, `0x24–0x26` Firmware-Update, `0x99`, `0x9A`.

Die Bytes neben der Seriennummer in der Hello-Antwort sind Schlüssel-/Signaturmaterial und werden
weder geparst noch geloggt.

## Echtzeit-Puls 0x28 (inner 20 Byte)

`[1]` Rev. 2, `[2:6]` u32 Unix, `[6:8]` u16 Subsek., `[8]` HR (0 = nicht am Arm), `[9]` Anzahl RR (0–4),
`[10] [12] [14] [16]` u16 RR in ms, `[18]` Trage-Flag, `[19]` Position. Die meisten Pakete enthalten
keine RR-Werte. Akzeptiert werden RR zwischen 200 und 2500 ms.

## Verlaufsdatensatz 0x2F

| Offset | Inhalt |
|---|---|
| `[1]` | Layout-Version (meist 24 oder 12; auch 7/9/18/25) |
| `[3:7]` | u32 Datensatzzähler |
| `[7:11]` | u32 Unix-Sekunden |
| `[11:13]` | u16 Subsekunden |
| `[17]` | HR (v9/12/24); v7: `[27]`, v18: `[14]` |
| `[18]` | Anzahl RR (≤ 4) – nur v9/12/24 |
| `[19..27]` | bis zu 4 × i16 RR in ms – nur v9/12/24 |
| `[29:31]` | u16 grüner PPG-Rohwert |
| `[36:48]` | 3 × f32 Schwerkraftvektor in g (liest ~4,6 % zu hoch; `[52:64]` ist eine Kopie) |

Länge: v24 ≥ 89 Byte, manche v12 senden 88; Mindestlänge für HR/RR 72 Byte. v25 (roher PPG-Burst,
ohne HR) wird übersprungen. Bei v7/v18 ist nur die HR-Position belegt; RR werden dort nicht gelesen
und die Schwerkraft nur bei plausiblem Betrag (0,5–1,8 g) übernommen. Datensätze mit Zeitstempel vor
2020 (Banduhr nicht gestellt) werden verworfen.

## Metadaten 0x31 und Ablauf der Synchronisierung

`[2]` Untertyp: 1 HISTORY_START, 2 HISTORY_END, 3 HISTORY_COMPLETE.
HISTORY_END: `[3:7]` u32 Unix, `[7:9]` Subsek., `[9:13]` u32 Paketanzahl, `[13:21]` 8-Byte-Token
(`[u32 trim_page][u32 wrap_count]`).

1. `0x16` senden.
2. Auf 0005 folgen HISTORY_START, dann Datensätze 0x2F, dann HISTORY_END mit Token.
3. Datensätze des Blocks **dauerhaft speichern** (Sink), erst danach mit `0x17` + `01` + Token
   (exakt wie empfangen) bestätigen. Das Band darf bestätigte Daten löschen; ein falsches oder
   fehlendes Token führt zur erneuten Übertragung desselben Blocks.
4. Weitere Blöcke folgen, bis HISTORY_COMPLETE kommt (nicht bestätigen). Datensätze ohne
   abschließendes HISTORY_END werden verworfen – sie kommen beim nächsten Mal wieder.
5. Schlägt das Speichern fehl: keine Bestätigung, `0x14` senden, Sync abbrechen.
6. Nach dem Verbinden automatisch und danach alle 15 Minuten wiederholen. Endet auch nach ~20 s ohne Daten.
   Das Band speichert ca. 14 Tage.

## Ereignisse 0x30 (auf 0004)

`[2:4]` u16 ID, `[4:8]` u32 Unix, `[8:10]` u16 Subsek., `[10:12]` u16 Body-Länge, Body ab `[12]`.
IDs: 3 BATTERY_LEVEL (Body: `[0]` Rev. 2, `[1]` u16 Ladezustand×10, `[5]` u16 mV, `[9]` lädt),
7/8 Laden an/aus, 9/10 angelegt/abgenommen, 13 RTC_LOST, 14 Doppeltipp, 15 Boot, 16 Uhr gestellt.

## Verbindungsablauf (WhoopDevice)

1. `requestDevice` (Filter: Dienst `61080001-…` oder Namenspräfix `WHOOP`), GATT verbinden.
2. 0003/0004/0005 abonnieren.
3. `GET_BATTERY_LEVEL` als erster bestätigter Write (Timeout 30 s wegen iOS-Kopplungsdialog).
4. `SET_CLOCK`, mit `GET_CLOCK` prüfen (Warnung bei > 5 s Abweichung).
5. Hello, Werbename, Datenbereich – einmal pro Verbindung, ~120 ms Abstand
   (erneutes Init mitten im Offload stoppte laut NOOP die Übertragung).
6. Optional Standard-HR 0x2A37 abonnieren (nur Zweitquelle, solange Echtzeit aus ist).
7. LINK_VALID alle 10 s, Verlaufs-Sync sofort und alle 15 min.

Alle Writes laufen seriell über eine Warteschlange (Web Bluetooth erlaubt keine parallelen
GATT-Operationen), bevorzugt mit `writeValueWithResponse`.

## Offene Punkte

- Das Ack-Token wird vollständig (8 Byte) zurückgeschickt, wie NOOP/whoop-rs es beschreiben; der Blog
  zeigt ein Ack mit nur den ersten 4 Byte + Nullen.
- Layout von Werbename und Firmwareversion (0x07) ist nicht vollständig belegt; die Firmware wird
  derzeit nicht ausgelesen.
- RUN_ALARM/Haptik-Muster: beobachtet funktionierend, aber Muster-IDs sind nicht dokumentiert.
- Die 9-Byte-Form von SET_CLOCK ist nach dem 4-Byte-Auffüllen identisch mit der 8-Byte-Form.
