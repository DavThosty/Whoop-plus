// Simuliertes WHOOP-4.0-Band hinter einer Fake-Web-Bluetooth-API.
// Spricht das echte Drahtprotokoll (eigener Frame-Builder): Kommandoantworten 0x24, Echtzeit 0x28,
// Verlauf als v24-Datensätze 0x2F in Blöcken mit HISTORY_START/END(Token)/COMPLETE, fragmentiert in
// ~244-Byte-Notifications. Der nächste Block kommt erst nach dem korrekten Token, sonst Wiederholung.

import {
  CMD_FROM_STRAP,
  CMD_TO_STRAP,
  CommandResult,
  DATA_FROM_STRAP,
  EVENTS_FROM_STRAP,
  EventId,
  MEMFAULT,
  MetadataType,
  NEVER_SEND,
  Opcode,
  PacketType,
  SERVICE,
} from '../protocol/constants';
import { buildFrame, FrameReassembler } from '../protocol/frame';
import { mulberry32, PhysiologySynth, type SynthSample } from './synth';

export interface FakeStrapOptions {
  /** Tage Verlauf im Speicher des Bands (Standard 1). */
  days?: number;
  /** Alternativ: exakte Anzahl Sekunden/Datensätze (überschreibt `days`). */
  historySeconds?: number;
  /** Unix-Sekunden des ältesten Datensatzes (Standard: jetzt − Dauer). */
  start?: number;
  /** Wächst der Verlauf mit der (simulierten) Zeit weiter? Standard: true, wenn `start` nicht gesetzt ist. */
  growing?: boolean;
  seed?: number;
  /** Datensätze pro Block (Standard 600). */
  batchSize?: number;
  /** Bytes pro Notification (Standard 244). */
  chunkSize?: number;
  serial?: string;
  name?: string;
  batteryPercent?: number;
  /** Intervall der Echtzeitpakete (Standard 1000 ms). */
  realtimeIntervalMs?: number;
  /** Verzögerung von Writes/Antworten (Standard 2 ms). */
  latencyMs?: number;
  /** Zusätzliche Verzögerung des allerersten Writes (simuliert den iOS-Kopplungsdialog). */
  bondDelayMs?: number;
  /** Standard-HR-Dienst 0x180D vorhanden (Standard true). */
  heartRateService?: boolean;
  /** Sendet 0x2A37-Notifications mit 1 Hz (wie nach SET_GENERIC_HR_PROFILE; Standard false). */
  standardHrBroadcast?: boolean;
  /** Unterstützt bluetooth.getDevices() (Standard true). */
  getDevices?: boolean;
  /** SET_CLOCK wird ignoriert (Test der Uhr-Warnung). */
  ignoreSetClock?: boolean;
  utcOffsetMin?: number;
  now?: () => number;
}

export interface ReceivedCommand {
  opcode: number;
  seq: number;
  payload: number[];
}

const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const NAMED: Record<string, number> = {
  heart_rate: 0x180d,
  battery_service: 0x180f,
  device_information: 0x180a,
  heart_rate_measurement: 0x2a37,
  battery_level: 0x2a19,
};

/** UUID-Normalisierung wie in Web Bluetooth (Name, 16-Bit-Zahl oder voller String). */
export function canonicalUuid(u: string | number): string {
  if (typeof u === 'number') return `0000${u.toString(16).padStart(4, '0')}${BASE_UUID_SUFFIX}`;
  const named = NAMED[u];
  if (named !== undefined) return canonicalUuid(named);
  return u.toLowerCase();
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function notFound(what: string): Error {
  const e = new Error(`NotFoundError: ${what}`);
  e.name = 'NotFoundError';
  return e;
}

type Listener = (ev: Event) => void;

class Emitter {
  private ls = new Map<string, Set<Listener>>();
  addEventListener(type: string, l: Listener): void {
    if (!this.ls.has(type)) this.ls.set(type, new Set());
    this.ls.get(type)!.add(l);
  }
  removeEventListener(type: string, l: Listener): void {
    this.ls.get(type)?.delete(l);
  }
  protected dispatch(type: string): void {
    const ev = new Event(type);
    for (const l of [...(this.ls.get(type) ?? [])]) l(ev);
  }
}

class FakeCharacteristic extends Emitter implements BluetoothRemoteGATTCharacteristic {
  value?: DataView;
  notifying = false;
  constructor(
    readonly uuid: string,
    private readonly strap: FakeStrap,
    private readonly onWrite?: (bytes: Uint8Array) => Promise<void>,
    private readonly read?: () => Uint8Array,
  ) {
    super();
  }
  async startNotifications(): Promise<this> {
    this.strap.assertConnected();
    await delay(this.strap.latency);
    this.notifying = true;
    if (this.uuid === canonicalUuid(0x2a37)) this.strap.maybeStartStandardHr();
    return this;
  }
  async stopNotifications(): Promise<this> {
    this.notifying = false;
    return this;
  }
  async readValue(): Promise<DataView> {
    this.strap.assertConnected();
    const b = this.read ? this.read() : new Uint8Array(0);
    this.value = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return this.value;
  }
  writeValue(v: ArrayBuffer | ArrayBufferView): Promise<void> {
    return this.doWrite(v);
  }
  writeValueWithResponse(v: ArrayBuffer | ArrayBufferView): Promise<void> {
    return this.doWrite(v);
  }
  private async doWrite(v: ArrayBuffer | ArrayBufferView): Promise<void> {
    if (!this.onWrite) throw new Error('NotSupportedError: Schreiben nicht erlaubt');
    const bytes =
      v instanceof ArrayBuffer ? new Uint8Array(v.slice(0)) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
    await this.onWrite(bytes);
  }
  /** Notification ausliefern (synchron, wie ein Event der Plattform). */
  notify(bytes: Uint8Array): void {
    if (!this.notifying) return;
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatch('characteristicvaluechanged');
  }
}

class FakeService implements BluetoothRemoteGATTService {
  constructor(
    readonly uuid: string,
    private readonly chars: Map<string, FakeCharacteristic>,
    private readonly strap: FakeStrap,
  ) {}
  async getCharacteristic(c: string | number): Promise<BluetoothRemoteGATTCharacteristic> {
    this.strap.assertConnected();
    await delay(this.strap.latency);
    const ch = this.chars.get(canonicalUuid(c));
    if (!ch) throw notFound(`Characteristic ${c}`);
    return ch;
  }
}

class FakeServer implements BluetoothRemoteGATTServer {
  constructor(
    readonly device: FakeDevice,
    private readonly strap: FakeStrap,
  ) {}
  get connected(): boolean {
    return this.strap.connected;
  }
  async connect(): Promise<BluetoothRemoteGATTServer> {
    await delay(this.strap.latency);
    this.strap.onConnect();
    return this;
  }
  disconnect(): void {
    this.strap.dropLink();
  }
  async getPrimaryService(s: string | number): Promise<BluetoothRemoteGATTService> {
    this.strap.assertConnected();
    await delay(this.strap.latency);
    const svc = this.strap.services.get(canonicalUuid(s));
    if (!svc) throw notFound(`Service ${s}`);
    return svc;
  }
}

class FakeDevice extends Emitter implements BluetoothDevice {
  readonly gatt: FakeServer;
  constructor(
    readonly id: string,
    readonly name: string,
    strap: FakeStrap,
  ) {
    super();
    this.gatt = new FakeServer(this, strap);
  }
  fireDisconnected(): void {
    this.dispatch('gattserverdisconnected');
  }
}

/** Zustand und Verhalten des simulierten Bands (für Tests einsehbar). */
export class FakeStrap {
  readonly opts: Required<Omit<FakeStrapOptions, 'start' | 'utcOffsetMin' | 'historySeconds' | 'days' | 'growing'>>;
  readonly device: FakeDevice;
  readonly services = new Map<string, FakeService>();
  connected = false;

  /** Alle empfangenen Kommandos (in Reihenfolge). */
  readonly received: ReceivedCommand[] = [];
  /** Empfangene Bestätigungen mit Bewertung. */
  readonly acks: { token: string; accepted: boolean; atCursor: number }[] = [];
  /** Gesperrte Opcodes, die trotzdem ankamen (muss leer bleiben). */
  readonly forbidden: number[] = [];
  /** Parallele GATT-Writes (Web Bluetooth würde sie ablehnen). */
  concurrentWriteErrors = 0;
  /** Gesendete Verlaufsblöcke (inkl. Wiederholungen). */
  batchesSent = 0;
  alarmAt: number | null = null;
  hapticsRuns = 0;
  realtimePacketsSent = 0;
  stdHrPacketsSent = 0;
  realtimeOn = false;
  /** Banduhr = now() + clockOffsetMs. Startet ungestellt (1970). */
  clockOffsetMs: number;

  // Verlauf
  readonly historyStart: number;
  private historyEndFixed: number | null;
  /** Index (Sekunden ab historyStart) des ältesten nicht bestätigten Datensatzes. */
  cursor = 0;
  private streaming = false;
  private awaiting: { token: Uint8Array; end: number; stream: Uint8Array } | null = null;
  private page = 0x1000;
  private readonly wrap: number;
  private histSynth: PhysiologySynth;
  private histSynthPos = 0;
  private batchCache: { from: number; samples: SynthSample[] } | null = null;

  private liveSynth: PhysiologySynth | null = null;
  private realtimeTimer?: ReturnType<typeof setInterval>;
  private stdHrTimer?: ReturnType<typeof setInterval>;
  private strapSeq = 0;
  private dataSeq = 0;
  private writeBusy = false;
  private firstWriteDone = false;
  private readonly asm = new FrameReassembler();
  private readonly synthOpts: { seed: number; utcOffsetMin?: number };
  private readonly chars: Record<'cmd' | 'evt' | 'data' | 'hr', FakeCharacteristic>;

  constructor(o: FakeStrapOptions = {}) {
    const now = o.now ?? Date.now;
    this.opts = {
      seed: o.seed ?? 42,
      batchSize: o.batchSize ?? 600,
      chunkSize: o.chunkSize ?? 244,
      serial: o.serial ?? '4A1B2C3D4',
      name: o.name ?? `WHOOP ${o.serial ?? '4A1B2C3D4'}`,
      batteryPercent: o.batteryPercent ?? 87.5,
      realtimeIntervalMs: o.realtimeIntervalMs ?? 1000,
      latencyMs: o.latencyMs ?? 2,
      bondDelayMs: o.bondDelayMs ?? 0,
      heartRateService: o.heartRateService ?? true,
      standardHrBroadcast: o.standardHrBroadcast ?? false,
      getDevices: o.getDevices ?? true,
      ignoreSetClock: o.ignoreSetClock ?? false,
      now,
    };
    const duration = o.historySeconds ?? Math.round((o.days ?? 1) * 86400);
    const nowSec = Math.floor(now() / 1000);
    this.historyStart = o.start ?? nowSec - duration;
    const growing = o.growing ?? o.start === undefined;
    this.historyEndFixed = growing ? null : this.historyStart + duration;
    this.clockOffsetMs = -now(); // RTC steht auf 1970
    this.wrap = mulberry32(this.opts.seed)() < 0.5 ? 3 : 4;
    const synthOpts = { seed: this.opts.seed, ...(o.utcOffsetMin !== undefined ? { utcOffsetMin: o.utcOffsetMin } : {}) };
    this.histSynth = new PhysiologySynth(this.historyStart, synthOpts);
    this.synthOpts = synthOpts;

    const cmd = new FakeCharacteristic(CMD_TO_STRAP, this, (b) => this.onWrite(b));
    const resp = new FakeCharacteristic(CMD_FROM_STRAP, this);
    const evt = new FakeCharacteristic(EVENTS_FROM_STRAP, this);
    const data = new FakeCharacteristic(DATA_FROM_STRAP, this);
    const mem = new FakeCharacteristic(MEMFAULT, this);
    this.services.set(
      SERVICE,
      new FakeService(SERVICE, new Map([cmd, resp, evt, data, mem].map((c) => [c.uuid, c])), this),
    );
    const hr = new FakeCharacteristic(canonicalUuid(0x2a37), this);
    if (this.opts.heartRateService) {
      this.services.set(canonicalUuid(0x180d), new FakeService(canonicalUuid(0x180d), new Map([[hr.uuid, hr]]), this));
    }
    const batt = new FakeCharacteristic(canonicalUuid(0x2a19), this, undefined, () =>
      Uint8Array.of(Math.round(this.opts.batteryPercent)),
    );
    this.services.set(canonicalUuid(0x180f), new FakeService(canonicalUuid(0x180f), new Map([[batt.uuid, batt]]), this));
    this.chars = { cmd: resp, evt, data, hr };
    this.device = new FakeDevice('fake-whoop-0001', this.opts.name, this);
  }

  get latency(): number {
    return this.opts.latencyMs;
  }

  /** Letzter Datensatz (exklusiv), den das Band derzeit gespeichert hat. */
  get historyEnd(): number {
    return this.historyEndFixed ?? Math.floor(this.opts.now() / 1000);
  }

  /** Anzahl noch nicht bestätigter Datensätze. */
  get remaining(): number {
    return Math.max(0, this.historyEnd - this.historyStart - this.cursor);
  }

  assertConnected(): void {
    if (!this.connected) {
      const e = new Error('NetworkError: GATT-Server ist nicht verbunden');
      e.name = 'NetworkError';
      throw e;
    }
  }

  onConnect(): void {
    this.connected = true;
    this.asm.reset();
  }

  /** Verbindung abbrechen (z. B. außer Reichweite). Feuert 'gattserverdisconnected'. */
  dropLink(): void {
    if (!this.connected) return;
    this.connected = false;
    this.stopRealtime();
    if (this.stdHrTimer) clearInterval(this.stdHrTimer);
    this.stdHrTimer = undefined;
    // Ein unbestätigter Block bleibt im Speicher und wird beim nächsten Mal erneut gesendet.
    this.streaming = false;
    this.awaiting = null;
    for (const c of Object.values(this.chars)) c.notifying = false;
    setTimeout(() => this.device.fireDisconnected(), 0);
  }

  /** Ereignis 0x30 auf 0004 senden. */
  sendEvent(id: number, body: number[] = []): void {
    const t = this.strapTime();
    const inner = [
      PacketType.EVENT,
      this.dataSeq++ & 0xff,
      id & 0xff,
      id >> 8,
      ...u32(t.sec),
      t.subsec & 0xff,
      (t.subsec >> 8) & 0xff,
      body.length & 0xff,
      body.length >> 8,
      ...body,
    ];
    this.deliver(this.chars.evt, buildFrame(inner));
  }

  sendBatteryEvent(percent: number, charging: boolean, mV = 3900): void {
    const soc = Math.round(percent * 10);
    this.sendEvent(EventId.BATTERY_LEVEL, [2, ...u32(soc), ...u32(mV), charging ? 1 : 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }

  // ---------------------------------------------------------------------------

  private strapTime(): { sec: number; subsec: number } {
    const ms = this.opts.now() + this.clockOffsetMs;
    const sec = Math.floor(ms / 1000);
    return { sec, subsec: Math.floor(((ms - sec * 1000) * 32768) / 1000) };
  }

  private async onWrite(bytes: Uint8Array): Promise<void> {
    this.assertConnected();
    if (this.writeBusy) {
      this.concurrentWriteErrors++;
      const e = new Error('NetworkError: GATT operation already in progress.');
      e.name = 'NetworkError';
      throw e;
    }
    this.writeBusy = true;
    try {
      if (!this.firstWriteDone) {
        this.firstWriteDone = true;
        if (this.opts.bondDelayMs) await delay(this.opts.bondDelayMs);
      }
      await delay(this.latency);
      this.assertConnected();
      for (const inner of this.asm.push(bytes)) this.handleCommand(inner);
    } finally {
      this.writeBusy = false;
    }
  }

  private respond(opcode: number, originSeq: number, result: number, body: ArrayLike<number> = []): void {
    const inner = new Uint8Array(5 + body.length);
    inner.set([PacketType.COMMAND_RESPONSE, this.strapSeq++ & 0xff, opcode, originSeq, result]);
    inner.set(body, 5);
    const frame = buildFrame(inner);
    setTimeout(() => this.deliver(this.chars.cmd, frame), this.latency);
  }

  private handleCommand(inner: Uint8Array): void {
    if (inner[0] !== PacketType.COMMAND || inner.length < 3) return;
    const seq = inner[1]!;
    const op = inner[2]!;
    const payload = Array.from(inner.subarray(3));
    this.received.push({ opcode: op, seq, payload });
    const ok = (body: ArrayLike<number> = []) => this.respond(op, seq, CommandResult.OK, body);

    if (NEVER_SEND.has(op)) {
      this.forbidden.push(op);
      this.respond(op, seq, CommandResult.FAIL);
      return;
    }
    switch (op) {
      case Opcode.LINK_VALID:
        return ok();
      case Opcode.GET_BATTERY_LEVEL: {
        const v = Math.round(this.opts.batteryPercent * 10);
        return ok([v & 0xff, v >> 8]);
      }
      case Opcode.SET_CLOCK: {
        if (!this.opts.ignoreSetClock && payload.length >= 4) {
          const sec = le32(payload, 0);
          const sub = payload.length >= 8 ? le32(payload, 4) & 0xffff : 0;
          this.clockOffsetMs = sec * 1000 + Math.floor((sub * 1000) / 32768) - this.opts.now();
          setTimeout(() => this.connected && this.sendEvent(EventId.SET_RTC), this.latency);
        }
        return ok();
      }
      case Opcode.GET_CLOCK: {
        const t = this.strapTime();
        return ok([...u32(t.sec), ...u32(t.subsec)]);
      }
      case Opcode.GET_HELLO_HARVARD:
        return ok(this.helloBody());
      case Opcode.GET_ADVERTISING_NAME:
        return ok([...new TextEncoder().encode(this.opts.name), 0]);
      case Opcode.GET_DATA_RANGE: {
        this.respond(op, seq, CommandResult.PENDING);
        const body = new Array(65).fill(0);
        body[0] = 1;
        const est = u32(this.remaining);
        for (let i = 0; i < 4; i++) body[25 + i] = est[i];
        return ok(body);
      }
      case Opcode.TOGGLE_REALTIME_HR:
        if (payload[0]) this.startRealtime();
        else this.stopRealtime();
        return ok();
      case Opcode.SEND_HISTORICAL_DATA:
        // (Neu-)Start ab dem ältesten unbestätigten Datensatz.
        ok();
        this.streaming = true;
        this.awaiting = null;
        setTimeout(() => {
          if (!this.connected || !this.streaming || this.awaiting) return;
          this.sendMeta(MetadataType.HISTORY_START);
          this.sendNextBatch();
        }, this.latency);
        return;
      case Opcode.HISTORICAL_DATA_RESULT:
        ok();
        this.onAck(payload);
        return;
      case Opcode.ABORT_HISTORICAL_TRANSMITS:
        this.streaming = false;
        this.awaiting = null;
        return ok();
      case Opcode.SET_ALARM_TIME:
        if (payload[0] !== 1 || payload.length < 5) return this.respond(op, seq, CommandResult.FAIL);
        this.alarmAt = le32(payload, 1);
        return ok([1]);
      case Opcode.GET_ALARM_TIME:
        return ok([1, ...u32(this.alarmAt ?? 0)]);
      case Opcode.DISABLE_ALARM:
        this.alarmAt = null;
        return ok([1]);
      case Opcode.RUN_ALARM:
        return ok([1]);
      case Opcode.RUN_HAPTICS_PATTERN:
        this.hapticsRuns++;
        return ok();
      case Opcode.SET_GENERIC_HR_PROFILE:
        return ok();
      default:
        return this.respond(op, seq, CommandResult.UNSUPPORTED);
    }
  }

  private helloBody(): number[] {
    const body = new Array(131).fill(0);
    const r = mulberry32(this.opts.seed ^ 0xbeef);
    for (let i = 0; i < 14; i++) body[i] = (r() * 256) | 0;
    for (let i = 0; i < 9; i++) body[14 + i] = this.opts.serial.charCodeAt(i) || 0x30;
    body[23] = 0;
    // Platzhalter für Schlüssel-/Signaturmaterial – darf vom Client niemals ausgelesen werden.
    for (let i = 24; i < 78; i++) body[i] = 0x41 + ((r() * 26) | 0);
    return body;
  }

  private sendMeta(subtype: number, count = 0, token: ArrayLike<number> = new Uint8Array(8)): Uint8Array {
    const t = this.strapTime();
    const frame = buildFrame([
      PacketType.METADATA,
      this.dataSeq++ & 0xff,
      subtype,
      ...u32(t.sec),
      t.subsec & 0xff,
      (t.subsec >> 8) & 0xff,
      ...u32(count),
      ...Array.from(token),
    ]);
    if (subtype !== MetadataType.HISTORY_END) this.deliver(this.chars.data, frame);
    return frame;
  }

  private sendNextBatch(): void {
    if (!this.connected || !this.streaming) return;
    const total = this.historyEnd - this.historyStart;
    if (this.cursor >= total) {
      this.streaming = false;
      this.sendMeta(MetadataType.HISTORY_COMPLETE);
      return;
    }
    const from = this.cursor;
    const to = Math.min(total, from + this.opts.batchSize);
    const samples = this.samples(from, to);
    const frames = samples.map((s, i) => encodeHistoryV24(s, 0x9b000 + from + i));
    const token = Uint8Array.from([...u32(this.page), ...u32(this.wrap)]);
    frames.push(this.sendMeta(MetadataType.HISTORY_END, frames.length, token));
    const stream = concat(frames);
    this.awaiting = { token, end: to, stream };
    this.transmit(stream);
  }

  private transmit(stream: Uint8Array): void {
    this.batchesSent++;
    setTimeout(() => {
      if (!this.connected || !this.streaming) return;
      this.deliver(this.chars.data, stream);
    }, this.latency);
  }

  private onAck(payload: number[]): void {
    const tokenHexStr = hex(payload.slice(1, 9));
    const a = this.awaiting;
    const accepted = !!a && payload[0] === 1 && payload.length >= 9 && tokenHexStr === hex(Array.from(a.token));
    this.acks.push({ token: tokenHexStr, accepted, atCursor: this.cursor });
    if (!a || !this.streaming) return;
    if (accepted) {
      this.cursor = a.end;
      this.page++;
      this.awaiting = null;
      this.batchCache = null;
      this.sendNextBatch();
    } else {
      // Falsches Token → derselbe Block noch einmal.
      this.transmit(a.stream);
    }
  }

  /** Synth-Samples [from, to) (Indizes ab historyStart). Generator läuft nur vorwärts, daher Cache. */
  private samples(from: number, to: number): SynthSample[] {
    if (this.batchCache && this.batchCache.from === from && this.batchCache.samples.length >= to - from) {
      return this.batchCache.samples.slice(0, to - from);
    }
    if (from < this.histSynthPos) {
      this.histSynth = new PhysiologySynth(this.historyStart, this.synthOpts);
      this.histSynthPos = 0;
    }
    while (this.histSynthPos < from) {
      this.histSynth.next();
      this.histSynthPos++;
    }
    const out: SynthSample[] = [];
    for (let i = from; i < to; i++) {
      out.push(this.histSynth.next());
      this.histSynthPos++;
    }
    this.batchCache = { from, samples: out };
    return out;
  }

  private startRealtime(): void {
    if (this.realtimeOn) return;
    this.realtimeOn = true;
    this.liveSynth = new PhysiologySynth(Math.floor(this.opts.now() / 1000), this.synthOpts);
    this.realtimeTimer = setInterval(() => {
      if (!this.connected || !this.liveSynth) return;
      const s = this.liveSynth.next();
      const t = this.strapTime();
      const inner = new Uint8Array(20);
      const v = new DataView(inner.buffer);
      inner[0] = PacketType.REALTIME_DATA;
      inner[1] = 2;
      v.setUint32(2, t.sec, true);
      v.setUint16(6, t.subsec & 0xffff, true);
      inner[8] = s.hr;
      inner[9] = s.rr.length;
      s.rr.forEach((ms, i) => v.setUint16(10 + 2 * i, ms, true));
      inner[18] = 1; // am Handgelenk
      inner[19] = 1;
      this.realtimePacketsSent++;
      this.deliver(this.chars.data, buildFrame(inner));
    }, this.opts.realtimeIntervalMs);
  }

  private stopRealtime(): void {
    this.realtimeOn = false;
    if (this.realtimeTimer) clearInterval(this.realtimeTimer);
    this.realtimeTimer = undefined;
  }

  /** Standard-HR-Broadcast starten (für Tests auch manuell aufrufbar). */
  startStandardHr(): void {
    if (this.stdHrTimer) return;
    const g = new PhysiologySynth(Math.floor(this.opts.now() / 1000), this.synthOpts);
    this.stdHrTimer = setInterval(() => {
      if (!this.connected) return;
      const s = g.next();
      const b = [0x16, s.hr]; // Flags: Kontakt erkannt + RR vorhanden, HR uint8
      for (const ms of s.rr) {
        const ticks = Math.round((ms * 1024) / 1000);
        b.push(ticks & 0xff, ticks >> 8);
      }
      this.stdHrPacketsSent++;
      this.chars.hr.notify(Uint8Array.from(b));
    }, this.opts.realtimeIntervalMs);
  }

  /** Bytestrom in chunkSize-Notifications zerlegen und synchron ausliefern. */
  private deliver(ch: FakeCharacteristic, bytes: Uint8Array): void {
    if (!this.connected) return;
    if (ch === this.chars.hr) return ch.notify(bytes);
    const n = this.opts.chunkSize;
    for (let i = 0; i < bytes.length && this.connected; i += n) ch.notify(bytes.slice(i, i + n));
  }

  /** Wird beim Abonnieren von 0x2A37 benötigt, um ggf. den Broadcast zu starten. */
  maybeStartStandardHr(): void {
    if (this.opts.standardHrBroadcast) this.startStandardHr();
  }
}

/** v24-Verlaufsdatensatz (inner 89 Bytes → 92 aufgefüllt). */
export function encodeHistoryV24(s: SynthSample, counter: number): Uint8Array {
  const inner = new Uint8Array(89);
  const v = new DataView(inner.buffer);
  inner[0] = PacketType.HISTORICAL_DATA;
  inner[1] = 24;
  v.setUint32(3, counter >>> 0, true);
  v.setUint32(7, s.ts, true);
  v.setUint16(11, 0, true);
  inner[17] = s.hr;
  inner[18] = s.rr.length;
  s.rr.slice(0, 4).forEach((ms, i) => v.setInt16(19 + 2 * i, ms, true));
  v.setUint16(29, 20000 + (s.hr * 37) % 5000, true); // „grüner PPG-Rohwert“
  for (let i = 0; i < 3; i++) {
    v.setFloat32(36 + 4 * i, s.grav[i]!, true);
    v.setFloat32(52 + 4 * i, s.grav[i]!, true); // reale Datensätze enthalten den Vektor doppelt
  }
  return buildFrame(inner);
}

function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function le32(b: number[], o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function hex(b: ArrayLike<number>): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface FakeBluetooth extends Bluetooth {
  readonly strap: FakeStrap;
}

/** Fake für navigator.bluetooth mit einem simulierten WHOOP 4.0. */
export function createFakeBluetooth(options: FakeStrapOptions = {}): FakeBluetooth {
  const strap = new FakeStrap(options);
  let granted = false;
  const bt: FakeBluetooth = {
    strap,
    async requestDevice(opts: RequestDeviceOptions): Promise<BluetoothDevice> {
      await delay(strap.latency);
      const matches = (opts.filters ?? []).some(
        (f) =>
          (f.services ?? []).some((s) => canonicalUuid(s) === SERVICE) ||
          (f.namePrefix !== undefined && strap.opts.name.startsWith(f.namePrefix)),
      );
      if (!matches && !opts.acceptAllDevices) throw notFound('Kein passendes Gerät');
      granted = true;
      return strap.device;
    },
    async getAvailability() {
      return true;
    },
  };
  if (strap.opts.getDevices) {
    (bt as { getDevices?: () => Promise<BluetoothDevice[]> }).getDevices = async () => (granted ? [strap.device] : []);
  }
  return bt;
}
