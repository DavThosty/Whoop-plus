import { afterEach, describe, expect, it } from 'vitest';
import type { LiveHr, SampleRecord, SyncProgress } from '../types';
import { WhoopDevice, type RecordSink, type WhoopTimings } from '../ble/whoop';
import { createFakeBluetooth, type FakeStrapOptions } from './fake-strap';
import { generate } from './synth';
import { CMD_TO_STRAP, DATA_FROM_STRAP, MetadataType, NEVER_SEND, Opcode, SERVICE } from '../protocol/constants';
import { FrameReassembler } from '../protocol/frame';
import { historyAck, sendHistoricalData } from '../protocol/commands';
import { parseHistoryRecord, parseMetadata } from '../protocol/parse';

const START = 1_750_000_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('Bedingung nicht erfüllt');
    await sleep(5);
  }
}

const FAST: Partial<WhoopTimings> = {
  firstWriteTimeoutMs: 2000,
  commandTimeoutMs: 500,
  initSpacingMs: 1,
  heartbeatMs: 30,
  resyncIntervalMs: 60_000,
  syncIdleTimeoutMs: 400,
  autoSync: false,
};

const devices: WhoopDevice[] = [];
afterEach(async () => {
  for (const d of devices.splice(0)) await d.disconnect();
});

function setup(opts: FakeStrapOptions = {}, sink?: RecordSink, timings: Partial<WhoopTimings> = {}) {
  const bt = createFakeBluetooth({
    latencyMs: 1,
    start: START,
    historySeconds: 1500,
    batchSize: 600,
    realtimeIntervalMs: 20,
    ...opts,
  });
  const stored: SampleRecord[] = [];
  const dev = new WhoopDevice({
    bluetooth: bt,
    sink:
      sink ??
      (async (r) => {
        stored.push(...r);
      }),
    timings: { ...FAST, ...timings },
  });
  devices.push(dev);
  const ev = {
    states: [] as string[],
    logs: [] as string[],
    errors: [] as Error[],
    live: [] as LiveHr[],
    sync: [] as SyncProgress[],
    battery: [] as { percent: number; charging?: boolean }[],
  };
  dev.on('state', (s) => ev.states.push(s));
  dev.on('log', (s) => ev.logs.push(s));
  dev.on('error', (e) => ev.errors.push(e));
  dev.on('live', (l) => ev.live.push(l));
  dev.on('sync', (p) => ev.sync.push(p));
  dev.on('battery', (b) => ev.battery.push(b));
  return { bt, strap: bt.strap, dev, ev, stored };
}

function assertSafe(strap: ReturnType<typeof setup>['strap']) {
  expect(strap.forbidden).toEqual([]);
  expect(strap.received.some((c) => NEVER_SEND.has(c.opcode))).toBe(false);
  expect(strap.received.some((c) => c.opcode === Opcode.SET_GENERIC_HR_PROFILE)).toBe(false);
  expect(strap.concurrentWriteErrors).toBe(0);
}

describe('WhoopDevice gegen das simulierte Band', () => {
  it('isSupported', () => {
    expect(WhoopDevice.isSupported(createFakeBluetooth())).toBe(true);
    expect(WhoopDevice.isSupported({})).toBe(false);
    expect(WhoopDevice.isSupported(undefined)).toBe(false); // node: kein navigator.bluetooth
  });

  it('verbindet in der richtigen Reihenfolge, stellt die Uhr, liest Akku und Seriennummer', async () => {
    const { dev, strap, ev } = setup();
    await dev.connect();
    expect(dev.state).toBe('connected');
    expect(ev.states).toEqual(['connecting', 'connected']);
    expect(dev.info).toEqual({ name: 'WHOOP 4A1B2C3D4', serial: '4A1B2C3D4' });
    expect(Object.keys(dev.info!).sort()).toEqual(['name', 'serial']); // kein Schlüsselmaterial
    expect(ev.battery[0]).toEqual({ percent: 87.5 });

    const ops = strap.received.map((c) => c.opcode);
    expect(ops.slice(0, 6)).toEqual([
      Opcode.GET_BATTERY_LEVEL,
      Opcode.SET_CLOCK,
      Opcode.GET_CLOCK,
      Opcode.GET_HELLO_HARVARD,
      Opcode.GET_ADVERTISING_NAME,
      Opcode.GET_DATA_RANGE,
    ]);
    // Banduhr wurde von 1970 auf jetzt gestellt.
    expect(Math.abs(strap.clockOffsetMs)).toBeLessThan(1000);
    expect(ev.logs.some((l) => l.startsWith('Uhr gestellt'))).toBe(true);
    expect(ev.logs.some((l) => l.includes('Bandname: WHOOP 4A1B2C3D4'))).toBe(true);

    // Sequenznummern laufen hoch
    const seqs = strap.received.map((c) => c.seq);
    expect(new Set(seqs).size).toBe(seqs.length);

    // Keepalive
    await until(() => strap.received.some((c) => c.opcode === Opcode.LINK_VALID));
    expect(await dev.getBattery()).toBe(87.5);
    assertSafe(strap);
  });

  it('warnt, wenn die Uhr nicht übernommen wird (ein Wiederholversuch)', async () => {
    const { dev, strap, ev } = setup({ ignoreSetClock: true });
    await dev.connect();
    const sets = strap.received.filter((c) => c.opcode === Opcode.SET_CLOCK);
    expect(sets).toHaveLength(2);
    expect(ev.logs.some((l) => l.startsWith('Warnung: Banduhr weicht'))).toBe(true);
    expect(dev.state).toBe('connected');
  });

  it('Echtzeit-Puls 0x28 → live-Events', async () => {
    const { dev, strap, ev } = setup();
    await dev.connect();
    await dev.setRealtimeHr(true);
    expect(strap.realtimeOn).toBe(true);
    await until(() => ev.live.length >= 5);
    for (const l of ev.live) {
      expect(l.hr).toBeGreaterThan(30);
      expect(l.wearing).toBe(true);
      expect(Math.abs(l.ts - Date.now() / 1000)).toBeLessThan(5);
      for (const rr of l.rr) expect(rr).toBeGreaterThanOrEqual(200);
    }
    await dev.setRealtimeHr(false);
    expect(strap.realtimeOn).toBe(false);
    await sleep(30);
    const n = ev.live.length;
    await sleep(80);
    expect(ev.live.length).toBe(n);
  });

  it('Standard-HR 0x2A37 nur als Zweitquelle, wenn Echtzeit aus ist', async () => {
    const { dev, strap, ev } = setup({ standardHrBroadcast: true });
    await dev.connect();
    await until(() => ev.live.length >= 3); // aus 0x2A37
    await dev.setRealtimeHr(true);
    await sleep(30);
    ev.live.length = 0;
    strap.realtimePacketsSent = 0;
    strap.stdHrPacketsSent = 0;
    await sleep(200);
    expect(strap.stdHrPacketsSent).toBeGreaterThan(3);
    expect(strap.realtimePacketsSent).toBeGreaterThan(3);
    expect(ev.live.length).toBe(strap.realtimePacketsSent); // keine Doppelmeldungen
  });

  it('vollständiger Verlauf über mehrere Blöcke: jeder Datensatz genau einmal, Ack erst nach dem Commit', async () => {
    const stored: SampleRecord[] = [];
    let strapRef: ReturnType<typeof setup>['strap'] | null = null;
    const ackCountsDuringCommit: [number, number][] = [];
    const sink: RecordSink = async (records) => {
      const before = strapRef!.acks.length;
      await sleep(25); // langsamer "Datenbank"-Commit
      ackCountsDuringCommit.push([before, strapRef!.acks.length]);
      stored.push(...records);
    };
    const { dev, strap, ev } = setup({}, sink);
    strapRef = strap;
    await dev.connect();
    const n = await dev.syncHistory();
    expect(n).toBe(1500);
    expect(stored).toHaveLength(1500);
    const ts = stored.map((r) => r.ts);
    expect(new Set(ts).size).toBe(1500);
    expect(Math.min(...ts)).toBe(START);
    expect(Math.max(...ts)).toBe(START + 1499);
    for (const r of stored) {
      expect(r.src).toBe('history');
      expect(r.hr).toBeGreaterThan(30);
      expect(r.grav).toHaveLength(3);
      for (const x of r.rr) expect(x >= 200 && x <= 2500).toBe(true);
      expect(Object.keys(r).sort()).toEqual(['grav', 'hr', 'rr', 'src', 'ts']);
    }
    // Während des Commits kam kein Ack an; danach genau einer pro Block.
    expect(ackCountsDuringCommit).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(strap.acks.map((a) => a.accepted)).toEqual([true, true, true]);
    expect(strap.cursor).toBe(1500);
    expect(strap.batchesSent).toBe(3);
    const last = ev.sync.at(-1)!;
    expect(last).toEqual({ records: 1500, newestTs: START + 1499, done: true, ok: true });
    expect(ev.sync[0]).toEqual({ records: 0, newestTs: null, done: false });
    expect(ev.states).toContain('syncing');
    expect(dev.state).toBe('connected');
    assertSafe(strap);

    // Zweiter Sync: nichts Neues.
    expect(await dev.syncHistory()).toBe(0);
  });

  it('Verlauf bei eingeschaltetem Echtzeit-Puls: jeder Datensatz genau einmal, alle Acks korrekt', async () => {
    const stored: SampleRecord[] = [];
    const sink: RecordSink = async (records) => {
      await sleep(15); // Commit dauert, während Echtzeitpakete weiterlaufen
      stored.push(...records);
    };
    const { dev, strap, ev } = setup({ historySeconds: 1800, realtimeIntervalMs: 5 }, sink);
    await dev.connect();
    await dev.setRealtimeHr(true);
    await until(() => ev.live.length >= 3);
    const liveBefore = ev.live.length;
    const n = await dev.syncHistory();
    expect(n).toBe(1800);
    expect(stored).toHaveLength(1800);
    const ts = stored.map((r) => r.ts);
    expect(new Set(ts).size).toBe(1800);
    expect(Math.min(...ts)).toBe(START);
    expect(Math.max(...ts)).toBe(START + 1799);
    expect(stored.every((r) => r.src === 'history')).toBe(true);
    // Echtzeitpakete kamen während des Syncs weiter an und landeten nicht im Verlauf.
    expect(ev.live.length).toBeGreaterThan(liveBefore + 5);
    expect(strap.realtimePacketsSent).toBeGreaterThan(10);
    expect(strap.acks.map((a) => a.accepted)).toEqual([true, true, true]);
    expect(strap.batchesSent).toBe(3);
    expect(strap.cursor).toBe(1800);
    expect(ev.errors).toEqual([]);
    assertSafe(strap);
    expect(await dev.syncHistory()).toBe(0);
  });

  it('Sink-Fehler → kein Ack, Abbruch mit ABORT, nächster Sync setzt beim unbestätigten Block fort', async () => {
    let calls = 0;
    const stored: SampleRecord[] = [];
    const sink: RecordSink = async (r) => {
      calls++;
      if (calls === 2) throw new Error('Quota exceeded');
      stored.push(...r);
    };
    const { dev, strap, ev } = setup({}, sink);
    await dev.connect();
    await expect(dev.syncHistory()).rejects.toThrow(/Quota exceeded/);
    expect(ev.errors.some((e) => /Speichern fehlgeschlagen/.test(e.message))).toBe(true);
    expect(strap.acks).toHaveLength(1);
    expect(strap.cursor).toBe(600);
    await until(() => strap.received.some((c) => c.opcode === Opcode.ABORT_HISTORICAL_TRANSMITS));
    expect(dev.state).toBe('connected');
    expect(ev.sync.at(-1)).toMatchObject({ done: true, ok: false });
    expect(ev.sync.at(-1)!.error).toMatch(/Quota exceeded/);

    const n = await dev.syncHistory();
    expect(n).toBe(900);
    expect(stored).toHaveLength(1500);
    expect(new Set(stored.map((r) => r.ts)).size).toBe(1500);
    assertSafe(strap);
  });

  it('automatischer Sync nach dem Verbinden', async () => {
    const { dev, strap, stored, ev } = setup({ historySeconds: 700 }, undefined, { autoSync: true });
    await dev.connect();
    await until(() => ev.sync.some((p) => p.done));
    expect(stored).toHaveLength(700);
    expect(strap.cursor).toBe(700);
  });

  it('leerer Speicher → 0 Datensätze', async () => {
    const { dev } = setup({ historySeconds: 0 });
    await dev.connect();
    expect(await dev.syncHistory()).toBe(0);
  });

  it('Verbindungsabbruch: Timer gestoppt, offene Kommandos abgelehnt, kein Ack, Wiederverbinden', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stored: SampleRecord[] = [];
    const sink: RecordSink = async (r) => {
      await gate;
      stored.push(...r);
    };
    const { dev, strap, ev } = setup({}, sink);
    await dev.connect();
    const sync = dev.syncHistory();
    await until(() => strap.batchesSent === 1 && ev.logs.some((l) => l.includes('Verlaufsübertragung')));
    await sleep(20); // Block ist angekommen, Sink hängt
    const pendingBattery = dev.getBattery().then(
      () => null,
      (e: Error) => e,
    );
    strap.dropLink();
    await expect(sync).rejects.toThrow(/getrennt/);
    expect(await pendingBattery).toBeInstanceOf(Error);
    await until(() => dev.state === 'disconnected');
    release();
    await sleep(20);
    expect(strap.acks).toHaveLength(0); // nach dem Abbruch nicht bestätigt
    const count = strap.received.length;
    await sleep(100); // Keepalive-Timer darf nicht mehr laufen
    expect(strap.received.length).toBe(count);
    await expect(dev.setRealtimeHr(true)).rejects.toThrow(/Nicht verbunden/);

    // Wiederverbinden über getDevices(); der unbestätigte Block kommt erneut.
    expect(await dev.reconnect()).toBe(true);
    expect(dev.state).toBe('connected');
    expect(await dev.syncHistory()).toBe(1500);
    expect(new Set(stored.map((r) => r.ts)).size).toBe(1500);
    assertSafe(strap);
  });

  it('gatt.connect() hängt → Zeitüberschreitung, Zustand disconnected, erneuter connect() möglich', async () => {
    const { dev, strap, ev } = setup({}, undefined, { connectTimeoutMs: 150 });
    strap.hangConnect = true;
    await expect(dev.connect()).rejects.toThrow(/nicht erreichbar/);
    expect(dev.state).toBe('disconnected');
    expect(ev.errors.some((e) => /Zeitüberschreitung beim Verbinden/.test(e.message))).toBe(true);
    // reconnect() gegen ein Band außer Reichweite bleibt nicht in 'connecting' hängen
    expect(await dev.reconnect()).toBe(false);
    expect(dev.state).toBe('disconnected');
    strap.hangConnect = false;
    await dev.connect();
    expect(dev.state).toBe('connected');
  });

  it('disconnect() bricht einen hängenden Verbindungsaufbau sofort ab', async () => {
    const { dev, strap } = setup({}, undefined, { connectTimeoutMs: 60_000 });
    strap.hangConnect = true;
    const p = dev.connect().then(
      () => null,
      (e: Error) => e,
    );
    await until(() => dev.state === 'connecting');
    await sleep(20);
    await dev.disconnect();
    expect(dev.state).toBe('disconnected');
    expect(await p).toBeInstanceOf(Error);
  });

  it('erster Write (Kopplung) hängt → Zeitüberschreitung, Verbindung abgebaut', async () => {
    const { dev, strap } = setup({}, undefined, { firstWriteTimeoutMs: 150, writeTimeoutMs: 50 });
    strap.hangWriteOpcodes.add(Opcode.GET_BATTERY_LEVEL);
    await expect(dev.connect()).rejects.toThrow(/Keine Antwort vom Band/);
    expect(dev.state).toBe('disconnected');
    expect(strap.connected).toBe(false);
  });

  it('Ack-Write hängt während des Syncs → Sync scheitert, Zustand disconnected', async () => {
    const { dev, strap, ev, stored } = setup({}, undefined, { writeTimeoutMs: 150 });
    await dev.connect();
    strap.hangWriteOpcodes.add(Opcode.HISTORICAL_DATA_RESULT);
    await expect(dev.syncHistory()).rejects.toThrow(/hängt/);
    await until(() => dev.state === 'disconnected');
    expect(stored).toHaveLength(600); // gespeichert, aber nicht bestätigt → kommt erneut
    expect(strap.cursor).toBe(0);
    expect(ev.sync.at(-1)).toMatchObject({ done: true, ok: false });
  });

  it('unbekanntes Datensatz-Layout → kein Ack, Abbruch, Daten bleiben auf dem Band', async () => {
    const { dev, strap, ev, stored } = setup();
    strap.corruptRecordIndex = 700; // im zweiten Block
    await dev.connect();
    await expect(dev.syncHistory()).rejects.toThrow(/Unbekanntes Datenformat \(Layout 99/);
    expect(strap.acks).toHaveLength(1); // nur der erste, fehlerfreie Block
    expect(strap.cursor).toBe(600);
    expect(stored).toHaveLength(600);
    expect(ev.errors.some((e) => /Daten bleiben auf dem Band/.test(e.message))).toBe(true);
    await until(() => strap.received.some((c) => c.opcode === Opcode.ABORT_HISTORICAL_TRANSMITS));
    expect(ev.sync.at(-1)).toMatchObject({ done: true, ok: false });
    assertSafe(strap);
  });

  it('Echtzeitpakete mit ungestellter Banduhr bekommen die Telefonzeit', async () => {
    const { dev, strap, ev } = setup({ ignoreSetClock: true });
    await dev.connect();
    await dev.setRealtimeHr(true);
    await until(() => ev.live.length >= 3);
    expect(strap.clockOffsetMs).toBeLessThan(-1e12); // Band steht auf 1970
    for (const l of ev.live) expect(Math.abs(l.ts - Date.now() / 1000)).toBeLessThan(5);
    expect(ev.logs.filter((l) => l.includes('Uhrzeit des Telefons'))).toHaveLength(1);
  });

  it('Band antwortet nicht auf die Verlaufsanfrage → Fehler, ok: false', async () => {
    const { dev, strap, ev } = setup({}, undefined, { syncIdleTimeoutMs: 100 });
    await dev.connect();
    strap.ignoreHistoryRequests = true;
    await expect(dev.syncHistory()).rejects.toThrow(/Keine Verlaufsdaten/);
    expect(ev.sync.at(-1)).toMatchObject({ done: true, ok: false });
    expect(dev.state).toBe('connected');
  });

  it('reconnect() ohne getDevices → false', async () => {
    const { dev } = setup({ getDevices: false });
    expect(await dev.reconnect()).toBe(false);
    expect(dev.state).toBe('disconnected');
  });

  it('disconnect() durch den Nutzer', async () => {
    const { dev, strap, ev } = setup();
    await dev.connect();
    await dev.disconnect();
    expect(dev.state).toBe('disconnected');
    expect(strap.connected).toBe(false);
    await sleep(10);
    expect(ev.states).toEqual(['connecting', 'connected', 'disconnected']);
  });

  it('Batterie- und Trage-Ereignisse auf 0004', async () => {
    const { dev, strap, ev } = setup();
    await dev.connect();
    strap.sendBatteryEvent(55.5, true);
    strap.sendEvent(10);
    await until(() => ev.battery.length >= 2);
    expect(ev.battery.at(-1)).toEqual({ percent: 55.5, charging: true });
    await until(() => ev.logs.includes('Band abgenommen'));
  });

  it('Wecker und Vibration', async () => {
    const { dev, strap } = setup();
    await dev.connect();
    const at = new Date(Date.now() + 3600_000);
    await dev.setAlarm(at);
    expect(strap.alarmAt).toBe(Math.floor(at.getTime() / 1000));
    await dev.setAlarm(null);
    expect(strap.alarmAt).toBeNull();
    await expect(dev.setAlarm(new Date(Date.now() - 1000))).rejects.toThrow(/Vergangenheit/);
    await dev.buzz();
    expect(strap.hapticsRuns).toBe(1);
    assertSafe(strap);
  });

  it('Kurzer Haptik-Impuls sendet nur RUN_HAPTICS_PATTERN (kein RUN_ALARM)', async () => {
    const { dev, strap } = setup();
    await dev.connect();
    const before = strap.received.length;
    await dev.haptic();
    await dev.haptic(3, 2);
    expect(strap.hapticsRuns).toBe(2);
    expect(strap.hapticsPatterns).toEqual([[2, 1], [3, 2]]);
    // Herzschlag-Kommandos laufen parallel – nur Haptik/Alarm betrachten.
    const ops = strap.received
      .slice(before)
      .map((c) => c.opcode)
      .filter((op) => op === Opcode.RUN_HAPTICS_PATTERN || op === Opcode.RUN_ALARM);
    expect(ops).toEqual([Opcode.RUN_HAPTICS_PATTERN, Opcode.RUN_HAPTICS_PATTERN]);
    expect(ops).not.toContain(Opcode.RUN_ALARM);
    await dev.disconnect();
    await expect(dev.haptic()).rejects.toThrow(/Nicht verbunden/);
    assertSafe(strap);
  });

  it('Simulierter Echtzeitpuls folgt einem Zielpuls', async () => {
    const { dev, strap, ev } = setup({ liveHrTarget: 150 });
    await dev.connect();
    await dev.setRealtimeHr(true);
    await until(() => ev.live.length >= 15, 3000);
    expect(ev.live.at(-1)!.hr).toBeGreaterThan(140);
    strap.liveHrTarget = 100;
    const n = ev.live.length;
    await until(() => ev.live.length >= n + 15, 3000);
    expect(ev.live.at(-1)!.hr).toBeLessThan(110);
  });

  it('Kopplungsdialog: langer erster Write wird abgewartet', async () => {
    const { dev } = setup({ bondDelayMs: 300 }, undefined, { commandTimeoutMs: 100 });
    await dev.connect();
    expect(dev.state).toBe('connected');
  });
});

describe('Simuliertes Band auf Protokollebene', () => {
  it('wiederholt den Block bei falschem Token und liefert den nächsten erst nach dem richtigen', async () => {
    const bt = createFakeBluetooth({ latencyMs: 1, start: START, historySeconds: 250, batchSize: 100, chunkSize: 244 });
    const device = await bt.requestDevice({ filters: [{ services: [SERVICE] }] });
    const server = await device.gatt!.connect();
    const svc = await server.getPrimaryService(SERVICE);
    const write = await svc.getCharacteristic(CMD_TO_STRAP);
    const data = await svc.getCharacteristic(DATA_FROM_STRAP);
    const asm = new FrameReassembler();
    const batches: { first: number; count: number; token: Uint8Array }[] = [];
    let current: number[] = [];
    let complete = false;
    let maxChunk = 0;
    data.addEventListener('characteristicvaluechanged', () => {
      const v = data.value!;
      maxChunk = Math.max(maxChunk, v.byteLength);
      for (const inner of asm.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))) {
        const r = parseHistoryRecord(inner);
        if (r) current.push(r.ts);
        const m = parseMetadata(inner);
        if (m?.subtype === MetadataType.HISTORY_END) {
          expect(m.expectedCount).toBe(current.length);
          batches.push({ first: current[0]!, count: current.length, token: m.token! });
          current = [];
        }
        if (m?.subtype === MetadataType.HISTORY_COMPLETE) complete = true;
      }
    });
    await data.startNotifications();
    await write.writeValueWithResponse!(sendHistoricalData(1));
    await until(() => batches.length === 1);
    expect(maxChunk).toBe(244);
    // Falsches Token → gleicher Block erneut
    const wrong = Uint8Array.from(batches[0]!.token);
    wrong[7] ^= 0xff;
    await write.writeValueWithResponse!(historyAck(2, wrong));
    await until(() => batches.length === 2);
    expect(batches[1]!.first).toBe(batches[0]!.first);
    expect(bt.strap.cursor).toBe(0);
    // Richtiges Token → nächster Block
    await write.writeValueWithResponse!(historyAck(3, batches[1]!.token));
    await until(() => batches.length === 3);
    expect(batches[2]!.first).toBe(START + 100);
    await write.writeValueWithResponse!(historyAck(4, batches[2]!.token));
    await until(() => batches.length === 4);
    expect(batches[3]!.count).toBe(50);
    await write.writeValueWithResponse!(historyAck(5, batches[3]!.token));
    await until(() => complete);
    expect(bt.strap.acks.map((a) => a.accepted)).toEqual([false, true, true, true]);
    server.disconnect();
  });
});

describe('Synthetische Physiologie', () => {
  const day = generate(START - (START % 86400), 86400 * 2, { seed: 7, utcOffsetMin: 0 });

  it('ist deterministisch', () => {
    const a = generate(START, 500, { seed: 3, utcOffsetMin: 60 });
    const b = generate(START, 500, { seed: 3, utcOffsetMin: 60 });
    expect(a).toEqual(b);
    expect(generate(START, 500, { seed: 4, utcOffsetMin: 60 })).not.toEqual(a);
  });

  it('Tagesmuster: Schlaf niedrig, Training hoch', () => {
    const at = (h: number) => day.slice(86400 + h * 3600, 86400 + h * 3600 + 600);
    const avg = (xs: { hr: number }[]) => xs.reduce((s, x) => s + x.hr, 0) / xs.length;
    const sleep3 = at(3).filter((s) => s.phase === 'sleep');
    expect(avg(sleep3)).toBeGreaterThan(46);
    expect(avg(sleep3)).toBeLessThan(62);
    expect(avg(at(11))).toBeGreaterThan(62);
    expect(avg(at(11))).toBeLessThan(100);
    const workout = day.slice(86400).filter((s) => s.phase === 'workout');
    expect(workout.length).toBeGreaterThan(35 * 60);
    expect(workout.length).toBeLessThan(55 * 60);
    expect(Math.max(...workout.map((s) => s.hr))).toBeGreaterThan(130);
    const wakeSecs = day.slice(86400).filter((s) => s.phase === 'wake').length;
    expect(wakeSecs).toBeGreaterThan(5 * 60);
  });

  it('RR passt zur HR, HRV im Schlaf höher; Schlaf ist ruhig', () => {
    const rmssd = (xs: { rr: number[] }[]) => {
      const rr = xs.flatMap((x) => x.rr);
      let s = 0;
      for (let i = 1; i < rr.length; i++) s += (rr[i]! - rr[i - 1]!) ** 2;
      return Math.sqrt(s / (rr.length - 1));
    };
    const sleepPart = day.slice(86400 + 2 * 3600, 86400 + 3 * 3600).filter((s) => s.phase === 'sleep');
    const dayPart = day.slice(86400 + 11 * 3600, 86400 + 12 * 3600);
    expect(rmssd(sleepPart)).toBeGreaterThan(rmssd(dayPart));
    for (const part of [sleepPart, dayPart]) {
      const rr = part.flatMap((x) => x.rr);
      const meanRr = rr.reduce((a, b) => a + b, 0) / rr.length;
      const meanHr = part.reduce((a, b) => a + b.hr, 0) / part.length;
      expect(Math.abs(60000 / meanRr - meanHr) / meanHr).toBeLessThan(0.1);
    }
    const motion = (xs: { grav: number[] }[]) => {
      let s = 0;
      for (let i = 1; i < xs.length; i++) s += Math.hypot(...xs[i]!.grav.map((g, k) => g - xs[i - 1]!.grav[k]!));
      return s / xs.length;
    };
    expect(motion(sleepPart)).toBeLessThan(motion(dayPart) / 5);
    for (const s of day.slice(0, 1000)) expect(Math.abs(Math.hypot(...s.grav) - 1.046)).toBeLessThan(0.01);
  });
});
