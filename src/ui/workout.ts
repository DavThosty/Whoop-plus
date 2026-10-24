// Workout-Sitzung: Live-Puls sammeln, Strain/kcal laufend berechnen, Band bei Zonenwechsel vibrieren lassen.
import { resolveRhr } from '../analytics';
import { WorkoutAccumulator, workoutZone, ZoneBuzzer, type WorkoutRecord, type WorkoutStats } from '../analytics/workout';
import { getDays, putWorkout } from '../store/db';
import type { LiveHr } from '../types';
import { app } from './controller';
import { addDays, today } from './format';

export type WorkoutPhase = 'idle' | 'starting' | 'active' | 'paused' | 'summary';

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
  /** Wird nach jedem gespeicherten/gelöschten Workout erhöht. */
  version: number;
}

type Listener = (s: WorkoutState) => void;

const HAPTIC_ZONE: [number, number] = [2, 1];
const HAPTIC_START: [number, number] = [2, 2];
const HAPTIC_STOP: [number, number] = [2, 3];

class WorkoutSession {
  state: WorkoutState = {
    phase: 'idle', startTs: null, elapsedS: 0, hr: null, zone: 0, stats: null, points: [],
    rhr: 60, maxHr: 190, linkLost: false, summary: null, error: null, version: 0,
  };
  private listeners = new Set<Listener>();
  private acc: WorkoutAccumulator | null = null;
  private buzzer = new ZoneBuzzer();
  private offLive: (() => void) | null = null;
  private offApp: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeMs = 0;
  private resumedAt = 0;
  private prevLive = false;
  private lastHrAt = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<WorkoutState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  get running(): boolean {
    return this.state.phase === 'starting' || this.state.phase === 'active' || this.state.phase === 'paused';
  }

  bumpVersion() {
    this.set({ version: this.state.version + 1 });
  }

  /** Startet ein Workout. Das Band muss verbunden sein. */
  async start(): Promise<boolean> {
    if (this.running) return true;
    const conn = app.state.conn;
    if (conn !== 'connected' && conn !== 'syncing') {
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
    const profile = app.state.profile;
    const maxHr = profile?.maxHr ?? 190;
    this.acc = new WorkoutAccumulator({ rhr, maxHr, profile });
    this.buzzer = new ZoneBuzzer();
    this.prevLive = app.state.liveOn;
    if (!app.state.liveOn) await app.setLive(true);
    void app.keepAwake(true);
    const now = Date.now();
    this.activeMs = 0;
    this.resumedAt = now;
    this.lastHrAt = 0;
    this.set({ phase: 'active', startTs: Math.floor(now / 1000), rhr, maxHr });
    void app.haptic(...HAPTIC_START);
    this.buzzer.noteBuzz(now);
    this.offLive = app.subscribeLive((l) => this.onLive(l));
    this.offApp = app.subscribe((s) => {
      const lost = s.conn === 'disconnected' || s.conn === 'connecting';
      if (lost !== this.state.linkLost) this.set({ linkLost: lost });
      // Nach einem Wiederverbinden den Live-Puls erneut einschalten.
      if (!lost && !s.liveOn && this.running && (s.conn === 'connected' || s.conn === 'syncing')) void app.setLive(true);
    });
    this.timer = setInterval(() => this.tick(), 1000);
    return true;
  }

  private onLive(l: LiveHr) {
    if (this.state.phase !== 'active' || !this.acc) return;
    if (!(l.hr > 0) || !l.wearing) return;
    // Zeitstempel der Telefonuhr: Workout-Dauer und Pausen beziehen sich auf sie.
    const ts = Math.floor(Date.now() / 1000);
    this.acc.add(ts, l.hr);
    this.lastHrAt = Date.now();
    const zone = workoutZone(l.hr, this.state.rhr, this.state.maxHr);
    this.set({ hr: l.hr, zone });
  }

  private tick() {
    if (!this.acc) return;
    const now = Date.now();
    const active = this.state.phase === 'active';
    const elapsed = (this.activeMs + (active ? now - this.resumedAt : 0)) / 1000;
    // Ohne frische Messung (> 6 s) keinen Puls anzeigen.
    const stale = this.lastHrAt > 0 && now - this.lastHrAt > 6000;
    const patch: Partial<WorkoutState> = {
      elapsedS: Math.floor(elapsed),
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
  }

  pause() {
    if (this.state.phase !== 'active' || !this.acc) return;
    const now = Date.now();
    this.acc.finish(Math.floor(now / 1000));
    this.activeMs += now - this.resumedAt;
    this.set({ phase: 'paused', elapsedS: Math.floor(this.activeMs / 1000) });
  }

  resume() {
    if (this.state.phase !== 'paused' || !this.acc) return;
    this.acc.resetGap();
    this.resumedAt = Date.now();
    this.set({ phase: 'active' });
  }

  /** Beendet das Workout, speichert es und zeigt die Zusammenfassung. */
  async stop(): Promise<void> {
    if (!this.running || !this.acc) return;
    const now = Date.now();
    if (this.state.phase === 'active') {
      this.acc.finish(Math.floor(now / 1000));
      this.activeMs += now - this.resumedAt;
    }
    this.cleanup();
    const stats = this.acc.stats();
    const startTs = this.state.startTs ?? Math.floor(now / 1000);
    const record: WorkoutRecord = {
      id: startTs,
      start: startTs,
      end: Math.floor(now / 1000),
      durationS: Math.round(this.activeMs / 1000),
      strain: stats.strain,
      trimp: stats.trimp,
      kcal: stats.kcal,
      avgHr: stats.avgHr,
      maxHr: stats.maxHr,
      zoneSeconds: stats.zoneSeconds,
      hr: this.acc.points(),
      rhr: this.state.rhr,
      maxHrRef: this.state.maxHr,
    };
    void app.haptic(...HAPTIC_STOP);
    if (!this.prevLive && app.state.liveOn) await app.setLive(false);
    void app.keepAwake(false);
    let error: string | null = null;
    try {
      if (record.durationS >= 5) await putWorkout(record);
    } catch (e) {
      error = `Workout konnte nicht gespeichert werden: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.acc = null;
    this.set({ phase: 'summary', summary: record, stats, error, version: this.state.version + 1 });
  }

  /** Bricht ab, ohne zu speichern (z. B. wenn der Start fehlschlägt). */
  async cancel(): Promise<void> {
    this.cleanup();
    if (!this.prevLive && app.state.liveOn) await app.setLive(false);
    void app.keepAwake(false);
    this.acc = null;
    this.set({ phase: 'idle', summary: null });
  }

  dismiss() {
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
