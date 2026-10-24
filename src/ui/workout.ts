// Workout-Sitzung: Live-Puls sammeln, Strain/kcal laufend berechnen, Band bei Zonenwechsel vibrieren lassen.
// Der Zwischenstand wird regelmäßig gespeichert, damit ein von iOS beendetes Workout nicht verloren geht.
import { resolveRhr } from '../analytics';
import {
  activeSeconds, rebuildWorkout, WorkoutAccumulator, workoutZone, ZoneBuzzer,
  type WorkoutCheckpoint, type WorkoutRecord, type WorkoutStats,
} from '../analytics/workout';
import { getDays, getKv, getSamples, putWorkout, setKv } from '../store/db';
import type { LiveHr } from '../types';
import { app } from './controller';
import { addDays, today } from './format';

export type WorkoutPhase = 'idle' | 'starting' | 'active' | 'paused' | 'stopping' | 'summary';

export interface WorkoutState {
  phase: WorkoutPhase;
  startTs: number | null;
  /** Aktive Sekunden ohne Pausen. */
  elapsedS: number;
  hr: number | null;
  zone: 0 | 1 | 2 | 3 | 4 | 5;
  stats: WorkoutStats | null;
  points: { ts: number; hr: number }[];
  rhr: number;
  maxHr: number;
  /** Verbindung während des Workouts verloren. */
  linkLost: boolean;
  summary: WorkoutRecord | null;
  error: string | null;
  /** Beim Start gefundenes, unterbrochenes Workout. */
  recovery: WorkoutCheckpoint | null;
  /** Wird nach jedem gespeicherten/gelöschten Workout erhöht. */
  version: number;
}

type Listener = (s: WorkoutState) => void;

export const CHECKPOINT_KEY = 'workoutCheckpoint';
export const CHECKPOINT_EVERY_MS = 30_000;
/** Wartezeit nach einem fehlgeschlagenen Einschalten des Live-Pulses (1., ab 2. Fehlschlag). */
export const LIVE_RETRY_MS = [10_000, 30_000] as const;

const HAPTIC_ZONE: [number, number] = [2, 1];
const HAPTIC_START: [number, number] = [2, 2];
const HAPTIC_STOP: [number, number] = [2, 3];

const nowSec = () => Date.now() / 1000;
const isLinked = (c: string) => c === 'connected' || c === 'syncing';

export class WorkoutSession {
  state: WorkoutState = {
    phase: 'idle', startTs: null, elapsedS: 0, hr: null, zone: 0, stats: null, points: [],
    rhr: 60, maxHr: 190, linkLost: false, summary: null, error: null, recovery: null, version: 0,
  };
  private listeners = new Set<Listener>();
  private acc: WorkoutAccumulator | null = null;
  private buzzer = new ZoneBuzzer();
  private offLive: (() => void) | null = null;
  private offApp: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Start (Unix-Sekunden, mit Nachkommastellen). */
  private start0 = 0;
  private pauses: [number, number][] = [];
  private pausedAt: number | null = null;
  private prevLive = false;
  private lastHrAt = 0;
  private lastCheckpoint = 0;
  // Live-Puls-Wächter
  private liveBusy = false;
  private liveRetryAt = 0;
  private liveFailures = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<WorkoutState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  get running(): boolean {
    const p = this.state.phase;
    return p === 'starting' || p === 'active' || p === 'paused' || p === 'stopping';
  }

  bumpVersion() {
    this.set({ version: this.state.version + 1 });
  }

  /** Startet ein Workout. Das Band muss verbunden sein. */
  async start(): Promise<boolean> {
    if (this.running || this.state.phase === 'summary') return this.running;
    if (!isLinked(app.state.conn)) {
      this.set({ error: 'Bitte zuerst das Band verbinden.' });
      return false;
    }
    this.set({ phase: 'starting', error: null, summary: null, linkLost: false, hr: null, zone: 0, stats: null, points: [], elapsedS: 0 });
    // Ruhepuls der letzten Nacht, Maximalpuls aus dem Profil.
    let rhr = 60;
    try {
      const days = await getDays(addDays(today(), -14), today());
      const last = [...days].reverse().find((d) => d.sleep?.restingHr);
      rhr = resolveRhr(last?.sleep?.restingHr);
    } catch {
      // Standardwert
    }
    const maxHr = app.state.profile?.maxHr ?? 190;
    this.acc = new WorkoutAccumulator({ rhr, maxHr, profile: app.state.profile });
    this.prevLive = app.state.liveOn;
    this.start0 = nowSec();
    this.pauses = [];
    this.pausedAt = null;
    this.set({ startTs: Math.floor(this.start0), rhr, maxHr });
    await this.begin(true);
    return true;
  }

  /** Gemeinsamer Teil von Start und Fortsetzen: Live-Puls, Abos, Takt, Checkpoint. */
  private async begin(fresh: boolean) {
    this.buzzer = new ZoneBuzzer();
    this.liveFailures = 0;
    this.liveRetryAt = 0;
    this.lastHrAt = 0;
    await this.ensureLive();
    void app.keepAwake(true);
    this.set({ phase: 'active' });
    if (fresh) void app.haptic(...HAPTIC_START);
    this.buzzer.noteBuzz(Date.now());
    this.offLive = app.subscribeLive((l) => this.onLive(l));
    let wasLinked = isLinked(app.state.conn);
    this.offApp = app.subscribe((s) => {
      const linked = isLinked(s.conn);
      if (this.state.linkLost === linked) this.set({ linkLost: !linked });
      // Nur beim Übergang zu „verbunden“ den Live-Puls wieder einschalten (mit Sperre und Backoff).
      if (linked && !wasLinked) {
        this.liveFailures = 0;
        this.liveRetryAt = 0;
        void this.ensureLive();
      }
      wasLinked = linked;
    });
    this.timer = setInterval(() => this.tick(), 1000);
    await this.checkpoint();
  }

  /** Schaltet den Live-Puls ein – höchstens ein Versuch gleichzeitig, nach Fehlschlägen mit Wartezeit. */
  private async ensureLive(): Promise<void> {
    if (this.liveBusy || app.state.liveOn || !isLinked(app.state.conn) || Date.now() < this.liveRetryAt) return;
    this.liveBusy = true;
    try {
      await app.setLive(true);
    } finally {
      this.liveBusy = false;
    }
    if (app.state.liveOn) {
      this.liveFailures = 0;
    } else {
      this.liveRetryAt = Date.now() + LIVE_RETRY_MS[Math.min(this.liveFailures, LIVE_RETRY_MS.length - 1)];
      this.liveFailures++;
    }
  }

  private onLive(l: LiveHr) {
    if (this.state.phase !== 'active' || !this.acc) return;
    if (!(l.hr > 0) || !l.wearing) return;
    // Zeitstempel der Telefonuhr: Workout-Dauer und Pausen beziehen sich auf sie.
    this.acc.add(Math.floor(nowSec()), l.hr);
    this.lastHrAt = Date.now();
    this.set({ hr: l.hr, zone: workoutZone(l.hr, this.state.rhr, this.state.maxHr) });
  }

  private elapsed(at = nowSec()): number {
    return activeSeconds(this.start0, this.pausedAt ?? at, this.pauses);
  }

  private tick() {
    if (!this.acc) return;
    const now = Date.now();
    const active = this.state.phase === 'active';
    // Ohne frische Messung (> 6 s) keinen Puls anzeigen.
    const stale = this.lastHrAt > 0 && now - this.lastHrAt > 6000;
    const patch: Partial<WorkoutState> = {
      elapsedS: Math.floor(this.elapsed()),
      stats: this.acc.stats(active && !stale ? Math.floor(now / 1000) : undefined),
      points: this.acc.points(),
    };
    if (stale && this.state.hr != null) {
      patch.hr = null;
      patch.zone = 0;
    }
    this.set(patch);
    if (active && this.state.hr != null) {
      const z = this.buzzer.update(this.state.zone, now);
      if (z != null) void app.haptic(...HAPTIC_ZONE);
    }
    if (!app.state.liveOn) void this.ensureLive();
    if (now - this.lastCheckpoint >= CHECKPOINT_EVERY_MS) void this.checkpoint();
  }

  private async checkpoint(): Promise<void> {
    if (!this.running || this.state.phase === 'stopping') return;
    this.lastCheckpoint = Date.now();
    const cp: WorkoutCheckpoint = {
      v: 1,
      startTs: this.start0,
      pauses: this.pauses.map(([a, b]) => [a, b] as [number, number]),
      pausedAt: this.pausedAt,
      savedAt: nowSec(),
      rhr: this.state.rhr,
      maxHr: this.state.maxHr,
      prevLive: this.prevLive,
    };
    try {
      await setKv(CHECKPOINT_KEY, cp);
    } catch {
      // Speichern nicht möglich – Workout läuft trotzdem weiter
    }
  }

  pause() {
    if (this.state.phase !== 'active' || !this.acc) return;
    const t = nowSec();
    this.acc.finish(Math.floor(t));
    this.pausedAt = t;
    this.set({ phase: 'paused', elapsedS: Math.floor(this.elapsed()) });
    void this.checkpoint();
  }

  resume() {
    if (this.state.phase !== 'paused' || !this.acc || this.pausedAt == null) return;
    this.pauses.push([this.pausedAt, nowSec()]);
    this.pausedAt = null;
    this.acc.resetGap();
    this.set({ phase: 'active' });
    void this.checkpoint();
  }

  /** Beendet das Workout, speichert es und zeigt die Zusammenfassung. Mehrfachaufrufe sind wirkungslos. */
  async stop(): Promise<void> {
    if ((this.state.phase !== 'active' && this.state.phase !== 'paused') || !this.acc) return;
    const end = this.pausedAt ?? nowSec();
    this.set({ phase: 'stopping' }); // sofort – blockiert weitere stop()/pause()-Aufrufe
    const acc = this.acc;
    acc.finish(Math.floor(end));
    this.cleanup();
    const stats = acc.stats();
    const durationS = Math.round(this.elapsed(end));
    const startTs = Math.floor(this.start0);
    const record: WorkoutRecord = {
      id: startTs, start: startTs, end: Math.floor(end), durationS,
      strain: stats.strain, trimp: stats.trimp, kcal: stats.kcal, avgHr: stats.avgHr, maxHr: stats.maxHr,
      zoneSeconds: stats.zoneSeconds, hr: acc.points(), rhr: this.state.rhr, maxHrRef: this.state.maxHr,
    };
    void app.haptic(...HAPTIC_STOP);
    if (!this.prevLive && app.state.liveOn) await app.setLive(false);
    void app.keepAwake(false);
    await this.finishRecord(record, stats);
  }

  private async finishRecord(record: WorkoutRecord, stats: WorkoutStats) {
    let error: string | null = null;
    try {
      if (record.durationS >= 5) await putWorkout(record);
      await setKv(CHECKPOINT_KEY, null);
    } catch (e) {
      error = `Workout konnte nicht gespeichert werden: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.acc = null;
    this.set({ phase: 'summary', summary: record, stats, error, recovery: null, version: this.state.version + 1 });
  }

  // --- Unterbrochenes Workout ---

  /** Beim App-Start: gibt es einen gespeicherten Zwischenstand? */
  async checkRecovery(): Promise<void> {
    if (this.state.phase !== 'idle') return;
    try {
      const cp = await getKv<WorkoutCheckpoint | null>(CHECKPOINT_KEY);
      if (cp && cp.v === 1 && Number.isFinite(cp.startTs) && Number.isFinite(cp.savedAt)) this.set({ recovery: cp });
    } catch {
      // kein Speicher
    }
  }

  private async rebuild(cp: WorkoutCheckpoint, end: number) {
    const profile = app.state.profile;
    const samples = await getSamples(Math.floor(cp.startTs), Math.ceil(end) + 1);
    return rebuildWorkout(samples, cp.startTs, end, cp.pauses, { rhr: cp.rhr, maxHr: cp.maxHr, profile });
  }

  /** Unterbrochenes Workout mit den gespeicherten Live-Daten abschließen. */
  async finishRecovered(): Promise<void> {
    const cp = this.state.recovery;
    if (!cp || this.state.phase !== 'idle') return;
    this.set({ phase: 'stopping' });
    const end = cp.pausedAt ?? cp.savedAt;
    try {
      const r = await this.rebuild(cp, end);
      const startTs = Math.floor(cp.startTs);
      const record: WorkoutRecord = {
        id: startTs, start: startTs, end: Math.floor(end), durationS: r.durationS,
        strain: r.stats.strain, trimp: r.stats.trimp, kcal: r.stats.kcal, avgHr: r.stats.avgHr, maxHr: r.stats.maxHr,
        zoneSeconds: r.stats.zoneSeconds, hr: r.points, rhr: cp.rhr, maxHrRef: cp.maxHr,
      };
      await this.finishRecord(record, r.stats);
    } catch (e) {
      this.set({ phase: 'idle', error: `Workout konnte nicht wiederhergestellt werden: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** Unterbrochenes Workout fortsetzen; die Zeit seit dem letzten Speichern zählt als Pause. */
  async resumeRecovered(): Promise<boolean> {
    const cp = this.state.recovery;
    if (!cp || this.state.phase !== 'idle') return false;
    if (!isLinked(app.state.conn)) {
      this.set({ error: 'Bitte zuerst das Band verbinden.' });
      return false;
    }
    this.set({ phase: 'starting', error: null, summary: null, linkLost: false, hr: null, zone: 0 });
    const gapFrom = cp.pausedAt ?? cp.savedAt;
    const now = nowSec();
    try {
      const r = await this.rebuild(cp, gapFrom);
      this.acc = r.acc;
      this.start0 = cp.startTs;
      this.pauses = [...cp.pauses.map(([a, b]) => [a, b] as [number, number]), [gapFrom, now]];
      this.pausedAt = null;
      this.prevLive = cp.prevLive;
      this.set({
        startTs: Math.floor(cp.startTs), rhr: cp.rhr, maxHr: cp.maxHr, recovery: null,
        stats: r.stats, points: r.points, elapsedS: Math.floor(this.elapsed(now)),
      });
      await this.begin(false);
      return true;
    } catch (e) {
      this.acc = null;
      this.set({ phase: 'idle', error: `Workout konnte nicht fortgesetzt werden: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
  }

  /** Entscheidung vertagen: Der Zwischenstand bleibt gespeichert und wird beim nächsten Start wieder angeboten. */
  deferRecovery() {
    this.set({ recovery: null });
  }

  async discardRecovered(): Promise<void> {
    await setKv(CHECKPOINT_KEY, null).catch(() => {});
    this.set({ recovery: null });
  }

  dismiss() {
    if (this.state.phase !== 'summary') return;
    this.set({ phase: 'idle', summary: null, error: null });
  }

  clearError() {
    this.set({ error: null });
  }

  private cleanup() {
    this.offLive?.();
    this.offLive = null;
    this.offApp?.();
    this.offApp = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const workout = new WorkoutSession();
