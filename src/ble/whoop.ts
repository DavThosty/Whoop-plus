// WHOOP 4.0 über Web Bluetooth (Bluefy auf dem iPhone).
// Ohne DOM-/UI-Abhängigkeiten, damit es unter vitest gegen den Simulator (src/sim) läuft.

import type { ConnectionState, DeviceInfo, LiveHr, SampleRecord, SyncProgress } from '../types';
import {
  BATTERY_SERVICE,
  CMD_FROM_STRAP,
  CMD_TO_STRAP,
  CommandResult,
  DATA_FROM_STRAP,
  EVENTS_FROM_STRAP,
  HEART_RATE_MEASUREMENT,
  HEART_RATE_SERVICE,
  MetadataType,
  Opcode,
  PacketType,
  SERVICE,
} from '../protocol/constants';
import * as cmd from '../protocol/commands';
import { FrameReassembler } from '../protocol/frame';
import {
  type CommandResponse,
  type Metadata,
  type StrapEvent,
  parseAdvertisingName,
  parseBattery,
  parseClock,
  parseCommandResponse,
  parseDataRange,
  parseEvent,
  parseHello,
  parseHistoryRecord,
  parseMetadata,
  parseRealtimeHr,
  parseStandardHrMeasurement,
  toSampleRecord,
} from '../protocol/parse';

export type RecordSink = (records: SampleRecord[]) => Promise<void>; // resolves only after durable commit

export interface WhoopEventMap {
  state: ConnectionState;
  info: DeviceInfo;
  battery: { percent: number; charging?: boolean };
  live: LiveHr;
  sync: SyncProgress;
  log: string;
  error: Error;
}

/** Zeitkonstanten; in Tests verkleinerbar. */
export interface WhoopTimings {
  /** Erster bestätigter Write (löst iOS-Kopplungsdialog aus). */
  firstWriteTimeoutMs: number;
  commandTimeoutMs: number;
  /** Abstand zwischen den Init-Kommandos. */
  initSpacingMs: number;
  heartbeatMs: number;
  /** Periodische Verlaufs-Synchronisierung während der Verbindung. */
  resyncIntervalMs: number;
  /** Sync endet, wenn so lange keine Verlaufsdaten kommen. */
  syncIdleTimeoutMs: number;
  /** Erlaubte Abweichung der Banduhr nach SET_CLOCK. */
  clockToleranceSec: number;
  /** Nach dem Verbinden automatisch synchronisieren. */
  autoSync: boolean;
  /** gatt.connect() – CoreBluetooth bricht selbst nie ab. */
  connectTimeoutMs: number;
  /** Jeder GATT-Write bzw. jede GATT-Operation (außer dem ersten Write, s. firstWriteTimeoutMs). */
  writeTimeoutMs: number;
}

export const DEFAULT_TIMINGS: WhoopTimings = {
  firstWriteTimeoutMs: 30_000,
  commandTimeoutMs: 5_000,
  initSpacingMs: 120,
  heartbeatMs: 10_000,
  resyncIntervalMs: 15 * 60_000,
  syncIdleTimeoutMs: 20_000,
  clockToleranceSec: 5,
  autoSync: true,
  connectTimeoutMs: 20_000,
  writeTimeoutMs: 10_000,
};

/** Echtzeitpakete tragen die Banduhr; weicht sie stärker ab, wird die Telefonzeit verwendet. */
const LIVE_CLOCK_TOLERANCE_SEC = 120;

/** Datensätze vor 2020 stammen aus einer nicht gestellten Banduhr (1970) und sind nicht zuordenbar. */
const MIN_VALID_TS = 1_577_836_800;
/** Standard-HR (0x2A37) wird ignoriert, solange die eigene Echtzeitquelle (0x28) frisch ist. */
const CUSTOM_LIVE_FRESH_MS = 3_000;

type ResponseMode = 'none' | 'required' | 'optional';

interface PendingCommand {
  resolve(r: CommandResponse | null): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface SyncSession {
  promise: Promise<number>;
  resolve(n: number): void;
  reject(e: Error): void;
  /** Datensätze des aktuellen (noch nicht bestätigten) Blocks. */
  batch: SampleRecord[];
  received: number;
  committed: number;
  skipped: number;
  invalidTs: number;
  newestTs: number | null;
  lastEmitAt: number;
  /** Serielle Kette der Commit-→-Ack-Schritte. */
  chain: Promise<void>;
  /** Tokens, deren Commit gerade läuft (doppelte HISTORY_END ignorieren). */
  inFlight: Set<string>;
  commits: number;
  batches: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  done: boolean;
  /** Irgendein Verlaufs-/Metadatenpaket empfangen. */
  traffic: boolean;
  /** Erster nicht dekodierbarer Datensatz im aktuellen Block (→ kein Ack, Abbruch). */
  badRecord: string | null;
}

interface AbortSignalLite {
  promise: Promise<never>;
  reject(e: Error): void;
}

function makeAbort(): AbortSignalLite {
  let reject!: (e: Error) => void;
  const promise = new Promise<never>((_, rej) => (reject = rej));
  promise.catch(() => undefined);
  return { promise, reject };
}

export class WhoopCommandError extends Error {
  constructor(
    readonly opcode: number,
    readonly result: number,
  ) {
    super(`Kommando ${opName(opcode)} vom Band abgelehnt (Ergebnis ${result})`);
    this.name = 'WhoopCommandError';
  }
}

const OP_NAMES: Record<number, string> = Object.fromEntries(Object.entries(Opcode).map(([k, v]) => [v, k]));
function opName(op: number): string {
  return OP_NAMES[op] ?? `0x${op.toString(16).padStart(2, '0')}`;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function tokenHex(t: Uint8Array): string {
  return Array.from(t, (b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Listener<K extends keyof WhoopEventMap> = (v: WhoopEventMap[K]) => void;

export class WhoopDevice {
  private readonly sink: RecordSink;
  private readonly bt: Bluetooth | null;
  private readonly now: () => number;
  private readonly t: WhoopTimings;

  private _state: ConnectionState = 'disconnected';
  private _info: DeviceInfo | null = null;
  private listeners: { [K in keyof WhoopEventMap]?: Set<Listener<K>> } = {};

  private device?: BluetoothDevice;
  private lastDeviceId?: string;
  private cmdChar?: BluetoothRemoteGATTCharacteristic;
  private unsubs: (() => void)[] = [];
  /** Erhöht sich bei jedem Auf-/Abbau; veraltete asynchrone Schritte brechen damit ab. */
  private gen = 0;

  private seq = 0;
  private writeChain: Promise<unknown> = Promise.resolve();
  private pending = new Map<number, PendingCommand>();

  private readonly asmCmd = new FrameReassembler();
  private readonly asmEvt = new FrameReassembler();
  private readonly asmData = new FrameReassembler();

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private resyncTimer?: ReturnType<typeof setInterval>;

  /** Wird beim Abbau ausgelöst und bricht hängende GATT-Operationen des Aufbaus ab. */
  private abort: AbortSignalLite | null = null;
  private liveClockWarned = false;

  private realtimeOn = false;
  private lastCustomLiveAt = -Infinity;
  private session: SyncSession | null = null;
  private strayHistoryFrames = 0;

  constructor(opts: {
    sink: RecordSink;
    bluetooth?: Bluetooth;
    now?: () => number;
    /** Erweiterung: Zeitkonstanten überschreiben (v. a. für Tests). */
    timings?: Partial<WhoopTimings>;
  }) {
    this.sink = opts.sink;
    this.bt = opts.bluetooth ?? (globalThis as { navigator?: Navigator }).navigator?.bluetooth ?? null;
    this.now = opts.now ?? Date.now;
    this.t = { ...DEFAULT_TIMINGS, ...opts.timings };
  }

  static isSupported(bluetooth?: unknown): boolean {
    const bt = bluetooth ?? (globalThis as { navigator?: { bluetooth?: unknown } }).navigator?.bluetooth;
    return !!bt && typeof (bt as { requestDevice?: unknown }).requestDevice === 'function';
  }

  get state(): ConnectionState {
    return this._state;
  }

  get info(): DeviceInfo | null {
    return this._info ? { ...this._info } : null;
  }

  on<K extends keyof WhoopEventMap>(ev: K, cb: (v: WhoopEventMap[K]) => void): () => void {
    let set = this.listeners[ev] as Set<Listener<K>> | undefined;
    if (!set) {
      set = new Set();
      (this.listeners as Record<string, Set<Listener<K>>>)[ev] = set;
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  // -------------------------------------------------------------------------
  // Verbindungsaufbau

  /** Gerätewahl (muss aus einer Nutzeraktion heraus aufgerufen werden) + Einrichtung. */
  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'syncing') return;
    if (this._state === 'connecting') throw new Error('Verbindung wird bereits aufgebaut');
    const bt = this.bt;
    if (!bt) throw new Error('Web Bluetooth wird von diesem Browser nicht unterstützt (Bluefy verwenden)');
    this.setState('connecting');
    const gen = this.gen;
    let device: BluetoothDevice;
    try {
      device = await bt.requestDevice({
        filters: [{ services: [SERVICE] }, { namePrefix: 'WHOOP' }],
        optionalServices: [SERVICE, HEART_RATE_SERVICE, BATTERY_SERVICE],
      });
    } catch (e) {
      this.setState('disconnected');
      this.log(`Gerätewahl abgebrochen: ${toError(e).message}`);
      throw toError(e);
    }
    if (gen !== this.gen) throw new Error('Verbindungsaufbau abgebrochen');
    await this.setup(device);
  }

  /** Verbindet ohne Auswahldialog mit einem bereits freigegebenen Band (falls getDevices() existiert). */
  async reconnect(): Promise<boolean> {
    if (this._state === 'connected' || this._state === 'syncing') return true;
    if (this._state === 'connecting') return false;
    const bt = this.bt;
    if (!bt || typeof bt.getDevices !== 'function') return false;
    let devices: BluetoothDevice[];
    try {
      devices = await bt.getDevices();
    } catch {
      return false;
    }
    const dev =
      devices.find((d) => d.id === this.lastDeviceId) ??
      devices.find((d) => d.name?.toUpperCase().startsWith('WHOOP')) ??
      (devices.length === 1 ? devices[0] : undefined);
    if (!dev) return false;
    this.setState('connecting');
    try {
      await this.setup(dev);
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    const dev = this.device;
    if (!dev) {
      this.gen++; // bricht ein laufendes requestDevice ab
      this.setState('disconnected');
      return;
    }
    this.log('Trenne Verbindung …');
    this.teardown(new Error('Verbindung getrennt'));
    try {
      dev.gatt?.disconnect();
    } catch {
      /* egal */
    }
  }

  private async setup(device: BluetoothDevice): Promise<void> {
    const gen = ++this.gen;
    this.abort = makeAbort();
    this.device = device;
    this.lastDeviceId = device.id;
    device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    try {
      if (!device.gatt) throw new Error('GATT-Server nicht verfügbar');
      const name = device.name ?? 'WHOOP';
      this.log(`Verbinde mit ${name} …`);
      const server = await this.guard(
        device.gatt.connect(),
        this.t.connectTimeoutMs,
        'Band nicht erreichbar (Zeitüberschreitung beim Verbinden). Ist es in der Nähe und nicht mit einer anderen App verbunden?',
      );
      this.check(gen);
      const svc = await this.guard(server.getPrimaryService(SERVICE), this.t.writeTimeoutMs, 'WHOOP-Dienst nicht gefunden (Zeitüberschreitung)');
      this.check(gen);
      this.cmdChar = await this.guard(svc.getCharacteristic(CMD_TO_STRAP), this.t.writeTimeoutMs, 'GATT-Zeitüberschreitung');
      this.check(gen);

      // 1) Benachrichtigungen 0003/0004/0005 abonnieren.
      const channels: [string, FrameReassembler][] = [
        [CMD_FROM_STRAP, this.asmCmd],
        [EVENTS_FROM_STRAP, this.asmEvt],
        [DATA_FROM_STRAP, this.asmData],
      ];
      for (const [uuid, asm] of channels) {
        const ch = await this.guard(svc.getCharacteristic(uuid), this.t.writeTimeoutMs, 'GATT-Zeitüberschreitung');
        this.check(gen);
        asm.reset();
        const handler = () => {
          const v = ch.value;
          if (v) this.onChunk(asm, v);
        };
        ch.addEventListener('characteristicvaluechanged', handler);
        this.unsubs.push(() => ch.removeEventListener('characteristicvaluechanged', handler));
        await this.guard(ch.startNotifications(), this.t.writeTimeoutMs, 'Benachrichtigungen konnten nicht aktiviert werden (Zeitüberschreitung)');
        this.check(gen);
      }

      this._info = { name };
      this.emit('info', { ...this._info });

      // 2) Erster bestätigter Write → iOS-Bonding. Der Kopplungsdialog kann offen sein, daher langes Timeout.
      this.log('Frage Akkustand ab (erster bestätigter Write – iOS zeigt ggf. den Kopplungsdialog) …');
      try {
        await this.readBattery(this.t.firstWriteTimeoutMs);
      } catch (e) {
        throw new Error(
          `Keine Antwort vom Band (${toError(e).message}). Kopplung bestätigt? Die offizielle WHOOP-App darf nicht gleichzeitig verbunden sein.`,
        );
      }
      this.check(gen);

      // 3) Uhr stellen (Pflicht bei jeder Verbindung) und prüfen.
      await this.syncClock(gen);
      this.check(gen);

      // 4) Init-Kommandos einmal pro Verbindung, mit Abstand.
      await this.runInit(gen);

      // 5) Standard-Herzfrequenzdienst als Zweitquelle (optional).
      await this.subscribeStandardHr(server, gen);
      this.check(gen);

      this.startTimers();
      this.setState('connected');
      this.log('Verbunden');
      if (this.t.autoSync) this.autoSync();
    } catch (e) {
      const err = toError(e);
      if (gen === this.gen) {
        this.emit('error', err);
        this.teardown(err);
        try {
          device.gatt?.disconnect();
        } catch {
          /* egal */
        }
      }
      throw err;
    }
  }

  private check(gen: number): void {
    if (gen !== this.gen) throw new Error('Verbindung getrennt');
  }

  /** Wartet auf `p`, höchstens `ms`, und bricht ab, sobald die Verbindung abgebaut wird. */
  private guard<T>(p: Promise<T>, ms: number, timeoutMsg: string, signal = this.abort): Promise<T> {
    p.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const racers: Promise<T>[] = [
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(timeoutMsg)), ms);
      }),
    ];
    if (signal) racers.push(signal.promise);
    return Promise.race(racers).finally(() => clearTimeout(timer));
  }

  /** Hängende GATT-Operation im Betrieb: Verbindung hart abbauen. */
  private failLink(err: Error, gen: number): void {
    if (gen !== this.gen || !this.device) return;
    const dev = this.device;
    this.emit('error', err);
    this.log(`${err.message} – Verbindung wird getrennt`);
    this.teardown(err);
    try {
      dev.gatt?.disconnect();
    } catch {
      /* egal */
    }
  }

  private onDisconnected = (): void => {
    if (!this.device) return;
    this.log('Verbindung zum Band verloren');
    this.teardown(new Error('Verbindung getrennt'));
  };

  private teardown(reason: Error): void {
    this.gen++;
    this.abort?.reject(reason);
    this.abort = null;
    this.liveClockWarned = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.heartbeatTimer = this.resyncTimer = undefined;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device = undefined;
    this.cmdChar = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    if (this.session) this.finishSession(this.session, reason);
    this.asmCmd.reset();
    this.asmEvt.reset();
    this.asmData.reset();
    this.realtimeOn = false;
    this.writeChain = Promise.resolve();
    this.setState('disconnected');
  }

  private startTimers(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send(Opcode.LINK_VALID, cmd.linkValid, 'none').catch((e) =>
        this.log(`Keepalive fehlgeschlagen: ${toError(e).message}`),
      );
    }, this.t.heartbeatMs);
    this.resyncTimer = setInterval(() => {
      if (!this.session && this._state === 'connected') this.autoSync();
    }, this.t.resyncIntervalMs);
  }

  private async syncClock(gen: number): Promise<void> {
    const tol = this.t.clockToleranceSec;
    const attempt = async (): Promise<number | null> => {
      try {
        await this.send(Opcode.SET_CLOCK, (s) => cmd.setClock(s, this.now()), 'optional');
      } catch (e) {
        this.log(`SET_CLOCK fehlgeschlagen: ${toError(e).message}`);
      }
      this.check(gen);
      try {
        const r = await this.send(Opcode.GET_CLOCK, cmd.getClock, 'required');
        const c = r && parseClock(r);
        if (!c) return null;
        return c.sec + c.subsec / 32768 - this.now() / 1000;
      } catch (e) {
        this.log(`GET_CLOCK fehlgeschlagen: ${toError(e).message}`);
        return null;
      }
    };
    let off = await attempt();
    if (off !== null && Math.abs(off) > tol) {
      this.log(`Banduhr weicht nach SET_CLOCK um ${off.toFixed(1)} s ab – zweiter Versuch`);
      this.check(gen);
      off = await attempt();
    }
    if (off === null) this.log('Warnung: Banduhr konnte nicht überprüft werden');
    else if (Math.abs(off) > tol) this.log(`Warnung: Banduhr weicht um ${off.toFixed(1)} s ab`);
    else this.log(`Uhr gestellt (Abweichung ${off.toFixed(1)} s)`);
  }

  private async runInit(gen: number): Promise<void> {
    const steps: [string, number, (s: number) => Uint8Array, (r: CommandResponse) => void][] = [
      [
        'Hello',
        Opcode.GET_HELLO_HARVARD,
        cmd.getHello,
        (r) => {
          const { serial } = parseHello(r);
          if (serial && this._info) {
            this._info = { ...this._info, serial };
            this.emit('info', { ...this._info });
            this.log(`Seriennummer ${serial}`);
          }
        },
      ],
      [
        'Name',
        Opcode.GET_ADVERTISING_NAME,
        cmd.getAdvertisingName,
        (r) => {
          const n = parseAdvertisingName(r);
          if (n) this.log(`Bandname: ${n}`);
        },
      ],
      [
        'Datenbereich',
        Opcode.GET_DATA_RANGE,
        cmd.getDataRange,
        (r) => {
          const d = parseDataRange(r);
          if (d) this.log(`Band meldet ca. ${d.recordEstimate} gespeicherte Datensätze`);
        },
      ],
    ];
    for (const [label, op, build, handle] of steps) {
      try {
        const r = await this.send(op, build, 'optional');
        if (r) handle(r);
      } catch (e) {
        this.log(`${label} fehlgeschlagen: ${toError(e).message}`);
      }
      this.check(gen);
      await sleep(this.t.initSpacingMs);
      this.check(gen);
    }
  }

  private async subscribeStandardHr(server: BluetoothRemoteGATTServer, gen: number): Promise<void> {
    try {
      const svc = await this.guard(server.getPrimaryService(HEART_RATE_SERVICE), this.t.writeTimeoutMs, 'GATT-Zeitüberschreitung');
      this.check(gen);
      const ch = await this.guard(svc.getCharacteristic(HEART_RATE_MEASUREMENT), this.t.writeTimeoutMs, 'GATT-Zeitüberschreitung');
      this.check(gen);
      const handler = () => {
        const v = ch.value;
        if (v) this.onStandardHr(v);
      };
      ch.addEventListener('characteristicvaluechanged', handler);
      this.unsubs.push(() => ch.removeEventListener('characteristicvaluechanged', handler));
      await this.guard(ch.startNotifications(), this.t.writeTimeoutMs, 'GATT-Zeitüberschreitung');
      this.log('Standard-Herzfrequenzdienst abonniert');
    } catch (e) {
      if (gen !== this.gen) throw e;
      this.log('Standard-Herzfrequenzdienst nicht verfügbar');
    }
  }

  // -------------------------------------------------------------------------
  // Öffentliche Kommandos

  async setRealtimeHr(on: boolean): Promise<void> {
    this.requireConnected();
    const before = this.realtimeOn;
    this.realtimeOn = on; // sofort, damit 0x2A37 nicht doppelt meldet
    try {
      await this.send(Opcode.TOGGLE_REALTIME_HR, (s) => cmd.toggleRealtimeHr(s, on), 'optional');
      this.log(on ? 'Echtzeit-Puls an' : 'Echtzeit-Puls aus');
    } catch (e) {
      this.realtimeOn = before;
      throw toError(e);
    }
  }

  async getBattery(): Promise<number> {
    this.requireConnected();
    return this.readBattery(this.t.commandTimeoutMs);
  }

  async setAlarm(at: Date | null): Promise<void> {
    this.requireConnected();
    if (at === null) {
      await this.send(Opcode.DISABLE_ALARM, cmd.disableAlarm, 'optional');
      this.log('Wecker deaktiviert');
      return;
    }
    const ms = at.getTime();
    if (!Number.isFinite(ms) || ms <= this.now()) throw new Error('Weckzeit liegt in der Vergangenheit');
    const { sec, subsec } = cmd.toStrapTime(ms);
    await this.send(Opcode.SET_ALARM_TIME, (s) => cmd.setAlarm(s, sec, subsec & 0xffff), 'optional');
    this.log(`Wecker gestellt auf ${at.toISOString()}`);
  }

  /** Kurzes Vibrieren („Band finden“): Preset 2 / 3 Loops + RUN_ALARM, wie in NOOP beobachtet. */
  async buzz(): Promise<void> {
    this.requireConnected();
    await this.send(Opcode.RUN_HAPTICS_PATTERN, (s) => cmd.runHaptics(s, 2, 3), 'optional');
    await this.send(Opcode.RUN_ALARM, cmd.runAlarm, 'optional');
  }

  /**
   * Kurzer Vibrationsimpuls (z. B. Workout-Zonenwechsel): nur RUN_HAPTICS_PATTERN, ohne RUN_ALARM –
   * dadurch bleibt es bei einem kurzen Summen statt des längeren „Band finden“-Alarms.
   */
  async haptic(pattern = 2, loops = 1): Promise<void> {
    this.requireConnected();
    const p = Math.max(0, Math.min(255, Math.round(pattern)));
    const l = Math.max(1, Math.min(10, Math.round(loops)));
    await this.send(Opcode.RUN_HAPTICS_PATTERN, (s) => cmd.runHaptics(s, p, l), 'optional');
  }

  /**
   * Verlauf abholen: 0x16 senden, Blöcke sammeln, nach HISTORY_END erst in den Sink schreiben
   * und dann mit dem exakten Token bestätigen. Liefert die Zahl gespeicherter Datensätze.
   */
  syncHistory(): Promise<number> {
    if (this.session) return this.session.promise;
    if (!this.cmdChar || (this._state !== 'connected' && this._state !== 'syncing')) {
      return Promise.reject(new Error('Nicht verbunden'));
    }
    let resolve!: (n: number) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined); // keine "unhandled rejection", Aufrufer bekommt den Fehler trotzdem
    const s: SyncSession = {
      promise,
      resolve,
      reject,
      batch: [],
      received: 0,
      committed: 0,
      skipped: 0,
      invalidTs: 0,
      newestTs: null,
      lastEmitAt: 0,
      chain: Promise.resolve(),
      inFlight: new Set(),
      commits: 0,
      batches: 0,
      done: false,
      traffic: false,
      badRecord: null,
    };
    this.session = s;
    this.setState('syncing');
    this.log('Starte Verlaufs-Synchronisierung …');
    this.emitProgress(s, false);
    this.armIdle(s);
    this.send(Opcode.SEND_HISTORICAL_DATA, cmd.sendHistoricalData, 'none').catch((e) => {
      const err = toError(e);
      this.emit('error', err);
      this.finishSession(s, err);
    });
    return promise;
  }

  // -------------------------------------------------------------------------
  // Schreiben & Kommando-Korrelation

  private requireConnected(): void {
    if (!this.cmdChar || (this._state !== 'connected' && this._state !== 'syncing')) {
      throw new Error('Nicht verbunden');
    }
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xff;
    return this.seq;
  }

  /** Alle GATT-Writes laufen seriell – Web Bluetooth lehnt parallele Operationen ab. */
  private write(frame: Uint8Array, timeoutMs = this.t.writeTimeoutMs): Promise<void> {
    const ch = this.cmdChar;
    if (!ch) return Promise.reject(new Error('Nicht verbunden'));
    const gen = this.gen;
    const signal = this.abort;
    const p = this.writeChain.then(async () => {
      if (gen !== this.gen) throw new Error('Verbindung getrennt');
      try {
        await this.guard(
          typeof ch.writeValueWithResponse === 'function' ? ch.writeValueWithResponse(frame) : ch.writeValue(frame),
          timeoutMs,
          'Schreibzugriff auf das Band hängt (Zeitüberschreitung)',
          signal,
        );
      } catch (e) {
        const err = toError(e);
        if (err.message.startsWith('Schreibzugriff auf das Band hängt')) this.failLink(err, gen);
        throw err;
      }
    });
    this.writeChain = p.catch(() => undefined);
    return p;
  }

  /**
   * Kommando senden. `required`: Antwort nötig (Timeout = Fehler); `optional`: Timeout → null;
   * `none`: nur der bestätigte Write. Zuordnung der Antwort über (Opcode, Sequenznummer).
   */
  private async send(
    opcode: number,
    build: (seq: number) => Uint8Array,
    mode: ResponseMode,
    timeoutMs = this.t.commandTimeoutMs,
  ): Promise<CommandResponse | null> {
    if (!this.cmdChar) throw new Error('Nicht verbunden');
    const seq = this.nextSeq();
    const frame = build(seq); // wirft bei NEVER_SEND
    const writeTimeout = Math.max(this.t.writeTimeoutMs, timeoutMs);
    if (mode === 'none') {
      await this.write(frame, writeTimeout);
      return null;
    }
    const key = (opcode << 8) | seq;
    this.pending.get(key)?.reject(new Error('Sequenznummer neu vergeben'));
    const resp = new Promise<CommandResponse | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        if (mode === 'optional') resolve(null);
        else reject(new Error(`Zeitüberschreitung bei ${opName(opcode)}`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
    });
    resp.catch(() => undefined);
    try {
      await this.write(frame, writeTimeout);
    } catch (e) {
      const p = this.pending.get(key);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(key);
      }
      throw toError(e);
    }
    return resp;
  }

  private onResponse(r: CommandResponse): void {
    const key = (r.opcode << 8) | r.originSeq;
    const p = this.pending.get(key);
    if (!p) return;
    if (r.result === CommandResult.PENDING) return; // finale Antwort folgt
    clearTimeout(p.timer);
    this.pending.delete(key);
    if (r.result === CommandResult.OK) p.resolve(r);
    else p.reject(new WhoopCommandError(r.opcode, r.result));
  }

  private async readBattery(timeoutMs: number): Promise<number> {
    const r = await this.send(Opcode.GET_BATTERY_LEVEL, cmd.getBattery, 'required', timeoutMs);
    const pct = r ? parseBattery(r) : null;
    if (pct === null) throw new Error('Ungültige Akku-Antwort');
    this.emit('battery', { percent: pct });
    return pct;
  }

  // -------------------------------------------------------------------------
  // Eingehende Daten

  private onChunk(asm: FrameReassembler, v: DataView): void {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    for (const inner of asm.push(bytes)) {
      try {
        this.handleInner(inner);
      } catch (e) {
        this.log(`Fehler beim Verarbeiten eines Pakets: ${toError(e).message}`);
      }
    }
  }

  private handleInner(inner: Uint8Array): void {
    switch (inner[0]) {
      case PacketType.COMMAND_RESPONSE: {
        const r = parseCommandResponse(inner);
        if (r) this.onResponse(r);
        break;
      }
      case PacketType.REALTIME_DATA: {
        const live = parseRealtimeHr(inner);
        if (live) {
          this.lastCustomLiveAt = this.now();
          const phone = Math.floor(this.now() / 1000);
          if (Math.abs(live.ts - phone) > LIVE_CLOCK_TOLERANCE_SEC) {
            if (!this.liveClockWarned) {
              this.liveClockWarned = true;
              this.log('Banduhr in Echtzeitpaketen falsch – verwende die Uhrzeit des Telefons');
            }
            live.ts = phone;
          }
          this.emit('live', live);
        }
        break;
      }
      case PacketType.HISTORICAL_DATA:
        this.onHistoryRecord(inner);
        break;
      case PacketType.METADATA: {
        const m = parseMetadata(inner);
        if (m) this.onMetadata(m);
        break;
      }
      case PacketType.EVENT: {
        const ev = parseEvent(inner);
        if (ev) this.onEvent(ev);
        break;
      }
      default:
        break; // Konsolen-Logs, IMU, Rohdaten: ignoriert
    }
  }

  private onStandardHr(v: DataView): void {
    if (this.realtimeOn || this.now() - this.lastCustomLiveAt < CUSTOM_LIVE_FRESH_MS) return;
    const m = parseStandardHrMeasurement(v);
    if (!m) return;
    this.emit('live', {
      ts: Math.floor(this.now() / 1000),
      hr: m.hr,
      rr: m.rr,
      wearing: m.contact ?? m.hr > 0,
    });
  }

  private onEvent(ev: StrapEvent): void {
    if (ev.battery) {
      this.emit('battery', { percent: ev.battery.percent, charging: ev.battery.charging });
      this.log(`Akku ${ev.battery.percent.toFixed(1)} %${ev.battery.charging ? ' (lädt)' : ''}`);
    } else if (ev.charging !== undefined) {
      this.log(ev.charging ? 'Ladegerät angeschlossen' : 'Ladegerät getrennt');
    } else if (ev.wrist !== undefined) {
      this.log(ev.wrist ? 'Band angelegt' : 'Band abgenommen');
    } else {
      this.log(`Ereignis ${ev.name}`);
    }
  }

  // -------------------------------------------------------------------------
  // Verlauf

  private onHistoryRecord(inner: Uint8Array): void {
    const s = this.session;
    if (!s) {
      if (this.strayHistoryFrames++ === 0) this.log('Verlaufsdaten ohne laufende Synchronisierung – ignoriert');
      return;
    }
    this.armIdle(s);
    s.traffic = true;
    const r = parseHistoryRecord(inner);
    if (!r) {
      if (inner[1] === 25) s.skipped++; // reiner PPG-Burst ohne HR – bekannt, darf übersprungen werden
      else s.badRecord ??= `Layout ${inner[1]}, ${inner.length} Byte`;
      return;
    }
    if (r.ts < MIN_VALID_TS) {
      s.invalidTs++;
      return;
    }
    s.batch.push(toSampleRecord(r));
    s.received++;
    if (s.newestTs === null || r.ts > s.newestTs) s.newestTs = r.ts;
    if (s.received - s.lastEmitAt >= 250) this.emitProgress(s, false);
  }

  private onMetadata(m: Metadata): void {
    const s = this.session;
    if (!s) return;
    this.armIdle(s);
    s.traffic = true;
    if (s.badRecord && (m.subtype === MetadataType.HISTORY_END || m.subtype === MetadataType.HISTORY_COMPLETE)) {
      // Nicht dekodierbare Datensätze: NICHT bestätigen, sonst löscht das Band sie.
      const err = new Error(`Unbekanntes Datenformat (${s.badRecord}) – Sync abgebrochen, Daten bleiben auf dem Band`);
      s.batch = [];
      s.chain = s.chain.then(() => {
        if (!s.done) this.abortSession(s, err);
      });
      return;
    }
    switch (m.subtype) {
      case MetadataType.HISTORY_START:
        this.log('Band beginnt mit der Verlaufsübertragung');
        break;
      case MetadataType.HISTORY_END:
        this.onHistoryEnd(s, m);
        break;
      case MetadataType.HISTORY_COMPLETE:
        // Keine Bestätigung. Erst laufende Commits abwarten, dann beenden.
        s.chain = s.chain.then(() => this.finishSession(s, null));
        break;
    }
  }

  private onHistoryEnd(s: SyncSession, m: Metadata): void {
    const key = m.token ? tokenHex(m.token) : null;
    if (key && s.inFlight.has(key)) {
      this.log('Doppeltes HISTORY_END während des Speicherns – ignoriert');
      return;
    }
    const records = s.batch;
    s.batch = [];
    if (key) s.inFlight.add(key);
    s.commits++;
    if (s.idleTimer) clearTimeout(s.idleTimer); // während des Speicherns kein Idle-Abbruch
    const token = m.token;
    s.chain = s.chain
      .then(async () => {
        if (s.done) return;
        try {
          if (records.length) await this.sink(records);
        } catch (e) {
          throw new Error(`Speichern fehlgeschlagen – Block nicht bestätigt: ${toError(e).message}`);
        }
        if (s.done || this.session !== s) return; // getrennt/abgebrochen → nicht bestätigen
        s.committed += records.length;
        s.batches++;
        if (token) {
          // ERST jetzt bestätigen: das Band darf den Block danach verwerfen.
          await this.send(Opcode.HISTORICAL_DATA_RESULT, (q) => cmd.historyAck(q, token), 'none');
        } else {
          this.log('HISTORY_END ohne Token – Block kann nicht bestätigt werden');
        }
        this.emitProgress(s, false);
      })
      .catch((e) => {
        if (!s.done) this.abortSession(s, toError(e));
      })
      .finally(() => {
        if (key) s.inFlight.delete(key);
        s.commits--;
        if (!s.done) this.armIdle(s);
      });
  }

  private abortSession(s: SyncSession, err: Error): void {
    this.emit('error', err);
    this.log(`Synchronisierung abgebrochen: ${err.message}`);
    if (this.cmdChar) {
      this.send(Opcode.ABORT_HISTORICAL_TRANSMITS, cmd.abortHistorical, 'none').catch(() => undefined);
    }
    this.finishSession(s, err);
  }

  private armIdle(s: SyncSession): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = undefined;
    if (s.done || s.commits > 0) return;
    s.idleTimer = setTimeout(() => {
      if (s.done) return;
      const secs = Math.round(this.t.syncIdleTimeoutMs / 1000);
      if (!s.traffic) {
        this.finishSession(s, new Error(`Keine Verlaufsdaten vom Band erhalten (keine Antwort seit ${secs} s)`));
      } else if (s.batch.length) {
        this.finishSession(s, new Error(`Verlaufsübertragung unterbrochen (seit ${secs} s keine Daten)`));
      } else {
        this.log(`Keine Verlaufsdaten seit ${secs} s – Synchronisierung beendet`);
        this.finishSession(s, null);
      }
    }, this.t.syncIdleTimeoutMs);
  }

  private finishSession(s: SyncSession, err: Error | null): void {
    if (s.done) return;
    s.done = true;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (this.session === s) this.session = null;
    if (s.batch.length) {
      // Ohne HISTORY_END kein Token → das Band sendet diese Datensätze beim nächsten Mal erneut.
      this.log(`${s.batch.length} unbestätigte Datensätze verworfen (kommen beim nächsten Sync erneut)`);
      s.batch = [];
    }
    if (s.invalidTs) this.log(`${s.invalidTs} Datensätze ohne gültige Uhrzeit verworfen`);
    if (s.skipped) this.log(`${s.skipped} Datensätze ohne Pulsdaten (z. B. Layout 25) übersprungen`);
    if (this._state === 'syncing') this.setState('connected');
    this.emitProgress(s, true, err);
    if (err) {
      s.reject(err);
    } else {
      this.log(`Synchronisierung fertig: ${s.committed} Datensätze in ${s.batches} Blöcken`);
      s.resolve(s.committed);
    }
  }

  private emitProgress(s: SyncSession, done: boolean, err: Error | null = null): void {
    s.lastEmitAt = s.received;
    const p: SyncProgress = { records: s.received, newestTs: s.newestTs, done };
    if (done) {
      p.ok = !err;
      if (err) p.error = err.message;
    }
    this.emit('sync', p);
  }

  private autoSync(): void {
    if (this.session) return;
    this.syncHistory().catch((e) => this.log(`Synchronisierung nicht abgeschlossen: ${toError(e).message}`));
  }

  // -------------------------------------------------------------------------

  private setState(s: ConnectionState): void {
    if (s === this._state) return;
    this._state = s;
    this.emit('state', s);
  }

  private log(msg: string): void {
    this.emit('log', msg);
  }

  private emit<K extends keyof WhoopEventMap>(ev: K, v: WhoopEventMap[K]): void {
    const set = this.listeners[ev] as Set<Listener<K>> | undefined;
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(v);
      } catch (e) {
        if (ev !== 'log') this.log(`Listener-Fehler (${ev}): ${toError(e).message}`);
      }
    }
  }
}
