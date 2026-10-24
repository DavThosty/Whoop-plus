import { describe, expect, it } from 'vitest';
import { crc32, crc8 } from './crc';
import { MetadataType, NEVER_SEND, Opcode, PacketType } from './constants';
import { buildFrame, FrameReassembler } from './frame';
import * as cmd from './commands';
import {
  parseBattery,
  parseClock,
  parseCommandResponse,
  parseEvent,
  parseHello,
  parseHistoryRecord,
  parseMetadata,
  parseRealtimeHr,
  parseStandardHrMeasurement,
} from './parse';

const hex = (s: string) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g)!.map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Einen vollständigen Rahmen durch den Reassembler schicken und das inner zurückgeben. */
function innerOf(frame: Uint8Array): Uint8Array {
  const out = new FrameReassembler().push(frame);
  expect(out).toHaveLength(1);
  return out[0]!;
}

// Verifizierte Captures (bWanShiTong-Blog, CRCs geprüft)
const RT_FRAME_1 = 'aa1800ff2802ad896566f0654201670600000000000001013ba00d4d';
const RT_FRAME_2 = 'aa1800ff2802ae896566f8604300000000000000000001015025f793';
const V12_FRAME_1 =
  'aa5c00f02f0c078bb70900c8326966e03c8054cc015801b9020000000000000000f96dff00a7e73b140eafbe298c5b3e715d753f00001046140eafbe298c5b3e715d753fe50146022003470282016004010c020c3000000000000002833a28fd';
const V12_FRAME_2 =
  'aa5c00f02f0c078db70900ca326966f8328054cc015802b802b9020000000000008b63ff0041a43b14e6aebea4b05b3e4819753f0000c0c514e6aebea4b05b3e4819753fe50146021e03450282016004010c020c3000000000000002a4d38c63';
const HISTORY_END_FRAME = 'aa1c00ab311802f65c7066804043000000 2e470100 04000000 000000 7f873cf3';
const BATTERY_EVENT_FRAME = 'aa2400fa30b003002e316966901f140002e9000000e90e00000101 0f030100 2f01000000 699d4a60';
const SHORT_EVENT_FRAME = 'aa100057307607001c5f6866a0050000ac1a4bdc';

describe('crc', () => {
  it('crc8 über die Längenbytes', () => {
    expect(crc8([0x08, 0x00])).toBe(0xa8);
    expect(crc8([0x10, 0x00])).toBe(0x57);
    expect(crc8([0x18, 0x00])).toBe(0xff);
    expect(crc8([0x5c, 0x00])).toBe(0xf0);
    expect(crc8([0x1c, 0x00])).toBe(0xab);
  });
  it('crc32 = zlib', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32([])).toBe(0);
  });
});

describe('Kommandorahmen (byte-genau)', () => {
  const cases: [string, Uint8Array][] = [
    ['aa0800a8230e16001147c585', cmd.sendHistoricalData(0x0e)],
    ['aa0800a823080e016c935474', cmd.buildCommand(0x08, Opcode.SET_GENERIC_HR_PROFILE, [1])],
    ['aa0800a823070e00c7e40f08', cmd.buildCommand(0x07, Opcode.SET_GENERIC_HR_PROFILE, [0])],
    ['aa0800a8238c03017d5ec627', cmd.toggleRealtimeHr(0x8c, true)],
    ['aa0800a8238d0300dc040351', cmd.toggleRealtimeHr(0x8d, false)],
    ['aa0800a823002300ada86a2d', cmd.getHello(0)],
    ['aa0800a823014c00f2b5cdce', cmd.getAdvertisingName(1)],
    ['aa0800a823022200824df537', cmd.getDataRange(2)],
    ['aa0800a823034301c54dd63d', cmd.getAlarm(3)],
    ['aa0800a823041600c7c25288', cmd.sendHistoricalData(4)],
    ['aa0800a823461600699b4cfb', cmd.sendHistoricalData(0x46)],
    ['aa0800a823051a00fce72525', cmd.getBattery(5)],
    ['aa10005723060a00f153650000000000faec2892', cmd.setClock(6, 1700000000 * 1000)],
    ['aa1000572307170101020304050607089a03a0b5', cmd.historyAck(7, [1, 2, 3, 4, 5, 6, 7, 8])],
    ['aa100057236d4201d036656600000000f62deb81', cmd.setAlarm(0x6d, 0x666536d0)],
    ['aa10005723704201126d6566000000003d59d8fd', cmd.setAlarm(0x70, 0x66656d12)],
  ];
  for (const [want, got] of cases) {
    it(want, () => expect(toHex(got)).toBe(want));
  }

  it('initPackets entspricht der offiziellen Init-Folge', () => {
    expect(cmd.initPackets(0).map(toHex)).toEqual([
      'aa0800a823002300ada86a2d',
      'aa0800a823014c00f2b5cdce',
      'aa0800a823022200824df537',
      'aa0800a823034301c54dd63d',
      'aa0800a823041600c7c25288',
    ]);
  });

  it('Leerer Payload wird mit 00 aufgefüllt', () => {
    expect(toHex(cmd.getClock(9))).toBe(toHex(cmd.buildCommand(9, Opcode.GET_CLOCK, [0])));
  });

  it('SET_CLOCK kodiert Subsekunden in 1/32768 s', () => {
    const f = cmd.setClock(1, 1700000000 * 1000 + 500);
    const inner = innerOf(f);
    const v = new DataView(inner.buffer);
    expect(v.getUint32(3, true)).toBe(1700000000);
    expect(v.getUint32(7, true)).toBe(16384);
    expect(cmd.setClock(1, 0, true).length).toBe(20); // 9-Byte-Form → 16 Byte inner
  });

  it('NEVER_SEND-Opcodes werfen', () => {
    for (const op of NEVER_SEND) expect(() => cmd.buildCommand(1, op)).toThrow(/NEVER_SEND/);
    expect(NEVER_SEND.has(0x0f)).toBe(true);
    expect(NEVER_SEND.has(0x19)).toBe(true);
    expect(NEVER_SEND.has(0x1d)).toBe(true);
  });
});

describe('Parser mit echten Captures', () => {
  it('Echtzeit-Puls (Blog-Capture)', () => {
    const live = parseRealtimeHr(innerOf(hex(RT_FRAME_1)));
    expect(live).toEqual({ ts: 0x666589ad, hr: 66, rr: [1639], wearing: true });
    const live2 = parseRealtimeHr(innerOf(hex(RT_FRAME_2)));
    expect(live2).toEqual({ ts: 0x666589ae, hr: 67, rr: [], wearing: true });
  });

  it('v12-Verlaufsdatensatz (Blog-Capture, vollständiger Rahmen)', () => {
    const inner = innerOf(hex(V12_FRAME_1));
    expect(inner.length).toBe(88);
    const r = parseHistoryRecord(inner)!;
    expect(r.version).toBe(12);
    expect(r.counter).toBe(0x0009b78b);
    expect(r.ts).toBe(0x666932c8);
    expect(r.hr).toBe(88);
    expect(r.rr).toEqual([697]);
    expect(r.src).toBe('history');
    expect(r.grav).toEqual([-0.3419, 0.2144, 0.9585]);

    const r2 = parseHistoryRecord(innerOf(hex(V12_FRAME_2)))!;
    expect(r2.ts).toBe(0x666932ca);
    expect(r2.rr).toEqual([696, 697]);
  });

  it('HISTORY_END-Metadaten mit Token (Blog-Capture)', () => {
    const m = parseMetadata(innerOf(hex(HISTORY_END_FRAME)))!;
    expect(m.subtype).toBe(MetadataType.HISTORY_END);
    expect(m.ts).toBe(0x66705cf6);
    expect(m.expectedCount).toBe(0x43);
    expect(toHex(m.token!)).toBe('2e47010004000000');
    // Ack mit exakt diesem Token
    const ack = innerOf(cmd.historyAck(0x18, m.token!));
    expect(toHex(ack)).toBe('231817012e47010004000000');
  });

  it('Batterie-Ereignis (Blog-Capture)', () => {
    const ev = parseEvent(innerOf(hex(BATTERY_EVENT_FRAME)))!;
    expect(ev.id).toBe(3);
    expect(ev.name).toBe('BATTERY_LEVEL');
    expect(ev.ts).toBe(0x6669312e);
    expect(ev.body.length).toBe(20);
    expect(ev.battery).toEqual({ percent: 23.3, mV: 3817, charging: true });
  });

  it('Kurzes Ereignis ohne Body (Laden an)', () => {
    const ev = parseEvent(innerOf(hex(SHORT_EVENT_FRAME)))!;
    expect(ev.id).toBe(7);
    expect(ev.charging).toBe(true);
    expect(ev.body.length).toBe(0);
  });
});

describe('Parser (synthetisch)', () => {
  const resp = (opcode: number, origin: number, result: number, body: number[]) =>
    innerOf(buildFrame([PacketType.COMMAND_RESPONSE, 0x55, opcode, origin, result, ...body]));

  it('Kommandoantwort + Batterie', () => {
    const r = parseCommandResponse(resp(Opcode.GET_BATTERY_LEVEL, 5, 1, [0x6f, 0x03]))!;
    expect(r).toMatchObject({ strapSeq: 0x55, opcode: 0x1a, originSeq: 5, result: 1 });
    expect(parseBattery(r)).toBe(87.9);
  });

  it('Uhrzeit', () => {
    const r = parseCommandResponse(resp(Opcode.GET_CLOCK, 1, 1, [0x00, 0xf1, 0x53, 0x65, 0x00, 0x40, 0, 0]))!;
    expect(parseClock(r)).toEqual({ sec: 1700000000, subsec: 16384 });
  });

  it('Hello liefert nur die Seriennummer', () => {
    const body = new Array(131).fill(0x41);
    const serial = '4A0123456';
    for (let i = 0; i < 9; i++) body[14 + i] = serial.charCodeAt(i);
    body[23] = 0;
    const h = parseHello(parseCommandResponse(resp(Opcode.GET_HELLO_HARVARD, 0, 1, body))!);
    expect(h).toEqual({ serial });
    expect(Object.keys(h)).toEqual(['serial']);
    body[23] = 0x41; // kein NUL → keine Seriennummer
    expect(parseHello(parseCommandResponse(resp(Opcode.GET_HELLO_HARVARD, 0, 1, body))!)).toEqual({});
  });

  function record(version: number, len: number, hrAt: number): Uint8Array {
    const b = new Uint8Array(len);
    const v = new DataView(b.buffer);
    b[0] = 0x2f;
    b[1] = version;
    v.setUint32(3, 42, true);
    v.setUint32(7, 1700000000, true);
    b[hrAt] = 61;
    if (hrAt === 17) {
      b[18] = 3;
      v.setInt16(19, 950, true);
      v.setInt16(21, 150, true); // < 200 ms → verworfen
      v.setInt16(23, 980, true);
    }
    if (len >= 48) {
      v.setFloat32(36, 0.1, true);
      v.setFloat32(40, -0.2, true);
      v.setFloat32(44, 0.97, true);
    }
    return b;
  }

  it('Layouts 7/9/12/18/24, 25 wird übersprungen', () => {
    const v24 = parseHistoryRecord(record(24, 92, 17))!;
    expect(v24).toMatchObject({ hr: 61, rr: [950, 980], grav: [0.1, -0.2, 0.97], version: 24 });
    expect(parseHistoryRecord(record(9, 76, 17))!.rr).toEqual([950, 980]);
    const v7 = parseHistoryRecord(record(7, 76, 27))!;
    expect(v7.hr).toBe(61);
    expect(v7.rr).toEqual([]);
    expect(v7.grav).toEqual([0.1, -0.2, 0.97]);
    expect(parseHistoryRecord(record(18, 76, 14))!.hr).toBe(61);
    expect(parseHistoryRecord(record(25, 84, 17))).toBeNull();
    expect(parseHistoryRecord(record(24, 40, 17))).toBeNull(); // zu kurz
    // RR-Anzahl > 4 ist unplausibel → keine RR
    const bad = record(24, 92, 17);
    bad[18] = 9;
    expect(parseHistoryRecord(bad)!.rr).toEqual([]);
  });

  it('Standard-HR 0x2A37 (uint8 / uint16, RR in 1/1024 s)', () => {
    const a = new DataView(Uint8Array.from([0x16, 60, 0x00, 0x04, 0x00, 0x03]).buffer);
    expect(parseStandardHrMeasurement(a)).toEqual({ hr: 60, rr: [1000, 750], contact: true });
    const b = new DataView(Uint8Array.from([0x19, 0x2c, 0x01, 0x10, 0x00, 0x00, 0x02]).buffer);
    expect(parseStandardHrMeasurement(b)).toEqual({ hr: 300, rr: [500] });
    const c = new DataView(Uint8Array.from([0x00, 72]).buffer);
    expect(parseStandardHrMeasurement(c)).toEqual({ hr: 72, rr: [] });
  });
});

describe('FrameReassembler', () => {
  const frames = [RT_FRAME_1, V12_FRAME_1, HISTORY_END_FRAME, BATTERY_EVENT_FRAME, V12_FRAME_2].map(hex);
  const stream = (() => {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const s = new Uint8Array(total);
    let o = 0;
    for (const f of frames) {
      s.set(f, o);
      o += f.length;
    }
    return s;
  })();
  const innerHex = frames.map((f) => toHex(f.subarray(4, f.length - 4)));

  for (const size of [1, 7, 20, 244, 4096]) {
    it(`fragmentiert in ${size}-Byte-Stücken`, () => {
      const r = new FrameReassembler();
      const got: string[] = [];
      for (let i = 0; i < stream.length; i += size) got.push(...r.push(stream.subarray(i, i + size)).map(toHex));
      expect(got).toEqual(innerHex);
      expect(r.pending).toBe(0);
    });
  }

  it('Payload mit 0xAA-Bytes', () => {
    const inner = [0x28, 0xaa, 0xaa, 0x00, 0xaa, 0x18, 0x00, 0xff, 0xaa];
    const f = buildFrame(inner);
    const r = new FrameReassembler();
    const got: Uint8Array[] = [];
    for (let i = 0; i < f.length; i += 3) got.push(...r.push(f.subarray(i, i + 3)));
    expect(got).toHaveLength(1);
    expect(Array.from(got[0]!.subarray(0, inner.length))).toEqual(inner);
    expect(got[0]!.length).toBe(12); // auf Vielfaches von 4 aufgefüllt
  });

  it('Müll und 0x00 zwischen Rahmen', () => {
    const r = new FrameReassembler();
    const junk = Uint8Array.from([0, 0, 0, 0x13, 0xaa, 0x37, 0x00, 0x00, 0, 0]);
    const parts = [junk, hex(RT_FRAME_1), new Uint8Array(7), hex(RT_FRAME_2), Uint8Array.from([0, 0, 0xaa])];
    const got = parts.flatMap((p) => r.push(p)).map(toHex);
    expect(got).toEqual([RT_FRAME_1, RT_FRAME_2].map((h) => h.slice(8, -8)));
  });

  it('beschädigter Rahmen, danach ein guter', () => {
    const bad = hex(V12_FRAME_1);
    bad[40] ^= 0xff; // CRC32 stimmt nicht mehr
    const r = new FrameReassembler();
    const got = [...r.push(bad.subarray(0, 50)), ...r.push(bad.subarray(50)), ...r.push(hex(RT_FRAME_1))];
    expect(got.map(toHex)).toEqual([RT_FRAME_1.slice(8, -8)]);
    expect(r.badFrames).toBe(1);
  });

  it('kaputte CRC8 im Header wird übersprungen', () => {
    const f = hex(RT_FRAME_1);
    f[3] ^= 1;
    const r = new FrameReassembler();
    expect(r.push(f)).toEqual([]);
    expect(r.push(hex(RT_FRAME_2)).map(toHex)).toEqual([RT_FRAME_2.slice(8, -8)]);
  });

  it('buildFrame → Reassembler Rundreise', () => {
    for (let n = 1; n < 40; n++) {
      const inner = Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      inner[0] = 0x31;
      const out = new FrameReassembler().push(buildFrame(inner));
      expect(out).toHaveLength(1);
      expect(out[0]!.length % 4).toBe(0);
      expect(Array.from(out[0]!.subarray(0, n))).toEqual(inner);
    }
  });
});
