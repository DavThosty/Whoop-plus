// Ablaufsteuerung der Vollbild-Erlebnisse: Sync-Zeremonie, Morgen-Story, Detailansichten, Workout-Start.
import { getDay, getKv, setKv } from '../store/db';
import { app } from './controller';
import { today } from './format';
import { workout } from './workout';

export type DetailKind = 'recovery' | 'strain' | 'sleep' | 'hrv' | 'rhr';

export interface FlowState {
  ceremony: boolean;
  story: { date: string } | null;
  detail: { kind: DetailKind; date: string; rect: DOMRect | null } | null;
  connectPrompt: boolean;
}

type Listener = (s: FlowState) => void;

/** Bis zu dieser Uhrzeit (lokal) erscheint die Story automatisch. */
export const STORY_UNTIL_HOUR = 14;
/** Nach einem fehlgeschlagenen Sync in dieser Sitzung so lange keine erneute Zeremonie. */
const CEREMONY_RETRY_MS = 30 * 60_000;

class Flow {
  state: FlowState = { ceremony: false, story: null, detail: null, connectPrompt: false };
  private listeners = new Set<Listener>();
  private started = false;
  private suppressCeremonyUntil = 0;
  private checkingStory = false;

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
      if (s.conn === 'syncing' && prev !== 'syncing') void this.maybeCeremony();
      prev = s.conn;
    });
  }

  private async maybeCeremony() {
    if (this.state.ceremony || workout.running || Date.now() < this.suppressCeremonyUntil) return;
    let last: string | undefined;
    try {
      last = await getKv<string>('ceremonyDate');
    } catch {
      return;
    }
    if (last === today() || app.state.conn !== 'syncing' || workout.running) return;
    this.set({ ceremony: true, story: null, detail: null, connectPrompt: false });
  }

  /** Zeremonie beendet (auch übersprungen). Bei Erfolg für heute merken und ggf. die Story zeigen. */
  async endCeremony(ok: boolean, skipped = false) {
    this.set({ ceremony: false });
    if (ok) {
      await setKv('ceremonyDate', today()).catch(() => {});
      if (!skipped) await this.maybeAutoStory(true);
    } else if (!skipped) {
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
    if (this.state.ceremony || this.state.story || workout.running) return;
    if (!afterCeremony && (s.conn === 'connecting' || s.conn === 'syncing' || s.postSync || s.computing)) return;
    if (new Date().getHours() >= STORY_UNTIL_HOUR) return;
    this.checkingStory = true;
    try {
      const date = today();
      const shown = await getKv<string>('storyShownDate');
      if (shown === date) return;
      const day = await getDay(date);
      if (!day?.sleep) return;
      if (this.state.ceremony || this.state.story || workout.running) return;
      await setKv('storyShownDate', date);
      this.set({ story: { date }, detail: null });
    } catch {
      // Speicher nicht verfügbar – keine Story
    } finally {
      this.checkingStory = false;
    }
  }

  openStory(date = today()) {
    this.set({ story: { date } });
  }

  closeStory() {
    this.set({ story: null });
  }

  openDetail(kind: DetailKind, date: string, rect: DOMRect | null = null) {
    this.set({ detail: { kind, date, rect } });
  }

  closeDetail() {
    this.set({ detail: null });
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
