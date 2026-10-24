// Parser für die inner-Payloads, die FrameReassembler liefert (inner[0] = Pakettyp).
// Alle Offsets beziehen sich auf inner (= Rahmen-Offset − 4), little-endian.

import type { LiveHr, SampleRecord } from '../types';
import { CommandResult, EVENT_NAMES, EventId, MetadataType, PacketType, RR_MAX_MS, RR_MIN_MS } from './constants';

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function acceptRr(ms: number): boolean {
  return ms >= RR_MIN_MS && ms <= RR_MAX_MS;
}

// ---------------------------------------------------------------------------
// Kommandoantworten 0x24

export interface CommandResponse {
  /** Laufende Nummer des Bands (nicht zur Zuordnung verwenden). */
  strapSeq: number;
  /** Gespiegelter Opcode. */
  opcode: number;
  /** Sequenznummer des auslösenden Kommandos – Zuordnung über (opcode, originSeq). */
  originSeq: number;
  /** 0 Fehler, 1 OK, 2 ausstehend (finale Antwort folgt), 3 nicht unterstützt. */
  result: number;
  /** Nutzdaten ab inner[5]. */
  body: Uint8Array;
}

export function parseCommandResponse(inner: Uint8Array): CommandResponse | null {
  if (inner.length < 5 || inner[0] !== PacketType.COMMAND_RESPONSE) return null;
  return {
    strapSeq: inner[1]!,
    opcode: inner[2]!,
    originSeq: inner[3]!,
    result: inner[4]!,
    body: inner.subarray(5),
  };
}

/** GET_BATTERY_LEVEL: u16 an body[0] in Zehntelprozent. */
export function parseBattery(resp: CommandResponse): number | null {
  if (resp.result !== CommandResult.OK || resp.body.length < 2) return null;
  const pct = dv(resp.body).getUint16(0, true) / 10;
  return pct >= 0 && pct <= 100 ? pct : null;
}

/** GET_CLOCK: u32 Sekunden an body[0], u32 Subsekunden (1/32768 s) an body[4]. */
export function parseClock(resp: CommandResponse): { sec: number; subsec: number } | null {
  if (resp.result !== CommandResult.OK || resp.body.length < 4) return null;
  const v = dv(resp.body);
  return { sec: v.getUint32(0, true), subsec: resp.body.length >= 8 ? v.getUint32(4, true) : 0 };
}

/**
 * GET_HELLO_HARVARD: Seriennummer = 9 ASCII-Zeichen + NUL an body[14] (inner[19]).
 * Die benachbarten Bytes sind Schlüsselmaterial – sie werden weder geparst noch zurückgegeben.
 */
export function parseHello(resp: CommandResponse): { serial?: string } {
  const b = resp.body;
  if (resp.result !== CommandResult.OK || b.length < 24) return {};
  let s = '';
  for (let i = 14; i < 23; i++) {
    const c = b[i]!;
    const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (!ok) return {};
    s += String.fromCharCode(c);
  }
  return b[23] === 0 ? { serial: s } : {};
}

/** GET_ADVERTISING_NAME: Layout nicht vollständig dokumentiert – längste druckbare ASCII-Folge (best effort). */
export function parseAdvertisingName(resp: CommandResponse): string | null {
  if (resp.result !== CommandResult.OK) return null;
  let best = '';
  let cur = '';
  for (const c of resp.body) {
    if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
    else {
      if (cur.length > best.length) best = cur;
      cur = '';
    }
  }
  if (cur.length > best.length) best = cur;
  best = best.trim();
  return best.length >= 3 && best.length <= 32 ? best : null;
}

/**
 * GET_DATA_RANGE (best effort, nach NOOP-Doku): Revision 1 + 16 × u32.
 * body[25] ist eine Schätzung der gespeicherten Datensätze.
 */
export function parseDataRange(resp: CommandResponse): { recordEstimate: number } | null {
  if (resp.result !== CommandResult.OK || resp.body.length < 29 || resp.body[0] !== 1) return null;
  return { recordEstimate: dv(resp.body).getUint32(25, true) };
}

// ---------------------------------------------------------------------------
// Echtzeit-Puls 0x28 (inner 20 Bytes)
// [1] Rev, [2:6] u32 Unix, [6:8] u16 Subsek., [8] HR (0 = nicht am Arm), [9] Anzahl RR 0–4,
// [10],[12],[14],[16] u16 RR ms, [18] Trage-Flag, [19] Position

export function parseRealtimeHr(inner: Uint8Array): LiveHr | null {
  if (inner.length < 10 || inner[0] !== PacketType.REALTIME_DATA) return null;
  const v = dv(inner);
  const ts = v.getUint32(2, true);
  const hr = inner[8]!;
  const n = Math.min(inner[9]!, 4);
  const rr: number[] = [];
  for (let i = 0; i < n && 12 + 2 * i <= inner.length; i++) {
    const ms = v.getUint16(10 + 2 * i, true);
    if (acceptRr(ms)) rr.push(ms);
  }
  const wearing = inner.length > 18 ? inner[18] !== 0 : hr > 0;
  return { ts, hr, rr, wearing };
}

// ---------------------------------------------------------------------------
// Verlaufsdatensatz 0x2F
// [1] Layout-Version, [3:7] u32 Zähler, [7:11] u32 Unix, [11:13] u16 Subsek.
// HR: inner[17] (v9/12/24), inner[27] (v7), inner[14] (v18).
// RR (nur v9/12/24): [18] Anzahl ≤ 4, ab [19] i16 ms. Schwerkraft: 3 × f32 an [36:48].

const HR_OFFSET: Readonly<Record<number, number>> = { 7: 27, 9: 17, 12: 17, 18: 14, 24: 17 };
/** Layouts, deren RR-/Schwerkraft-Felder bestätigt sind. Bei v7/v18 ist nur die HR-Position belegt. */
const FULL_LAYOUT = new Set([9, 12, 24]);
/** Mindestlänge (v24 hat ≥ 89, manche v12 senden 88; Rückfall 72 für HR/RR). */
const MIN_RECORD_LEN = 72;
const GRAVITY_END = 48;

export interface ParsedHistoryRecord extends SampleRecord {
  version: number;
  counter: number;
}

export function parseHistoryRecord(inner: Uint8Array): ParsedHistoryRecord | null {
  if (inner.length < 13 || inner[0] !== PacketType.HISTORICAL_DATA) return null;
  const version = inner[1]!;
  const hrAt = HR_OFFSET[version];
  // v25 (roher PPG-Burst ohne HR) und unbekannte Layouts werden übersprungen.
  if (hrAt === undefined || inner.length < MIN_RECORD_LEN) return null;
  const v = dv(inner);
  const counter = v.getUint32(3, true);
  const ts = v.getUint32(7, true);
  const hr = inner[hrAt]!;
  const rec: ParsedHistoryRecord = { ts, hr, rr: [], src: 'history', version, counter };

  if (FULL_LAYOUT.has(version)) {
    const n = inner[18]!;
    if (n <= 4) {
      for (let i = 0; i < n; i++) {
        const ms = v.getInt16(19 + 2 * i, true);
        if (acceptRr(ms)) rec.rr.push(ms);
      }
    }
  }

  if (inner.length >= GRAVITY_END) {
    const g: [number, number, number] = [v.getFloat32(36, true), v.getFloat32(40, true), v.getFloat32(44, true)];
    const finite = g.every((x) => Number.isFinite(x) && Math.abs(x) < 16);
    const mag = Math.hypot(g[0], g[1], g[2]);
    // Bei v7/v18 ist die Position nicht bestätigt → nur übernehmen, wenn |g| plausibel (0,5–1,8 g).
    const plausible = FULL_LAYOUT.has(version) ? finite : finite && mag >= 0.5 && mag <= 1.8;
    if (plausible) rec.grav = [round4(g[0]), round4(g[1]), round4(g[2])];
  }
  return rec;
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** Nur das SampleRecord (ohne Diagnosefelder). */
export function toSampleRecord(r: ParsedHistoryRecord): SampleRecord {
  const s: SampleRecord = { ts: r.ts, hr: r.hr, rr: r.rr, src: 'history' };
  if (r.grav) s.grav = r.grav;
  return s;
}

// ---------------------------------------------------------------------------
// Metadaten 0x31: [2] Untertyp; HISTORY_END: [3:7] Unix, [7:9] Subsek., [9:13] u32 erwartete
// Paketanzahl, [13:21] 8-Byte-Token ([u32 trim_page][u32 wrap_count]) – unverändert zurückschicken.

export interface Metadata {
  subtype: number;
  ts: number;
  expectedCount?: number;
  token?: Uint8Array;
}

export function parseMetadata(inner: Uint8Array): Metadata | null {
  if (inner.length < 3 || inner[0] !== PacketType.METADATA) return null;
  const subtype = inner[2]!;
  const v = dv(inner);
  const m: Metadata = { subtype, ts: inner.length >= 7 ? v.getUint32(3, true) : 0 };
  if (subtype === MetadataType.HISTORY_END && inner.length >= 21) {
    m.expectedCount = v.getUint32(9, true);
    m.token = inner.slice(13, 21);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Ereignisse 0x30: [2:4] u16 ID, [4:8] u32 Unix, [8:10] u16 Subsek., [10:12] u16 Body-Länge, Body ab [12]

export interface StrapEvent {
  id: number;
  name: string;
  ts: number;
  body: Uint8Array;
  battery?: { percent: number; mV: number; charging: boolean };
  charging?: boolean;
  wrist?: boolean;
}

export function parseEvent(inner: Uint8Array): StrapEvent | null {
  if (inner.length < 4 || inner[0] !== PacketType.EVENT) return null;
  const v = dv(inner);
  const id = v.getUint16(2, true);
  const ts = inner.length >= 8 ? v.getUint32(4, true) : 0;
  let body = new Uint8Array(0);
  if (inner.length >= 12) {
    const end = Math.min(inner.length, 12 + v.getUint16(10, true));
    body = inner.slice(12, end);
  }
  const ev: StrapEvent = { id, name: EVENT_NAMES[id] ?? `EVENT_${id}`, ts, body };
  switch (id) {
    case EventId.BATTERY_LEVEL:
      // Body: [0] Rev 2, [1] u16 Ladezustand × 10, [5] u16 mV, [9] Lade-Flag.
      if (body.length >= 10) {
        const bv = dv(body);
        const percent = bv.getUint16(1, true) / 10;
        if (percent >= 0 && percent <= 100) {
          ev.battery = { percent, mV: bv.getUint16(5, true), charging: body[9] !== 0 };
        }
      }
      break;
    case EventId.CHARGING_ON:
    case EventId.CHARGING_OFF:
      ev.charging = id === EventId.CHARGING_ON;
      break;
    case EventId.WRIST_ON:
    case EventId.WRIST_OFF:
      ev.wrist = id === EventId.WRIST_ON;
      break;
  }
  return ev;
}

// ---------------------------------------------------------------------------
// Standard-Herzfrequenzmessung 0x2A37

export interface StandardHr {
  hr: number;
  rr: number[];
  /** undefined, wenn das Gerät keinen Hautkontakt meldet. */
  contact?: boolean;
}

export function parseStandardHrMeasurement(view: DataView): StandardHr | null {
  if (view.byteLength < 2) return null;
  const flags = view.getUint8(0);
  let o = 1;
  let hr: number;
  if (flags & 0x01) {
    if (view.byteLength < 3) return null;
    hr = view.getUint16(o, true);
    o += 2;
  } else {
    hr = view.getUint8(o);
    o += 1;
  }
  const res: StandardHr = { hr, rr: [] };
  if (flags & 0x04) res.contact = (flags & 0x02) !== 0;
  if (flags & 0x08) o += 2; // Energy Expended
  if (flags & 0x10) {
    for (; o + 2 <= view.byteLength; o += 2) {
      const ms = Math.round((view.getUint16(o, true) * 1000) / 1024);
      if (acceptRr(ms)) res.rr.push(ms);
    }
  }
  return res;
}
