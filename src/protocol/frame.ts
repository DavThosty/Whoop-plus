// Rahmenformat:
//   [0xAA][len u16 LE][crc8(len)][inner, mit 0x00 auf Vielfaches von 4 aufgefüllt][crc32(inner) u32 LE]
//   len = Länge(inner aufgefüllt) + 4  →  Gesamtlänge = len + 4

import { crc32, crc8 } from './crc';
import { MAX_FRAME_LEN, SOF } from './constants';

/** Kleinste sinnvolle Länge: 4 Byte inner (type, seq, opcode, ≥1 Nutzbyte/Padding) + 4 Byte CRC32. */
const MIN_FRAME_LEN = 8;

/** Baut einen vollständigen Rahmen um `inner` (Pakettyp + Inhalt). */
export function buildFrame(inner: ArrayLike<number>): Uint8Array {
  const padded = Math.ceil(inner.length / 4) * 4 || 4;
  const len = padded + 4;
  if (len > MAX_FRAME_LEN) throw new RangeError(`Rahmen zu lang: ${len}`);
  const out = new Uint8Array(len + 4);
  out[0] = SOF;
  out[1] = len & 0xff;
  out[2] = len >> 8;
  out[3] = crc8(out, 1, 3);
  out.set(inner, 4);
  const c = crc32(out, 4, 4 + padded);
  new DataView(out.buffer).setUint32(4 + padded, c, true);
  return out;
}

/**
 * Setzt Rahmen aus beliebig zerstückelten Notifications wieder zusammen.
 *
 * Regeln: Rahmen werden über die deklarierte Länge abgegrenzt (nicht über 0xAA – das
 * kommt auch im Inhalt vor). Die Länge wird erst nach bestandener CRC8 akzeptiert, bei
 * CRC32-Fehler wird ab dem nächsten Byte neu synchronisiert, 0x00-Füllbytes und anderer
 * Müll zwischen Rahmen werden übersprungen.
 */
export class FrameReassembler {
  private buf = new Uint8Array(1024);
  private start = 0;
  private end = 0;
  /** Anzahl verworfener Bytes/Rahmen (Diagnose). */
  droppedBytes = 0;
  badFrames = 0;

  /** Neue Daten anhängen; liefert alle vollständig validierten inner-Payloads (inkl. Padding). */
  push(chunk: Uint8Array): Uint8Array[] {
    this.append(chunk);
    const out: Uint8Array[] = [];
    const b = this.buf;
    while (true) {
      // Bis zum nächsten Rahmenanfang vorspulen.
      while (this.start < this.end && b[this.start] !== SOF) {
        this.start++;
        this.droppedBytes++;
      }
      const avail = this.end - this.start;
      if (avail < 4) break;
      const s = this.start;
      const len = b[s + 1]! | (b[s + 2]! << 8);
      if (crc8(b, s + 1, s + 3) !== b[s + 3] || len < MIN_FRAME_LEN || len > MAX_FRAME_LEN) {
        this.start++; // falsches 0xAA – weitersuchen
        this.droppedBytes++;
        continue;
      }
      if (avail < len + 4) break; // auf weitere Fragmente warten
      const want =
        (b[s + len]! | (b[s + len + 1]! << 8) | (b[s + len + 2]! << 16) | (b[s + len + 3]! << 24)) >>> 0;
      if (crc32(b, s + 4, s + len) !== want) {
        this.badFrames++;
        this.start++; // Resync ab dem nächsten 0xAA
        this.droppedBytes++;
        continue;
      }
      out.push(b.slice(s + 4, s + len));
      this.start = s + len + 4;
    }
    if (this.start === this.end) this.start = this.end = 0;
    return out;
  }

  /** Puffer verwerfen (z. B. nach einem Verbindungsabbruch). */
  reset(): void {
    this.start = this.end = 0;
  }

  /** Noch nicht verarbeitete Bytes. */
  get pending(): number {
    return this.end - this.start;
  }

  private append(chunk: Uint8Array): void {
    const live = this.end - this.start;
    if (this.end + chunk.length > this.buf.length) {
      if (live + chunk.length <= this.buf.length && this.start > 0) {
        this.buf.copyWithin(0, this.start, this.end);
      } else {
        const nb = new Uint8Array(Math.max(this.buf.length * 2, live + chunk.length));
        nb.set(this.buf.subarray(this.start, this.end));
        this.buf = nb;
      }
      this.start = 0;
      this.end = live;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }
}
