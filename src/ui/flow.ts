// Ablaufsteuerung der Vollbild-Erlebnisse: Sync-Zeremonie, Morgen-Story, Detailansichten, Workout-Start.
import { getDay, getKv, setKv } from '../store/db';
import { app } from './controller';
import { today } from './format';
import { ceremonyDue, storyDue } from './rules';
import { workout } from './workout';

export type DetailKind = 'recovery' | 'strain' | 'sleep' | 'hrv' | 'rhr';

export interface FlowState {
  ceremony: boolean;
  /** Zeitpunkt (ms), zu dem der Sync begann, der die Zeremonie ausgelöst hat. */
  ceremonyAt: number;
  /** Ein Vollbild wird gerade geschlossen (App darunter wieder anzeigen). */
  exiting: boolean;
  story: { date: string } | null;
  detail: { kind: DetailKind; date: string; rect: DOMRect | null } | null;
  connectPrompt: boolean;
}

type Listener = (s: FlowState) => void;

/** Nach einem fehlgeschlagenen Sync in dieser Sitzung so lange keine erneute Zeremonie. */
const CEREMONY_RETRY_MS = 30 * 60_000;

class Flow {
  state: FlowState = { ceremony: false, ceremonyAt: 0, exiting: false, story: null, detail: null, connectPrompt: false };
  private listeners = new Set<Listener>();
  private started = false;
  private suppressCeremonyUntil = 0;
  private checkingStory = false;
  /** Datum, für das die laufende Zeremonie gilt (beim Start festgehalten). */
  private ceremonyDate = '';

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<FlowState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Beobachtet den Verbindungszustand: Der erste Sync des Tages startet die Zeremonie. */
  start() {
    if (this.started) return;
    this.started = true;
    let prev = app.state.conn;
    app.subscribe((s) => {
      if (s.conn === 'syncing' && prev !== 'syncing') void this.maybeCeremony(Date.now());
      prev = s.conn;
    });
  }

  /** Andere Vollbilder offen? Dann nichts automatisch darüberlegen. */
  private busy(): boolean {
    return !!(this.state.ceremony || this.state.story || this.state.detail || this.state.connectPrompt || workout.state.phase !== 'idle' || workout.state.recovery);
  }

  private async maybeCeremony(syncStartedAt: number) {
    if (this.busy() || Date.now() < this.suppressCeremonyUntil) return;
    const date = today();
    const lastSync = app.state.lastSync;
    let last: string | undefined;
    try {
      last = await getKv<string>('ceremonyDate');
    } catch {
      return;
    }
    if (!ceremonyDue({ now: new Date(), today: date, lastCeremonyDate: last, lastSyncSec: lastSync })) return;
    if (app.state.conn !== 'syncing' || this.busy()) return;
    this.ceremonyDate = date;
    this.set({ ceremony: true, ceremonyAt: syncStartedAt, exiting: false });
  }

  /** Zeremonie beendet (auch übersprungen). Bei Erfolg für heute merken und ggf. die Story zeigen. */
  async endCeremony(ok: boolean, skipped = false) {
    this.set({ ceremony: false, exiting: false });
    // Auch beim Überspringen merken – sonst käme sie beim nächsten Auto-Sync wieder.
    if (ok || skipped) await setKv('ceremonyDate', this.ceremonyDate || today()).catch(() => {});
    if (ok && !skipped) await this.maybeAutoStory(true);
    else if (!ok && !skipped) {
      this.suppressCeremonyUntil = Date.now() + CEREMONY_RETRY_MS;
    }
  }

  /**
   * Zeigt die Morgen-Story einmal am Tag, wenn für heute ein Schlaf erkannt wurde und es vor 14 Uhr ist.
   * `afterCeremony`: direkt nach der Zeremonie (dann wird nicht auf Ruhe im Hintergrund gewartet).
   */
  async maybeAutoStory(afterCeremony = false): Promise<void> {
    if (this.checkingStory) return;
    const s = app.state;
    if (this.busy()) return;
    if (!afterCeremony && (s.conn === 'connecting' || s.conn === 'syncing' || s.postSync || s.computing)) return;
    this.checkingStory = true;
    try {
      const date = today();
      const shown = await getKv<string>('storyShownDate');
      if (shown === date) return;
      const day = await getDay(date);
      if (!storyDue({ now: new Date(), today: date, storyShownDate: shown, sleepEndSec: day?.sleep?.end ?? null })) return;
      if (this.busy()) return;
      await setKv('storyShownDate', date);
      this.set({ story: { date }, exiting: false });
    } catch {
      // Speicher nicht verfügbar – keine Story
    } finally {
      this.checkingStory = false;
    }
  }

  openStory(date = today()) {
    this.set({ story: { date }, exiting: false });
  }

  closeStory() {
    this.set({ story: null, exiting: false });
  }

  openDetail(kind: DetailKind, date: string, rect: DOMRect | null = null) {
    this.set({ detail: { kind, date, rect }, exiting: false });
  }

  closeDetail() {
    this.set({ detail: null, exiting: false });
  }

  /** Ein Vollbild beginnt seine Schließ-Animation: die App darunter wieder sichtbar machen. */
  beginExit() {
    if (!this.state.exiting) this.set({ exiting: true });
  }

  /** Workout starten – ohne Verbindung erst ein Hinweis zum Verbinden. */
  async startWorkout() {
    const conn = app.state.conn;
    if (conn === 'connected' || conn === 'syncing') {
      this.set({ connectPrompt: false, detail: null });
      await workout.start();
    } else {
      this.set({ connectPrompt: true });
    }
  }

  closeConnectPrompt() {
    this.set({ connectPrompt: false });
  }
}

export const flow = new Flow();
