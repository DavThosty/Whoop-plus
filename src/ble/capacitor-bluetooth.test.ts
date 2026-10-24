import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEART_RATE_MEASUREMENT, HEART_RATE_SERVICE, SERVICE, CMD_TO_STRAP, DATA_FROM_STRAP } from '../protocol/constants';
import { createFakeBluetooth, type FakeBluetooth } from '../sim/fake-strap';
import type { SampleRecord } from '../types';
import { WhoopDevice, type WhoopTimings } from './whoop';

// BleClient (Capacitor-Plugin) wird komplett ersetzt; jede Methode ist ein vi.fn(), das die Tests belegen.
const m = vi.hoisted(() => ({
  BleClient: {
    initialize: vi.fn(),
    isEnabled: vi.fn(),
    requestDevice: vi.fn(),
    getDevices: vi.fn(),
    connect: vi.fn(),
    getServices: vi.fn(),
    startNotifications: vi.fn(),
    stopNotifications: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    writeWithoutResponse: vi.fn(),
  },
  BluetoothLe: { disconnect: vi.fn() },
}));

vi.mock('@capacitor-community/bluetooth-le', () => ({
  BleClient: m.BleClient,
  BluetoothLe: m.BluetoothLe,
  numberToUUID: (v: number) => `0000${v.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`,
}));

import { CapacitorBluetooth, DEVICE_STORAGE_KEY, toRequestOptions, toUuid } from './capacitor-bluetooth';

const HR_SVC = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_CHR = '00002a37-0000-1000-8000-00805f9b34fb';

function memStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const SERVICES = [
  { uuid: SERVICE, characteristics: [CMD_TO_STRAP, DATA_FROM_STRAP].map((uuid) => ({ uuid, properties: {}, descriptors: [] })) },
  { uuid: HR_SVC, characteristics: [{ uuid: HR_CHR, properties: { notify: true }, descriptors: [] }] },
];

/** Plugin-Verhalten für Einzeltests: alles gelingt sofort. */
function happyPlugin() {
  m.BleClient.initialize.mockResolvedValue(undefined);
  m.BleClient.isEnabled.mockResolvedValue(true);
  m.BleClient.requestDevice.mockResolvedValue({ deviceId: 'dev-1', name: 'WHOOP 4C0000001' });
  m.BleClient.getDevices.mockImplementation(async (ids: string[]) => ids.map((deviceId) => ({ deviceId })));
  m.BleClient.connect.mockResolvedValue(undefined);
  m.BleClient.getServices.mockResolvedValue(SERVICES);
  m.BleClient.startNotifications.mockResolvedValue(undefined);
  m.BleClient.stopNotifications.mockResolvedValue(undefined);
  m.BleClient.write.mockResolvedValue(undefined);
  m.BleClient.writeWithoutResponse.mockResolvedValue(undefined);
  m.BleClient.read.mockResolvedValue(new DataView(new Uint8Array([42]).buffer));
  m.BluetoothLe.disconnect.mockResolvedValue(undefined);
}

beforeEach(() => {
  for (const fn of [...Object.values(m.BleClient), m.BluetoothLe.disconnect]) fn.mockReset();
  happyPlugin();
});

async function connected(storage = memStorage()) {
  const bt = new CapacitorBluetooth({ storage });
  const dev = await bt.requestDevice({ filters: [{ services: [SERVICE] }, { namePrefix: 'WHOOP' }] });
  const server = await dev.gatt!.connect();
  return { bt, dev, server, storage };
}

describe('UUIDs und Filter', () => {
  it('normalisiert Web-Bluetooth-Namen, Zahlen und Kurzformen', () => {
    expect(toUuid(HEART_RATE_SERVICE)).toBe(HR_SVC);
    expect(toUuid(HEART_RATE_MEASUREMENT)).toBe(HR_CHR);
    expect(toUuid('battery_service')).toBe('0000180f-0000-1000-8000-00805f9b34fb');
    expect(toUuid(0x180d)).toBe(HR_SVC);
    expect(toUuid('2A37')).toBe(HR_CHR);
    expect(toUuid(SERVICE.toUpperCase())).toBe(SERVICE);
  });

  it('übersetzt die WHOOP-Filter (Dienst ODER Namenspräfix) in einen Namenspräfix-Scan', () => {
    const o = toRequestOptions({
      filters: [{ services: [SERVICE] }, { namePrefix: 'WHOOP' }],
      optionalServices: [SERVICE, 'heart_rate', 'battery_service'],
    });
    expect(o).toEqual({
      displayMode: 'list',
      namePrefix: 'WHOOP',
      optionalServices: [SERVICE, HR_SVC, '0000180f-0000-1000-8000-00805f9b34fb'],
    });
  });

  it('übernimmt einen einzelnen Filter 1:1 und vereinigt reine Dienstfilter', () => {
    expect(toRequestOptions({ filters: [{ services: [SERVICE], namePrefix: 'WHOOP' }] })).toEqual({
      displayMode: 'list',
      services: [SERVICE],
      namePrefix: 'WHOOP',
    });
    expect(toRequestOptions({ filters: [{ services: [SERVICE] }, { services: ['heart_rate'] }] }).services).toEqual([SERVICE, HR_SVC]);
    expect(toRequestOptions({ acceptAllDevices: true })).toEqual({ displayMode: 'list' });
  });
});

describe('requestDevice / getDevices', () => {
  it('initialisiert einmal, zeigt den nativen Dialog und merkt sich das Gerät', async () => {
    const storage = memStorage();
    const bt = new CapacitorBluetooth({ storage });
    const dev = await bt.requestDevice({ filters: [{ namePrefix: 'WHOOP' }] });
    await bt.requestDevice({ filters: [{ namePrefix: 'WHOOP' }] });
    expect(m.BleClient.initialize).toHaveBeenCalledTimes(1);
    expect(m.BleClient.requestDevice).toHaveBeenCalledWith({ displayMode: 'list', namePrefix: 'WHOOP' });
    expect(dev.id).toBe('dev-1');
    expect(dev.name).toBe('WHOOP 4C0000001');
    expect(JSON.parse(storage.map.get(DEVICE_STORAGE_KEY)!)).toEqual({ id: 'dev-1', name: 'WHOOP 4C0000001' });
  });

  it('meldet einen Abbruch im Dialog als NotFoundError', async () => {
    m.BleClient.requestDevice.mockRejectedValue(new Error('requestDevice cancelled.'));
    const bt = new CapacitorBluetooth({ storage: memStorage() });
    const err = await bt.requestDevice({}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('NotFoundError');
    expect((err as Error).message).toMatch(/abgebrochen/);
  });

  it('lehnt ab, wenn Bluetooth aus ist, und versucht die Initialisierung nach einem Fehler erneut', async () => {
    m.BleClient.isEnabled.mockResolvedValue(false);
    const bt = new CapacitorBluetooth({ storage: memStorage() });
    await expect(bt.requestDevice({})).rejects.toThrow(/ausgeschaltet/);
    expect(await bt.getAvailability()).toBe(false);

    m.BleClient.initialize.mockRejectedValueOnce(new Error('BLE permission denied'));
    const bt2 = new CapacitorBluetooth({ storage: memStorage() });
    m.BleClient.isEnabled.mockResolvedValue(true);
    await expect(bt2.requestDevice({})).rejects.toThrow(/nicht erlaubt/);
    await expect(bt2.requestDevice({})).resolves.toBeTruthy();
  });

  it('getDevices liefert ohne gemerktes Gerät nichts und sonst das gemerkte (mit gespeichertem Namen)', async () => {
    const storage = memStorage();
    const bt = new CapacitorBluetooth({ storage });
    expect(await bt.getDevices()).toEqual([]);
    expect(m.BleClient.getDevices).not.toHaveBeenCalled();

    storage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ id: 'dev-9', name: 'WHOOP 4C9' }));
    const devs = await new CapacitorBluetooth({ storage }).getDevices();
    expect(m.BleClient.getDevices).toHaveBeenCalledWith(['dev-9']);
    expect(devs.map((d) => [d.id, d.name])).toEqual([['dev-9', 'WHOOP 4C9']]);

    // iOS kennt das Gerät nicht mehr → leer
    m.BleClient.getDevices.mockResolvedValue([]);
    expect(await new CapacitorBluetooth({ storage }).getDevices()).toEqual([]);

    // kaputter Eintrag wird ignoriert
    storage.setItem(DEVICE_STORAGE_KEY, '{kaputt');
    expect(await new CapacitorBluetooth({ storage }).getDevices()).toEqual([]);
  });

  it('forget() löscht das gemerkte Gerät', async () => {
    const { bt, storage } = await connected();
    bt.forget();
    expect(storage.map.has(DEVICE_STORAGE_KEY)).toBe(false);
  });
});

describe('GATT', () => {
  it('verbindet mit Timeout und findet Dienste/Characteristics per Web-Bluetooth-Namen', async () => {
    const { server } = await connected();
    expect(server.connected).toBe(true);
    expect(m.BleClient.connect).toHaveBeenCalledWith('dev-1', expect.any(Function), { timeout: 25_000 });
    const svc = await server.getPrimaryService(SERVICE);
    expect(svc.uuid).toBe(SERVICE);
    const hr = await server.getPrimaryService(HEART_RATE_SERVICE);
    const ch = await hr.getCharacteristic(HEART_RATE_MEASUREMENT);
    expect(ch.uuid).toBe(HR_CHR);
    expect(await hr.getCharacteristic(HEART_RATE_MEASUREMENT)).toBe(ch);
    // Dienste werden pro Verbindung nur einmal abgefragt
    expect(m.BleClient.getServices).toHaveBeenCalledTimes(1);
  });

  it('wirft NotFoundError für fehlende Dienste und Characteristics', async () => {
    const { server } = await connected();
    await expect(server.getPrimaryService('battery_service')).rejects.toMatchObject({ name: 'NotFoundError' });
    const svc = await server.getPrimaryService(SERVICE);
    await expect(svc.getCharacteristic('61080099-8d6d-82b8-614a-1c8cb0f8dcc6')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('liefert Notifications als characteristicvaluechanged mit derselben DataView (ohne Kopie)', async () => {
    const { server } = await connected();
    const ch = await (await server.getPrimaryService(SERVICE)).getCharacteristic(DATA_FROM_STRAP);
    const seen: (DataView | undefined)[] = [];
    ch.addEventListener('characteristicvaluechanged', (ev) => seen.push((ev.target as unknown as BluetoothRemoteGATTCharacteristic).value));
    await ch.startNotifications();
    const [id, s, c, cb, opts] = m.BleClient.startNotifications.mock.calls[0];
    expect([id, s, c, opts]).toEqual(['dev-1', SERVICE, DATA_FROM_STRAP, { timeout: 35_000 }]);
    const dv = new DataView(new Uint8Array([0xaa, 1, 2]).buffer);
    cb(dv);
    expect(seen).toEqual([dv]);
    expect(seen[0]).toBe(dv);
    expect(ch.value).toBe(dv);
    await ch.stopNotifications();
    expect(m.BleClient.stopNotifications).toHaveBeenCalledWith('dev-1', SERVICE, DATA_FROM_STRAP);
  });

  it('schreibt mit und ohne Antwort und respektiert byteOffset von Views', async () => {
    const { server } = await connected();
    const ch = await (await server.getPrimaryService(SERVICE)).getCharacteristic(CMD_TO_STRAP);
    const big = new Uint8Array([9, 9, 1, 2, 3, 9]);
    await ch.writeValueWithResponse!(big.subarray(2, 5));
    const dv: DataView = m.BleClient.write.mock.calls[0][3];
    expect([...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)]).toEqual([1, 2, 3]);
    expect(m.BleClient.write.mock.calls[0].slice(0, 3)).toEqual(['dev-1', SERVICE, CMD_TO_STRAP]);
    expect(m.BleClient.write.mock.calls[0][4]).toEqual({ timeout: 35_000 });

    await ch.writeValue(new Uint8Array([7]).buffer);
    expect(m.BleClient.write).toHaveBeenCalledTimes(2);
    await ch.writeValueWithoutResponse!(new Uint8Array([8]));
    expect(m.BleClient.writeWithoutResponse).toHaveBeenCalledTimes(1);

    const v = await ch.readValue();
    expect(v.getUint8(0)).toBe(42);
  });

  it('meldet einen Verbindungsverlust des Plugins einmal als gattserverdisconnected', async () => {
    const { dev, server } = await connected();
    const onDisc = vi.fn();
    dev.addEventListener('gattserverdisconnected', onDisc);
    const pluginOnDisconnect = m.BleClient.connect.mock.calls[0][1] as (id: string) => void;
    pluginOnDisconnect('dev-1');
    pluginOnDisconnect('dev-1');
    expect(onDisc).toHaveBeenCalledTimes(1);
    expect(server.connected).toBe(false);
    await expect(server.getPrimaryService(SERVICE)).rejects.toMatchObject({ name: 'NetworkError' });

    // Neue Verbindung: ein verspäteter Callback der alten Verbindung darf sie nicht trennen.
    await server.connect();
    pluginOnDisconnect('dev-1');
    expect(server.connected).toBe(true);
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it('disconnect() trennt am Plugin vorbei an der Warteschlange und feuert das Ereignis', async () => {
    const { dev, server } = await connected();
    const onDisc = vi.fn();
    dev.addEventListener('gattserverdisconnected', onDisc);
    server.disconnect();
    expect(m.BluetoothLe.disconnect).toHaveBeenCalledWith({ deviceId: 'dev-1' });
    expect(server.connected).toBe(false);
    expect(onDisc).toHaveBeenCalledTimes(1);
    server.disconnect();
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it('bricht einen laufenden Verbindungsaufbau bei disconnect() ab', async () => {
    let finish!: () => void;
    m.BleClient.connect.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const bt = new CapacitorBluetooth({ storage: memStorage() });
    const dev = await bt.requestDevice({});
    const p = dev.gatt!.connect();
    await vi.waitFor(() => expect(m.BleClient.connect).toHaveBeenCalled());
    dev.gatt!.disconnect();
    finish();
    await expect(p).rejects.toThrow(/abgebrochen/);
    expect(dev.gatt!.connected).toBe(false);
    expect(m.BluetoothLe.disconnect).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Ende-zu-Ende: unveränderter WhoopDevice → Adapter → gemocktes Plugin → simuliertes Band.

/** Belegt die BleClient-Mocks so, dass sie das simulierte Band (fake-strap) wie CoreBluetooth bedienen. */
function bridgeToFakeStrap(fake: FakeBluetooth) {
  const strap = fake.strap;
  const dev = strap.device;
  const svcChars = (uuid: string) => (strap.services.get(uuid) as unknown as { chars: Map<string, BluetoothRemoteGATTCharacteristic> }).chars;
  const char = (s: string, c: string) => svcChars(s).get(c)!;
  const notifyHandlers = new Map<string, () => void>();
  let onDisc: (() => void) | null = null;

  m.BleClient.requestDevice.mockImplementation(async (o: { namePrefix?: string; services?: string[] }) => {
    const d = await fake.requestDevice({ filters: [{ namePrefix: o.namePrefix, services: o.services }] });
    return { deviceId: d.id, name: d.name };
  });
  m.BleClient.getDevices.mockImplementation(async (ids: string[]) => (ids.includes(dev.id) ? [{ deviceId: dev.id, name: dev.name }] : []));
  m.BleClient.connect.mockImplementation(async (_id: string, cb: () => void) => {
    if (onDisc) dev.removeEventListener('gattserverdisconnected', onDisc);
    onDisc = cb;
    dev.addEventListener('gattserverdisconnected', cb);
    await dev.gatt.connect();
  });
  m.BluetoothLe.disconnect.mockImplementation(async () => dev.gatt.disconnect());
  m.BleClient.getServices.mockImplementation(async () =>
    [...strap.services.keys()].map((uuid) => ({
      uuid,
      characteristics: [...svcChars(uuid).keys()].map((c) => ({ uuid: c, properties: {}, descriptors: [] })),
    })),
  );
  m.BleClient.startNotifications.mockImplementation(async (_id: string, s: string, c: string, cb: (v: DataView) => void) => {
    const ch = char(s, c);
    const key = `${s}|${c}`;
    if (notifyHandlers.has(key)) ch.removeEventListener('characteristicvaluechanged', notifyHandlers.get(key)!);
    // Wie das echte Plugin: jede Notification kommt als eigene DataView an.
    const h = () => cb(new DataView(ch.value!.buffer.slice(ch.value!.byteOffset, ch.value!.byteOffset + ch.value!.byteLength)));
    notifyHandlers.set(key, h);
    ch.addEventListener('characteristicvaluechanged', h);
    await ch.startNotifications();
  });
  m.BleClient.write.mockImplementation(async (_id: string, s: string, c: string, v: DataView) => {
    await char(s, c).writeValueWithResponse!(v);
  });
}

describe('WhoopDevice über den Capacitor-Adapter', () => {
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

  it('verbindet, synchronisiert den Verlauf und verbindet nach Neustart ohne Dialog', async () => {
    const fake = createFakeBluetooth({ latencyMs: 1, start: 1_750_000_000, historySeconds: 1500, batchSize: 600, realtimeIntervalMs: 20 });
    bridgeToFakeStrap(fake);
    const storage = memStorage();
    const stored: SampleRecord[] = [];
    const sink = async (r: SampleRecord[]) => void stored.push(...r);

    const dev = new WhoopDevice({ bluetooth: new CapacitorBluetooth({ storage }), sink, timings: FAST });
    devices.push(dev);
    await dev.connect();
    expect(dev.state).toBe('connected');
    expect(m.BleClient.requestDevice).toHaveBeenCalledWith(expect.objectContaining({ namePrefix: 'WHOOP' }));
    const n = await dev.syncHistory();
    expect(n).toBe(1500);
    expect(stored).toHaveLength(1500);
    expect(fake.strap.forbidden).toEqual([]);
    await dev.disconnect();
    expect(dev.state).toBe('disconnected');

    // "App-Neustart": neuer Adapter + neues WhoopDevice, gleiches localStorage → kein Auswahldialog.
    m.BleClient.requestDevice.mockClear();
    const dev2 = new WhoopDevice({ bluetooth: new CapacitorBluetooth({ storage }), sink, timings: FAST });
    devices.push(dev2);
    expect(await dev2.reconnect()).toBe(true);
    expect(dev2.state).toBe('connected');
    expect(m.BleClient.requestDevice).not.toHaveBeenCalled();
  });

  it('erkennt einen Verbindungsabbruch vom Band', async () => {
    const fake = createFakeBluetooth({ latencyMs: 1, start: 1_750_000_000, historySeconds: 60, realtimeIntervalMs: 20 });
    bridgeToFakeStrap(fake);
    const dev = new WhoopDevice({ bluetooth: new CapacitorBluetooth({ storage: memStorage() }), sink: async () => {}, timings: FAST });
    devices.push(dev);
    await dev.connect();
    fake.strap.dropLink();
    await vi.waitFor(() => expect(dev.state).toBe('disconnected'));
  });
});
