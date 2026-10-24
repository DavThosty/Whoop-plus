// Kommandos App → Band: inner = [0x23][seq][opcode][payload…], dann buildFrame().

import { NEVER_SEND, Opcode, PacketType } from './constants';
import { buildFrame } from './frame';

/** Baut einen Kommandorahmen. Wirft bei gefährlichen Opcodes (NEVER_SEND). */
export function buildCommand(seq: number, opcode: number, payload: ArrayLike<number> = []): Uint8Array {
  if (NEVER_SEND.has(opcode)) {
    throw new Error(`Opcode 0x${opcode.toString(16).padStart(2, '0')} ist gesperrt (NEVER_SEND)`);
  }
  const inner = new Uint8Array(3 + payload.length);
  inner[0] = PacketType.COMMAND;
  inner[1] = seq & 0xff;
  inner[2] = opcode & 0xff;
  inner.set(payload, 3);
  return buildFrame(inner);
}

function u32le(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Zerlegt einen Zeitpunkt (ms) in Unix-Sekunden + Subsekunden in 1/32768 s (RTC-Takt). */
export function toStrapTime(ms: number): { sec: number; subsec: number } {
  const sec = Math.floor(ms / 1000);
  const subsec = Math.floor(((ms - sec * 1000) * 32768) / 1000);
  return { sec, subsec };
}

/** Keepalive, alle ~10 s. */
export const linkValid = (seq: number) => buildCommand(seq, Opcode.LINK_VALID, [0]);

/** Echtzeit-Puls (Pakete 0x28, ~1 Hz) ein/aus. */
export const toggleRealtimeHr = (seq: number, on: boolean) =>
  buildCommand(seq, Opcode.TOGGLE_REALTIME_HR, [on ? 1 : 0]);

/**
 * Uhr stellen: u32 Sekunden + u32 Subsekunden (1/32768 s; obere 2 Bytes 0) = 8 Bytes.
 * `legacy9` hängt ein zusätzliches Nullbyte an (9-Byte-Form, die manche Firmware erwartet).
 */
export function setClock(seq: number, date: Date | number, legacy9 = false): Uint8Array {
  const ms = typeof date === 'number' ? date : date.getTime();
  const { sec, subsec } = toStrapTime(ms);
  const p = [...u32le(sec), ...u32le(subsec)];
  if (legacy9) p.push(0);
  return buildCommand(seq, Opcode.SET_CLOCK, p);
}

export const getClock = (seq: number) => buildCommand(seq, Opcode.GET_CLOCK);
export const getBattery = (seq: number) => buildCommand(seq, Opcode.GET_BATTERY_LEVEL);
export const sendHistoricalData = (seq: number) => buildCommand(seq, Opcode.SEND_HISTORICAL_DATA, [0]);
export const abortHistorical = (seq: number) => buildCommand(seq, Opcode.ABORT_HISTORICAL_TRANSMITS, [0]);

/** Bestätigung eines Verlaufsblocks: 01 + das 8-Byte-Token aus HISTORY_END, unverändert. */
export function historyAck(seq: number, token: ArrayLike<number>): Uint8Array {
  if (token.length !== 8) throw new RangeError('Token muss 8 Bytes lang sein');
  return buildCommand(seq, Opcode.HISTORICAL_DATA_RESULT, [1, ...Array.from(token)]);
}

export const getHello = (seq: number) => buildCommand(seq, Opcode.GET_HELLO_HARVARD, [0]);
export const getAdvertisingName = (seq: number) => buildCommand(seq, Opcode.GET_ADVERTISING_NAME, [0]);
export const getDataRange = (seq: number) => buildCommand(seq, Opcode.GET_DATA_RANGE, [0]);
export const getAlarm = (seq: number) => buildCommand(seq, Opcode.GET_ALARM_TIME, [1]);
export const disableAlarm = (seq: number) => buildCommand(seq, Opcode.DISABLE_ALARM, [1]);
export const runAlarm = (seq: number) => buildCommand(seq, Opcode.RUN_ALARM, [1]);

/** Wecker (Rev. 1, 9 Bytes): 01 + u32 Sekunden + u16 Subsekunden + u16 Haptikmodus (0). */
export function setAlarm(seq: number, unixSec: number, subsec = 0, hapticMode = 0): Uint8Array {
  return buildCommand(seq, Opcode.SET_ALARM_TIME, [
    1,
    ...u32le(unixSec),
    subsec & 0xff,
    (subsec >> 8) & 0xff,
    hapticMode & 0xff,
    (hapticMode >> 8) & 0xff,
  ]);
}

/** Vibrationsmuster: [Muster, Wiederholungen, 0, 0, 0]. Muster 2 / 3 Loops ist beobachtet funktionierend. */
export const runHaptics = (seq: number, pattern = 2, loops = 3) =>
  buildCommand(seq, Opcode.RUN_HAPTICS_PATTERN, [pattern, loops, 0, 0, 0]);

/** Init-Folge der offiziellen App (nur zu Dokumentations-/Testzwecken; WhoopDevice nutzt die ersten drei). */
export function initPackets(firstSeq = 0): Uint8Array[] {
  return [getHello, getAdvertisingName, getDataRange, getAlarm, sendHistoricalData].map((f, i) =>
    f((firstSeq + i) & 0xff),
  );
}
