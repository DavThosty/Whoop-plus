// Konstanten des WHOOP-4.0-BLE-Protokolls (siehe docs/PROTOCOL.md).

export const SERVICE = '61080001-8d6d-82b8-614a-1c8cb0f8dcc6';
/** App → Band, Schreiben mit Antwort (der erste bestätigte Write löst das iOS-Bonding aus). */
export const CMD_TO_STRAP = '61080002-8d6d-82b8-614a-1c8cb0f8dcc6';
/** Band → App: Antworten auf Kommandos (Pakettyp 0x24). */
export const CMD_FROM_STRAP = '61080003-8d6d-82b8-614a-1c8cb0f8dcc6';
/** Band → App: Ereignisse (Pakettyp 0x30). */
export const EVENTS_FROM_STRAP = '61080004-8d6d-82b8-614a-1c8cb0f8dcc6';
/** Band → App: Echtzeit, Verlauf, Metadaten, Konsolen-Logs – über mehrere Notifications fragmentiert. */
export const DATA_FROM_STRAP = '61080005-8d6d-82b8-614a-1c8cb0f8dcc6';
/** Memfault-Diagnose (optional, wird ignoriert). */
export const MEMFAULT = '61080007-8d6d-82b8-614a-1c8cb0f8dcc6';

/** Standard-GATT-Dienste (Web-Bluetooth-Namen). */
export const HEART_RATE_SERVICE = 'heart_rate';
export const HEART_RATE_MEASUREMENT = 'heart_rate_measurement';
export const BATTERY_SERVICE = 'battery_service';

export const SOF = 0xaa;
/** Obergrenze für das deklarierte Längenfeld; alles darüber gilt als Fehlsynchronisation. */
export const MAX_FRAME_LEN = 4096;

export const PacketType = {
  COMMAND: 0x23,
  COMMAND_RESPONSE: 0x24,
  REALTIME_DATA: 0x28,
  REALTIME_RAW_DATA: 0x2b,
  HISTORICAL_DATA: 0x2f,
  EVENT: 0x30,
  METADATA: 0x31,
  CONSOLE_LOGS: 0x32,
  REALTIME_IMU: 0x33,
  HISTORICAL_IMU: 0x34,
} as const;

export const Opcode = {
  LINK_VALID: 0x01,
  TOGGLE_REALTIME_HR: 0x03,
  REPORT_VERSION_INFO: 0x07,
  SET_CLOCK: 0x0a,
  GET_CLOCK: 0x0b,
  /** Wird im NV-Speicher persistiert – niemals automatisch senden. */
  SET_GENERIC_HR_PROFILE: 0x0e,
  ABORT_HISTORICAL_TRANSMITS: 0x14,
  SEND_HISTORICAL_DATA: 0x16,
  HISTORICAL_DATA_RESULT: 0x17,
  GET_BATTERY_LEVEL: 0x1a,
  GET_DATA_RANGE: 0x22,
  GET_HELLO_HARVARD: 0x23,
  SET_ALARM_TIME: 0x42,
  GET_ALARM_TIME: 0x43,
  RUN_ALARM: 0x44,
  DISABLE_ALARM: 0x45,
  GET_ADVERTISING_NAME: 0x4c,
  RUN_HAPTICS_PATTERN: 0x4f,
} as const;

/**
 * Gefährliche Opcodes (Bonds löschen, Neustart, Lesezeiger setzen, Firmware-Update …).
 * buildCommand() wirft, wenn einer davon verwendet wird.
 */
export const NEVER_SEND: ReadonlySet<number> = new Set([
  0x0f, // FORGET_BONDS
  0x19, // FORCE_TRIM (löscht Verlauf)
  0x1d, // REBOOT
  0x20, // POWER_CYCLE
  0x21, // SET_READ_POINTER
  0x24, // Firmware-Update
  0x25, // Firmware-Update
  0x26, // Firmware-Update
  0x99,
  0x9a,
]);

/** Untertyp der Metadaten-Pakete (0x31), inner[2]. */
export const MetadataType = {
  HISTORY_START: 1,
  HISTORY_END: 2,
  HISTORY_COMPLETE: 3,
} as const;

/** Ergebnis-Byte einer Kommandoantwort, inner[4]. */
export const CommandResult = {
  FAIL: 0,
  OK: 1,
  PENDING: 2,
  UNSUPPORTED: 3,
} as const;

/** Ereignis-IDs (u16 an inner[2]) der Pakete 0x30. */
export const EventId = {
  BATTERY_LEVEL: 3,
  CHARGING_ON: 7,
  CHARGING_OFF: 8,
  WRIST_ON: 9,
  WRIST_OFF: 10,
  RTC_LOST: 13,
  DOUBLE_TAP: 14,
  BOOT: 15,
  SET_RTC: 16,
} as const;

export const EVENT_NAMES: Readonly<Record<number, string>> = {
  3: 'BATTERY_LEVEL',
  7: 'CHARGING_ON',
  8: 'CHARGING_OFF',
  9: 'WRIST_ON',
  10: 'WRIST_OFF',
  13: 'RTC_LOST',
  14: 'DOUBLE_TAP',
  15: 'BOOT',
  16: 'SET_RTC',
};

/** Plausibler Bereich für R-R-Intervalle in ms. */
export const RR_MIN_MS = 200;
export const RR_MAX_MS = 2500;
