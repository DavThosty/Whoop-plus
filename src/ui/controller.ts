// Zentrale App-Logik: verbindet Band (BLE), lokalen Speicher und Auswertung.
import { WhoopDevice } from '../ble/whoop';
import { getKv, getProfile, pruneSamples, putSamples, sampleBounds, setKv, setProfile } from '../store/db';
import { recomputeRange } from '../store/pipeline';
import type { ConnectionState, DeviceInfo, LiveHr, Profile, SampleRecord, SyncProgress } from '../types';

export interface AppState {
  supported: boolean;
  demo: boolean;
  conn: ConnectionState;
  info: DeviceInfo | null;
  battery: { percent: number; charging?: boolean } | null;
  live: LiveHr | null;
  liveOn: boolean;
  /** Puls der letzten 10 Minuten für das Live-Diagramm. */
  liveSeries: { ts: number; hr: number }[];
  sync: SyncProgress | null;
  lastSync: number | null;
  computing: boolean;
  /** Wird nach jeder Neuberechnung erhöht, damit Ansichten neu laden. */
  dataVersion: number;
  profile: Profile | null;
  alarm: number | null;
  retentionDays: number;
  log: string[];
  error: string | null;
  stats: { oldest: number | null; newest: number | null; count: number } | null;
}

type Listener = (s: AppState) => void;

const LIVE_WINDOW_S = 600;
const LIVE_FLUSH_MS = 30_000;
const LIVE_RECOMPUTE_MS = 5 * 60_000;

export class AppController {
  state: AppState = {
    supported: WhoopDevice.isSupported(),
    demo: false,
    conn: 'disconnected',
    info: null,
    battery: null,
    live: null,
    liveOn: false,
    liveSeries: [],
    sync: null,
    lastSync: null,
    computing: false,
    dataVersion: 0,
    profile: null,
    alarm: null,
    retentionDays: 0,
    log: [],
    error: null,
    stats: null,
  };

  private listeners = new Set<Listener>();
  private device: WhoopDevice | null = null;
  private touched: { from: number; to: number } | null = null;
  private liveBuffer: SampleRecord[] = [];
  private liveFlushTimer: ReturnType<typeof setInterval> | null = null;
  private lastLiveRecompute = 0;
  private wakeLock: { release(): Promise<void> } | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private log(line: string) {
    const ts = new Date().toLocaleTimeString('de-DE');
    this.set({ log: [...this.state.log.slice(-199), `${ts}  ${line}`] });
  }

  async init(): Promise<void> {
    const [profile, lastSync, alarm, retention, stats] = await Promise.all([
      getProfile(),
      getKv<number>('lastSync'),
      getKv<number>('alarm'),
      getKv<number>('retentionDays'),
      sampleBounds(),
    ]);
    this.set({
      profile: profile ?? null,
      lastSync: lastSync ?? null,
      alarm: alarm && alarm * 1000 > Date.now() ? alarm : null,
      retentionDays: retention ?? 0,
      stats,
    });
    if (new URLSearchParams(location.search).has('demo')) await this.startDemo();
    else if (this.state.supported) void this.tryReconnect();
  }

  private createDevice(bluetooth?: unknown): WhoopDevice {
    this.device?.disconnect().catch(() => {});
    const dev = new WhoopDevice({
      sink: (records) => this.storeHistory(records),
      ...(bluetooth ? { bluetooth: bluetooth as never } : {}),
    });
    dev.on('state', (conn) => {
      this.set({ conn });
      if (conn === 'disconnected') {
        this.set({ liveOn: false, live: null });
        void this.flushLive();
        void this.releaseWakeLock();
      }
    });
    dev.on('info', (info) => this.set({ info }));
    dev.on('battery', (battery) => this.set({ battery }));
    dev.on('live', (live) => this.onLive(live));
    dev.on('sync', (sync) => {
      this.set({ sync });
      if (sync.done) void this.onSyncDone();
    });
    dev.on('log', (line) => this.log(line));
    dev.on('error', (err) => {
      this.log(`Fehler: ${err.message}`);
      this.set({ error: err.message });
    });
    this.device = dev;
    return dev;
  }

  /** Muss aus einem Tipp des Nutzers heraus aufgerufen werden (Web-Bluetooth-Vorgabe). */
  async connect(): Promise<void> {
    this.set({ error: null });
    const dev = this.device && !this.state.demo ? this.device : this.createDevice();
    try {
      await dev.connect();
      await this.requestWakeLock();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Abbruch im Geräte-Dialog ist kein Fehler.
      if (!/cancel|abgebrochen|NotFoundError/i.test(msg)) this.set({ error: msg });
      this.log(`Verbindung fehlgeschlagen: ${msg}`);
    }
  }

  private async tryReconnect(): Promise<void> {
    const dev = this.createDevice();
    try {
      if (await dev.reconnect()) await this.requestWakeLock();
    } catch (e) {
      this.log(`Automatisches Verbinden nicht möglich: ${e instanceof Error ? e.message : e}`);
    }
  }

  async disconnect(): Promise<void> {
    await this.device?.disconnect();
  }

  async syncNow(): Promise<void> {
    if (!this.device || this.state.conn !== 'connected') return;
    try {
      await this.device.syncHistory();
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  async setLive(on: boolean): Promise<void> {
    if (!this.device) return;
    await this.device.setRealtimeHr(on);
    this.set({ liveOn: on, liveSeries: on ? this.state.liveSeries : [] });
    if (on && !this.liveFlushTimer) {
      this.liveFlushTimer = setInterval(() => void this.flushLive(), LIVE_FLUSH_MS);
    } else if (!on) {
      if (this.liveFlushTimer) clearInterval(this.liveFlushTimer);
      this.liveFlushTimer = null;
      await this.flushLive();
    }
  }

  async buzz(): Promise<void> {
    await this.device?.buzz();
  }

  async setAlarm(at: Date | null): Promise<void> {
    if (!this.device) return;
    await this.device.setAlarm(at);
    const v = at ? Math.floor(at.getTime() / 1000) : null;
    await setKv('alarm', v);
    this.set({ alarm: v });
  }

  async saveProfile(p: Profile): Promise<void> {
    await setProfile(p);
    this.set({ profile: p });
    await this.recomputeAll();
  }

  async setRetention(days: number): Promise<void> {
    await setKv('retentionDays', days);
    this.set({ retentionDays: days });
    await this.applyRetention();
  }

  async recomputeAll(): Promise<void> {
    const stats = await sampleBounds();
    this.set({ stats });
    if (stats.oldest != null && stats.newest != null) await this.recompute(stats.oldest, stats.newest);
  }

  async startDemo(): Promise<void> {
    const { createFakeBluetooth } = await import('../sim/fake-strap');
    const fake = createFakeBluetooth({ days: 10 });
    this.set({ demo: true, supported: true });
    if (!this.state.profile) {
      await setProfile({ age: 35, weightKg: 78, sex: 'm', maxHr: 185, sleepNeedH: 8 });
      this.set({ profile: (await getProfile()) ?? null });
    }
    const dev = this.createDevice(fake);
    await dev.connect();
  }

  // --- intern ---

  private async storeHistory(records: SampleRecord[]): Promise<void> {
    await putSamples(records);
    for (const r of records) {
      if (!this.touched) this.touched = { from: r.ts, to: r.ts };
      else {
        if (r.ts < this.touched.from) this.touched.from = r.ts;
        if (r.ts > this.touched.to) this.touched.to = r.ts;
      }
    }
  }

  private async onSyncDone(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await setKv('lastSync', now);
    this.set({ lastSync: now });
    const t = this.touched;
    this.touched = null;
    if (t) await this.recompute(t.from, t.to);
    await this.applyRetention();
    this.set({ stats: await sampleBounds() });
  }

  private async recompute(from: number, to: number): Promise<void> {
    const profile = this.state.profile;
    if (!profile) return;
    this.set({ computing: true });
    try {
      const days = await recomputeRange(from, to, profile);
      if (days.length) this.log(`Auswertung aktualisiert: ${days.length} Tag(e)`);
    } catch (e) {
      this.log(`Auswertung fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.set({ computing: false, dataVersion: this.state.dataVersion + 1 });
    }
  }

  private onLive(live: LiveHr) {
    const series = this.state.liveSeries.filter((p) => p.ts > live.ts - LIVE_WINDOW_S);
    if (live.hr > 0) series.push({ ts: live.ts, hr: live.hr });
    this.set({ live, liveSeries: series });
    if (live.hr > 0 && live.wearing) {
      this.liveBuffer.push({ ts: live.ts, hr: live.hr, rr: live.rr, src: 'live' });
    }
    if (Date.now() - this.lastLiveRecompute > LIVE_RECOMPUTE_MS && this.liveBuffer.length > 0) {
      this.lastLiveRecompute = Date.now();
      void this.flushLive(true);
    }
  }

  private async flushLive(recompute = false): Promise<void> {
    if (this.liveBuffer.length === 0) return;
    const batch = this.liveBuffer;
    this.liveBuffer = [];
    await putSamples(batch);
    if (recompute) await this.recompute(batch[0].ts, batch[batch.length - 1].ts);
  }

  private async applyRetention(): Promise<void> {
    const days = this.state.retentionDays;
    if (days > 0) await pruneSamples(Math.floor(Date.now() / 1000) - days * 86400);
  }

  /** Hält den Bildschirm wach, solange das Band verbunden ist (falls der Browser es kann). */
  private async requestWakeLock(): Promise<void> {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && !this.wakeLock) this.wakeLock = await wl.request('screen');
    } catch {
      // nicht unterstützt – egal
    }
  }

  private async releaseWakeLock(): Promise<void> {
    await this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}

export const app = new AppController();
