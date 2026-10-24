// Zentrale App-Logik: verbindet Band (BLE), lokalen Speicher und Auswertung.
import { dayBounds, localDateString, sleepWindow } from '../analytics';
import { isNativeApp, platformBluetooth } from '../ble/platform';
import { WhoopDevice } from '../ble/whoop';
import {
  exportBackup, getKv, getProfile, importBackup, onDbNotice, pruneSamples, putSamples, requestPersistence,
  sampleBounds, setKv, setProfile, storageEstimate,
} from '../store/db';
import { recomputeRange } from '../store/pipeline';
import { shareFileNative } from '../store/share-file';
import type { ConnectionState, DeviceInfo, LiveHr, Profile, SampleRecord, SyncProgress } from '../types';
import { addDays, today } from './format';

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
  /** Zeitpunkt (ms), zu dem zuletzt ein Sync-Ende gemeldet wurde. */
  syncDoneAt: number | null;
  lastSync: number | null;
  computing: boolean;
  /** Nach dem Sync: Daten werden gespeichert und ausgewertet (vom Sync-Ende bis alles fertig ist). */
  postSync: boolean;
  /** Wird nach jeder Neuberechnung erhöht, damit Ansichten neu laden. */
  dataVersion: number;
  profile: Profile | null;
  alarm: number | null;
  retentionDays: number;
  log: string[];
  error: string | null;
  /** Der letzte automatische Verbindungsversuch hat das Band nicht erreicht (dezenter Status statt Fehlermeldung). */
  outOfRange: boolean;
  stats: { oldest: number | null; newest: number | null; count: number } | null;
  storage: { usage: number; quota: number; persisted: boolean | null } | null;
}

type Listener = (s: AppState) => void;
type LiveListener = (live: LiveHr) => void;

const LIVE_WINDOW_S = 600;
const LIVE_FLUSH_MS = 30_000;
const LIVE_RECOMPUTE_MS = 5 * 60_000;
/** 1. 1. 2020 – ältere Zeitstempel stammen von einer nicht gestellten Banduhr. */
const MIN_VALID_TS = 1_577_836_800;
const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000];

export class AppController {
  state: AppState = {
    supported: WhoopDevice.isSupported(platformBluetooth()),
    demo: false,
    conn: 'disconnected',
    info: null,
    battery: null,
    live: null,
    liveOn: false,
    liveSeries: [],
    sync: null,
    syncDoneAt: null,
    lastSync: null,
    computing: false,
    postSync: false,
    dataVersion: 0,
    profile: null,
    alarm: null,
    retentionDays: 0,
    log: [],
    error: null,
    outOfRange: false,
    stats: null,
    storage: null,
  };

  private listeners = new Set<Listener>();
  private liveListeners = new Set<LiveListener>();
  private workoutAwake = false;
  private device: WhoopDevice | null = null;
  private deviceOff: (() => void)[] = [];
  private touched: { from: number; to: number } | null = null;
  private liveBuffer: SampleRecord[] = [];
  private liveFlushTimer: ReturnType<typeof setInterval> | null = null;
  private lastLiveRecompute = 0;
  private wakeLock: { release(): Promise<void> } | null = null;
  /** Neuberechnungen laufen nacheinander; wartende Bereiche werden zusammengelegt. */
  private pendingRange: { from: number; to: number } | null = null;
  private recomputeLoop: Promise<void> | null = null;
  private userDisconnected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Laufender Verbindungsaufbau (Tipp oder automatisch) – nie zwei WhoopDevices gleichzeitig auf einem Band. */
  private inflight: { p: Promise<void>; auto: boolean } | null = null;
  /** Live-Puls für die aktuelle Verbindung vom Nutzer ausgeschaltet (sonst automatisch an). */
  private liveOptOut = false;
  /** Automatisches Einschalten nur einmal pro Verbindung („connected“ kommt auch nach jedem Sync wieder). */
  private autoLiveTried = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Jede gültige Live-Messung (für den Workout-Modus, unabhängig vom 10-Minuten-Fenster). */
  subscribeLive(fn: LiveListener): () => void {
    this.liveListeners.add(fn);
    return () => this.liveListeners.delete(fn);
  }

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private log(line: string) {
    const ts = new Date().toLocaleTimeString('de-DE');
    this.set({ log: [...this.state.log.slice(-199), `${ts}  ${line}`] });
  }

  private fail(context: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    this.log(`${context}: ${msg}`);
    this.set({ error: `${context}: ${msg}` });
  }

  clearError() {
    this.set({ error: null });
  }

  async init(): Promise<void> {
    onDbNotice((n) => {
      if (n === 'blocked') this.set({ error: 'Speicher-Update wartet: Bitte andere geöffnete Tabs von Whoop Plus schließen.' });
      else if (n === 'blocking') this.set({ error: 'Whoop Plus wurde in einem anderen Tab aktualisiert. Bitte diese Seite neu laden.' });
      else this.log('Datenbankverbindung wurde vom Browser beendet – wird neu geöffnet.');
    });
    try {
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
      void this.refreshStorage();
    } catch (e) {
      this.fail('Lokaler Speicher nicht verfügbar', e);
      return;
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (this.state.conn !== 'disconnected' || this.workoutAwake)) void this.requestWakeLock();
    });
    if (new URLSearchParams(location.search).has('demo')) await this.startDemo();
    else if (this.state.supported) void this.tryReconnect();
  }

  /** `auto`: Fehler beim Aufbau nur protokollieren (automatische Versuche sollen nicht stören). */
  private createDevice(bluetooth?: unknown, auto = false): WhoopDevice {
    // Alte Verbindung samt Listenern sauber abräumen.
    for (const off of this.deviceOff) off();
    this.deviceOff = [];
    this.device?.disconnect().catch(() => {});

    const bt = bluetooth ?? platformBluetooth();
    const dev = new WhoopDevice({
      sink: (records) => this.storeHistory(records),
      ...(bt ? { bluetooth: bt as never } : {}),
    });
    let quiet = auto;
    this.deviceOff = [
      dev.on('state', (conn) => {
        if (conn === 'connected') quiet = false;
        this.onState(conn);
      }),
      dev.on('info', (info) => this.set({ info })),
      dev.on('battery', (battery) => this.set({ battery })),
      dev.on('live', (live) => this.onLive(live)),
      dev.on('sync', (sync) => {
        this.set(sync.done ? { sync, syncDoneAt: Date.now() } : { sync });
        if (sync.done) void this.onSyncDone(sync);
      }),
      dev.on('log', (line) => this.log(line)),
      dev.on('error', (err) => {
        if (!quiet) return this.fail('Band', err);
        this.log(`Automatisches Verbinden: ${err.message}`);
        this.set({ outOfRange: true });
      }),
    ];
    this.device = dev;
    return dev;
  }

  private onState(conn: ConnectionState) {
    this.set({ conn });
    if (conn === 'connected') {
      this.reconnectAttempt = 0;
      if (this.state.outOfRange) this.set({ outOfRange: false });
      if (!this.autoLiveTried) {
        this.autoLiveTried = true;
        void this.autoLive();
      }
    }
    if (conn === 'disconnected') {
      this.liveOptOut = false;
      this.autoLiveTried = false;
      this.stopLiveTimer();
      this.set({ liveOn: false, live: null });
      void this.flushLive();
      if (!this.workoutAwake) void this.releaseWakeLock();
      if (!this.userDisconnected && !this.state.demo) this.scheduleReconnect();
    }
  }

  /** Muss aus einem Tipp des Nutzers heraus aufgerufen werden (Web-Bluetooth-Vorgabe). */
  async connect(): Promise<void> {
    // Doppelter Tipp: denselben Aufbau abwarten.
    if (this.inflight && !this.inflight.auto) return this.inflight.p;
    this.set({ error: null, outOfRange: false });
    this.userDisconnected = false;
    this.cancelReconnect();
    if (this.state.demo) {
      await this.startDemo();
      return;
    }
    const prior = this.inflight;
    const run = async () => {
      if (prior) {
        // Ein automatischer Versuch läuft schon: abwarten statt ein zweites Gerät auf dasselbe Band zu setzen.
        await prior.p;
        this.cancelReconnect();
        if (this.state.conn !== 'disconnected') return;
      }
      // Ohne vorherigen Versuch läuft alles bis requestDevice synchron (Web-Bluetooth-Nutzergeste).
      const dev = this.createDevice();
      try {
        await dev.connect();
        await this.requestWakeLock();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Abbruch im Geräte-Dialog ist kein Fehler.
        if (/cancel|abgebrochen|NotFoundError|chosen/i.test(msg)) this.log(`Verbindung abgebrochen: ${msg}`);
        else this.fail('Verbindung fehlgeschlagen', e);
      }
    };
    await this.track(run(), false);
  }

  /**
   * Verbindet ohne Auswahldialog mit dem gemerkten Band (z. B. bei Rückkehr in die App) – nicht nach „Trennen“
   * und nicht in der Demo. Ein geplanter Wiederholungsversuch wird vorgezogen, ohne den Zyklus neu zu starten.
   */
  async reconnectRemembered(): Promise<void> {
    if (this.state.demo || this.userDisconnected || !this.state.supported) return;
    if (this.inflight) return this.inflight.p;
    if (this.state.conn !== 'disconnected') return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.tryReconnect();
  }

  /** Automatischer Versuch ohne Dialog. Fehler landen nur im Protokoll (+ Status „nicht in Reichweite“). */
  private tryReconnect(): Promise<void> {
    if (this.inflight) return this.inflight.p;
    // Ein Gerät mitten im Aufbau oder verbunden wird nie ersetzt.
    if (this.state.conn !== 'disconnected') return Promise.resolve();
    const run = async () => {
      const dev = this.createDevice(undefined, true);
      try {
        if (await dev.reconnect()) await this.requestWakeLock();
      } catch (e) {
        this.log(`Automatisches Verbinden nicht möglich: ${e instanceof Error ? e.message : e}`);
      }
    };
    return this.track(run(), true);
  }

  private track(p: Promise<void>, auto: boolean): Promise<void> {
    const entry = { p, auto };
    this.inflight = entry;
    const clear = () => {
      if (this.inflight === entry) this.inflight = null;
    };
    p.then(clear, clear);
    return p;
  }

  /** Live-Puls nach jedem Verbinden automatisch einschalten (einmal pro Verbindung, keine Schleife bei Fehlern). */
  private async autoLive(): Promise<void> {
    if (!this.device || this.liveOptOut || this.state.liveOn) return;
    await this.applyLive(true, true);
  }

  /** Soll der Live-Puls außerhalb eines Workouts an sein? (Automatisch an, außer der Nutzer hat ihn ausgeschaltet.) */
  get liveWanted(): boolean {
    return !this.liveOptOut;
  }

  /** Nach einem unerwarteten Verbindungsabbruch ein paar Mal neu verbinden (nur ohne Auswahldialog möglich). */
  private scheduleReconnect() {
    if (this.reconnectTimer || this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) return;
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt++];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state.conn === 'disconnected' && !this.userDisconnected) void this.tryReconnect();
    }, delay);
  }

  private cancelReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  /** Trennen – bricht auch einen hängenden Verbindungsaufbau ab. */
  async disconnect(): Promise<void> {
    this.userDisconnected = true;
    this.cancelReconnect();
    try {
      await this.device?.disconnect();
    } catch (e) {
      this.fail('Trennen', e);
    }
  }

  async syncNow(): Promise<void> {
    if (!this.device || this.state.conn !== 'connected') return;
    try {
      await this.device.syncHistory();
    } catch (e) {
      this.fail('Sync', e);
    }
  }

  /**
   * Live-Puls an/aus. Die Wahl des Nutzers („aus“) gilt bis zum Trennen; beim nächsten Verbinden ist er wieder
   * automatisch an. `remember: false` (z. B. Workout) schaltet nur, ohne die Wahl des Nutzers zu ändern.
   */
  async setLive(on: boolean, remember = true): Promise<void> {
    if (remember) this.liveOptOut = !on;
    await this.applyLive(on, false);
  }

  private async applyLive(on: boolean, quiet: boolean): Promise<void> {
    if (!this.device) return;
    try {
      await this.device.setRealtimeHr(on);
    } catch (e) {
      if (quiet) this.log(`Live-Puls automatisch einschalten: ${e instanceof Error ? e.message : String(e)}`);
      else this.fail('Live-Puls', e);
      return;
    }
    this.set({ liveOn: on, liveSeries: on ? this.state.liveSeries : [] });
    if (on && !this.liveFlushTimer) {
      this.liveFlushTimer = setInterval(() => void this.flushLive(), LIVE_FLUSH_MS);
    } else if (!on) {
      this.stopLiveTimer();
      await this.flushLive();
    }
  }

  async buzz(): Promise<void> {
    try {
      await this.device?.buzz();
    } catch (e) {
      this.fail('Vibrieren', e);
    }
  }

  /** Kurzer Vibrationsimpuls am Band (nur RUN_HAPTICS_PATTERN). Fehler werden nur protokolliert. */
  async haptic(pattern?: number, loops?: number): Promise<void> {
    const dev = this.device;
    if (!dev || (this.state.conn !== 'connected' && this.state.conn !== 'syncing')) return;
    try {
      await dev.haptic(pattern, loops);
    } catch (e) {
      this.log(`Haptik: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Bildschirm während eines Workouts wach halten (zusätzlich zur Verbindung). */
  async keepAwake(on: boolean): Promise<void> {
    this.workoutAwake = on;
    if (on) await this.requestWakeLock();
    else if (this.state.conn === 'disconnected') await this.releaseWakeLock();
  }

  async setAlarm(at: Date | null): Promise<void> {
    if (!this.device) return;
    try {
      await this.device.setAlarm(at);
    } catch (e) {
      this.fail('Wecker', e);
      return;
    }
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
    this.set({ stats: await sampleBounds() });
  }

  async recomputeAll(): Promise<void> {
    const stats = await sampleBounds();
    this.set({ stats });
    if (stats.oldest == null || stats.newest == null) return;
    // Den ältesten Tag nur rechnen, wenn sein Schlaffenster vollständig in den Daten liegt.
    let first = localDateString(stats.oldest);
    if (sleepWindow(first).start < stats.oldest) first = addDays(first, 1);
    await this.recompute(dayBounds(first).start, stats.newest);
  }

  async exportData(): Promise<void> {
    try {
      const blob = await exportBackup();
      const name = `whoop-plus-backup-${today()}.json`;
      if (isNativeApp()) return await shareFileNative(blob, name, 'Whoop Plus Sicherung');
      const file = new File([blob], name, { type: 'application/json' });
      const nav = navigator as Navigator & { canShare?(d: { files: File[] }): boolean };
      if (nav.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Whoop Plus Sicherung' });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      this.fail('Export', e);
    }
  }

  async importData(file: File): Promise<void> {
    try {
      const n = await importBackup(await file.text());
      this.log(`Sicherung eingespielt: ${n.toLocaleString('de-DE')} Datensätze`);
      await this.init();
      await this.recomputeAll();
    } catch (e) {
      this.fail('Import', e);
    }
  }

  async startDemo(): Promise<void> {
    try {
      const { createFakeBluetooth } = await import('../sim/fake-strap');
      const fake = createFakeBluetooth({ days: 10 });
      // Nur im Demo-Modus: simuliertes Band für Vorführungen/Tests erreichbar machen (z. B. Zielpuls setzen).
      (window as unknown as { __whoopDemoStrap?: unknown }).__whoopDemoStrap = fake.strap;
      this.set({ demo: true, supported: true, error: null });
      if (!this.state.profile) {
        const p: Profile = { age: 35, weightKg: 78, sex: 'm', maxHr: 185, sleepNeedH: 8 };
        await setProfile(p);
        this.set({ profile: p });
      }
      const dev = this.createDevice(fake);
      await dev.connect();
    } catch (e) {
      this.fail('Demo', e);
    }
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

  private async onSyncDone(sync: SyncProgress): Promise<void> {
    this.set({ postSync: true });
    try {
      if (sync.ok !== false) {
        const now = Math.floor(Date.now() / 1000);
        await setKv('lastSync', now);
        this.set({ lastSync: now });
      }
      // Auch nach einem abgebrochenen Sync die bereits gespeicherten Blöcke auswerten.
      const t = this.touched;
      this.touched = null;
      if (t) await this.recompute(t.from, t.to);
      await this.applyRetention();
      this.set({ stats: await sampleBounds() });
      if (this.state.storage?.persisted !== true) {
        const persisted = await requestPersistence();
        this.log(persisted ? 'Daten werden dauerhaft gespeichert.' : 'Hinweis: Dauerhafte Speicherung ist nicht garantiert – regelmäßig eine Sicherung exportieren.');
      }
      await this.refreshStorage();
    } catch (e) {
      this.fail('Nach dem Sync', e);
    } finally {
      this.set({ postSync: false });
    }
  }

  /** Reiht eine Neuberechnung ein. Läuft bereits eine, wird der Bereich angehängt. */
  private recompute(from: number, to: number): Promise<void> {
    const r = this.pendingRange;
    this.pendingRange = r ? { from: Math.min(r.from, from), to: Math.max(r.to, to) } : { from, to };
    if (!this.recomputeLoop) {
      this.recomputeLoop = this.runRecomputeLoop().finally(() => {
        this.recomputeLoop = null;
      });
    }
    return this.recomputeLoop;
  }

  private async runRecomputeLoop(): Promise<void> {
    this.set({ computing: true });
    try {
      while (this.pendingRange) {
        const range = this.pendingRange;
        this.pendingRange = null;
        // Profil erst hier lesen, damit immer das aktuelle verwendet wird.
        const profile = this.state.profile;
        if (!profile) continue;
        try {
          const days = await recomputeRange(range.from, range.to, profile);
          if (days.length) this.log(`Auswertung aktualisiert: ${days.length} Tag(e)`);
        } catch (e) {
          this.fail('Auswertung', e);
        }
        this.set({ dataVersion: this.state.dataVersion + 1 });
      }
    } finally {
      this.set({ computing: false });
    }
  }

  private onLive(live: LiveHr) {
    if (live.ts < MIN_VALID_TS) return;
    const series = this.state.liveSeries.filter((p) => p.ts > live.ts - LIVE_WINDOW_S);
    if (live.hr > 0) series.push({ ts: live.ts, hr: live.hr });
    this.set({ live, liveSeries: series });
    for (const fn of this.liveListeners) {
      try {
        fn(live);
      } catch (e) {
        this.log(`Live-Listener: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (live.hr > 0 && live.wearing) {
      this.liveBuffer.push({ ts: live.ts, hr: live.hr, rr: live.rr, src: 'live' });
    }
    if (Date.now() - this.lastLiveRecompute > LIVE_RECOMPUTE_MS && this.liveBuffer.length > 0) {
      this.lastLiveRecompute = Date.now();
      void this.flushLive(true);
    }
  }

  private stopLiveTimer() {
    if (this.liveFlushTimer) clearInterval(this.liveFlushTimer);
    this.liveFlushTimer = null;
  }

  private async flushLive(recompute = false): Promise<void> {
    if (this.liveBuffer.length === 0) return;
    const batch = this.liveBuffer;
    this.liveBuffer = [];
    try {
      await putSamples(batch);
      // Live-Daten betreffen nur heute.
      if (recompute) await this.recompute(dayBounds(today()).start, batch[batch.length - 1].ts);
    } catch (e) {
      this.fail('Live-Daten speichern', e);
    }
  }

  /** Löscht Rohdaten an einer Tagesgrenze, inkl. Puffer für das Schlaffenster des ältesten behaltenen Tags. */
  private async applyRetention(): Promise<void> {
    const days = this.state.retentionDays;
    if (days <= 0) return;
    const keepFrom = sleepWindow(addDays(today(), -days)).start;
    await pruneSamples(keepFrom);
  }

  private async refreshStorage(): Promise<void> {
    const [est, persisted] = await Promise.all([
      storageEstimate(),
      navigator.storage?.persisted?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    if (est) this.set({ storage: { ...est, persisted } });
  }

  /** Hält den Bildschirm wach, solange das Band verbunden ist (falls der Browser es kann). */
  private async requestWakeLock(): Promise<void> {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && !this.wakeLock) {
        const lock = await wl.request('screen');
        this.wakeLock = lock;
        // iOS gibt den Wake Lock beim Wechsel in den Hintergrund frei.
        (lock as unknown as EventTarget).addEventListener?.('release', () => {
          if (this.wakeLock === lock) this.wakeLock = null;
        });
      }
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
