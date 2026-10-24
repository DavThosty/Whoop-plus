import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Speicher und Plattform werden ersetzt; das Band ist das simulierte (fake-strap) bzw. ein Stub.
const h = vi.hoisted(() => ({ bt: undefined as unknown }));
vi.mock('../ble/platform', () => ({ platformBluetooth: () => h.bt, isNativeApp: () => false }));
vi.mock('../store/share-file', () => ({ shareFileNative: vi.fn() }));
vi.mock('../store/pipeline', () => ({ recomputeRange: vi.fn(async () => []) }));
vi.mock('../store/db', () => ({
  exportBackup: vi.fn(),
  getKv: vi.fn(async () => undefined),
  getProfile: vi.fn(async () => undefined),
  importBackup: vi.fn(),
  onDbNotice: vi.fn(),
  pruneSamples: vi.fn(async () => {}),
  putSamples: vi.fn(async () => {}),
  requestPersistence: vi.fn(async () => true),
  sampleBounds: vi.fn(async () => ({ oldest: null, newest: null, count: 0 })),
  setKv: vi.fn(async () => {}),
  setProfile: vi.fn(async () => {}),
  storageEstimate: vi.fn(async () => null),
}));

import { createFakeBluetooth, type FakeBluetooth } from '../sim/fake-strap';
import { WhoopDevice } from '../ble/whoop';
import { AppController } from './controller';

type Internals = {
  tryReconnect(): Promise<void>;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
};
const internals = (c: AppController) => c as unknown as Internals;

const controllers: AppController[] = [];
function makeController(): AppController {
  const c = new AppController();
  controllers.push(c);
  return c;
}

/** Simuliertes Band, bereits einmal freigegeben (wie nach einem früheren Verbinden), mit Zähler für gatt.connect(). */
async function grantedStrap(): Promise<{ bt: FakeBluetooth; connects: () => number }> {
  const bt = createFakeBluetooth({ latencyMs: 1, historySeconds: 120, start: Math.floor(Date.now() / 1000) - 200, realtimeIntervalMs: 20 });
  await bt.requestDevice({ filters: [{ namePrefix: 'WHOOP' }] });
  const gatt = bt.strap.device.gatt;
  const orig = gatt.connect.bind(gatt);
  let n = 0;
  gatt.connect = () => {
    n++;
    return orig();
  };
  h.bt = bt;
  return { bt, connects: () => n };
}

/** Band, das iOS noch kennt (getDevices), das aber nicht erreichbar ist: connect schlägt sofort fehl. */
function unreachableStrap() {
  const listeners = new Set<() => void>();
  const device = {
    id: 'whoop-1',
    name: 'WHOOP 4C123',
    gatt: {
      connected: false,
      connect: vi.fn(async () => {
        throw new Error('Connection timeout.');
      }),
      disconnect: vi.fn(),
      getPrimaryService: vi.fn(),
    },
    addEventListener: (_t: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_t: string, l: () => void) => void listeners.delete(l),
  };
  (device.gatt as unknown as { device: unknown }).device = device;
  const bt = {
    requestDevice: vi.fn(async () => device),
    getDevices: vi.fn(async () => [device]),
  };
  h.bt = bt;
  return { bt, device };
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('Bedingung nicht erfüllt');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  h.bt = undefined;
});

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.disconnect();
});

describe('AppController: Verbindungsaufbau', () => {
  it('Timer-Wiederverbindung und Rückkehr in die App gleichzeitig → genau ein Gerät, ein Aufbau', async () => {
    const { connects } = await grantedStrap();
    const c = makeController();
    await Promise.all([internals(c).tryReconnect(), c.reconnectRemembered(), internals(c).tryReconnect(), c.reconnectRemembered()]);
    expect(c.state.conn === 'connected' || c.state.conn === 'syncing').toBe(true);
    expect(connects()).toBe(1);
    // Verbunden: weitere automatische Versuche ersetzen das Gerät nicht.
    await Promise.all([internals(c).tryReconnect(), c.reconnectRemembered()]);
    expect(connects()).toBe(1);
    expect(c.state.error).toBeNull();
  });

  it('Tipp auf „Band verbinden“ während eines automatischen Versuchs wartet ihn ab statt ein zweites Gerät aufzubauen', async () => {
    const { connects } = await grantedStrap();
    const c = makeController();
    const auto = internals(c).tryReconnect();
    const manual = c.connect();
    const manual2 = c.connect(); // Doppeltipp
    await Promise.all([auto, manual, manual2]);
    expect(c.state.conn === 'connected' || c.state.conn === 'syncing').toBe(true);
    expect(connects()).toBe(1);
  });

  it('gescheiterte automatische Versuche sind leise: kein Fehlerbanner, nur Protokoll und „nicht in Reichweite“', async () => {
    const { device } = unreachableStrap();
    const c = makeController();
    await internals(c).tryReconnect();
    expect(device.gatt.connect).toHaveBeenCalledTimes(1);
    expect(c.state.conn).toBe('disconnected');
    expect(c.state.error).toBeNull();
    expect(c.state.outOfRange).toBe(true);
    expect(c.state.log.some((l) => l.includes('Automatisches Verbinden'))).toBe(true);
    // Ein Wiederholungsversuch ist geplant (5 s) …
    expect(internals(c).reconnectTimer).not.toBeNull();
    expect(internals(c).reconnectAttempt).toBe(1);

    // … die Rückkehr in die App zieht ihn vor, ohne den Zyklus neu zu starten – und bleibt leise.
    await c.reconnectRemembered();
    expect(device.gatt.connect).toHaveBeenCalledTimes(2);
    expect(internals(c).reconnectAttempt).toBe(2);
    expect(c.state.error).toBeNull();

    // Ein Tipp auf „Band verbinden“ zeigt echte Fehler.
    await c.connect();
    expect(c.state.error).toMatch(/Connection timeout|Verbindung fehlgeschlagen|Band/);
    expect(c.state.outOfRange).toBe(false);
  });

  it('Rückkehr in die App bei geplantem Versuch: Zähler bleibt, Timer wird vorgezogen', async () => {
    h.bt = createFakeBluetooth({ latencyMs: 1 }); // nichts freigegeben → getDevices() leer
    const c = makeController();
    const i = internals(c);
    i.reconnectAttempt = 2;
    i.reconnectTimer = setTimeout(() => {}, 1e6);
    await c.reconnectRemembered();
    expect(i.reconnectTimer).toBeNull();
    expect(i.reconnectAttempt).toBe(2);
    expect(c.state.conn).toBe('disconnected');
    expect(c.state.outOfRange).toBe(false);
  });
});

describe('AppController: Live-Puls automatisch', () => {
  it('schaltet Live-Puls nach dem Verbinden ein, respektiert „aus“ bis zum Trennen und ist danach wieder an', async () => {
    const { bt } = await grantedStrap();
    const c = makeController();
    await internals(c).tryReconnect();
    await until(() => c.state.liveOn && c.state.live != null && c.state.live.hr > 0);
    expect(c.liveWanted).toBe(true);
    expect(c.state.error).toBeNull();

    await c.setLive(false);
    expect(c.state.liveOn).toBe(false);
    expect(c.liveWanted).toBe(false);

    // Ein Workout schaltet Live nur vorübergehend ein und ändert die Wahl des Nutzers nicht.
    await c.setLive(true, false);
    expect(c.state.liveOn).toBe(true);
    expect(c.liveWanted).toBe(false);
    await c.setLive(false);

    // Verbindungsabbruch → automatisch neu verbinden → Live wieder an.
    bt.strap.dropLink();
    await until(() => c.state.conn === 'disconnected');
    expect(c.liveWanted).toBe(true);
    await c.reconnectRemembered();
    await until(() => c.state.liveOn);
    expect(bt.strap.realtimeOn).toBe(true);
  });

  it('versucht es bei einem Fehler nicht in einer Schleife und zeigt kein Banner', async () => {
    await grantedStrap();
    const spy = vi.spyOn(WhoopDevice.prototype, 'setRealtimeHr').mockRejectedValue(new Error('Band antwortet nicht'));
    try {
      const c = makeController();
      await internals(c).tryReconnect();
      await until(() => spy.mock.calls.length >= 1);
      await new Promise((r) => setTimeout(r, 300));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(c.state.liveOn).toBe(false);
      expect(c.state.error).toBeNull();
      expect(c.state.log.some((l) => l.includes('Live-Puls automatisch einschalten'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
