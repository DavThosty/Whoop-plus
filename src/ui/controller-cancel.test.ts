import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ bt: undefined as unknown }));
vi.mock('../ble/platform', () => ({ platformBluetooth: () => h.bt, isNativeApp: () => false }));
vi.mock('../store/share-file', () => ({ shareFileNative: vi.fn() }));
vi.mock('../store/pipeline', () => ({ recomputeRange: vi.fn(async () => []) }));
vi.mock('../store/db', () => ({
  exportBackup: vi.fn(), getKv: vi.fn(async () => undefined), getProfile: vi.fn(async () => undefined), importBackup: vi.fn(),
  onDbNotice: vi.fn(), pruneSamples: vi.fn(async () => {}), putSamples: vi.fn(async () => {}), requestPersistence: vi.fn(async () => true),
  sampleBounds: vi.fn(async () => ({ oldest: null, newest: null, count: 0 })), setKv: vi.fn(async () => {}), setProfile: vi.fn(async () => {}),
  storageEstimate: vi.fn(async () => null),
}));
import { createFakeBluetooth } from '../sim/fake-strap';
import { AppController } from './controller';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
describe('Controller: Abbrechen und verwaiste Verbindungen', () => {
  it('Abbrechen while manual connect waits for auto attempt', async () => {
    const bt = createFakeBluetooth({ latencyMs: 1, historySeconds: 60, realtimeIntervalMs: 50 });
    await bt.requestDevice({ filters: [{ namePrefix: 'WHOOP' }] });
    const origGet = (bt as any).getDevices;
    (bt as any).getDevices = async () => { await sleep(200); return origGet(); };
    let picker = 0;
    const origReq = bt.requestDevice.bind(bt);
    (bt as any).requestDevice = (o: any) => { picker++; return origReq(o); };
    h.bt = bt;
    const c = new AppController();
    const auto = (c as any).tryReconnect();
    await sleep(50);
    expect(c.state.conn).toBe('disconnected'); // UI shows "Band verbinden"
    const manual = c.connect();
    while (c.state.conn !== 'connecting') await sleep(5);
    await c.disconnect(); // user taps "Abbrechen"
    await Promise.all([auto, manual]);
    await sleep(300);
    expect(picker).toBe(0);
    expect(c.state.conn).toBe('disconnected');
    await c.disconnect();
  });

  it('demo/createDevice during getDevices phase leaves orphan device connecting', async () => {
    const bt = createFakeBluetooth({ latencyMs: 1, historySeconds: 60 });
    await bt.requestDevice({ filters: [{ namePrefix: 'WHOOP' }] });
    const origGet = (bt as any).getDevices;
    (bt as any).getDevices = async () => { await sleep(100); return origGet(); };
    h.bt = bt;
    const c = new AppController();
    const auto = (c as any).tryReconnect();
    await sleep(20);
    const first = (c as any).device;
    (c as any).createDevice(createFakeBluetooth({ latencyMs: 1, historySeconds: 60 }));
    await auto;
    await sleep(300);
    expect(first.state).toBe('disconnected');
    expect(bt.strap.device.gatt.connected).toBe(false);
    await (c as any).device?.disconnect();
  });
});
