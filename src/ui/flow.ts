// Ablaufsteuerung der Vollbild-Erlebnisse: Sync-Zeremonie, Morgen-Story, Detailansichten, Workout-Start, „Was ist neu“.
import { getDay, getKv, setKv } from '../store/db';
import { app } from './controller';
import { today } from './format';
import { APP_CHANGELOG, APP_VERSION } from '../version';
import { ceremonyDue, storyDue, whatsNewAction } from './rules';
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
  /** „Was ist neu“ nach einem Update (kleines Sheet). */
  whatsNew: { version: string; text: string } | null;
}

type Listener = (s: FlowState) => void;

/** Nach einem fehlgeschlagenen Sync in dieser Sitzung so lange keine erneute Zeremonie. */
const CEREMONY_RETRY_MS = 30 * 60_000;
/** kv-Schlüssel: zuletzt gesehene Version für „Was ist neu“. */
export const WHATS_NEW_KEY = 'whatsNewSeenVersion';

class Flow {
  state: FlowState = { ceremony: false, ceremonyAt: 0, exiting: false, story: null, detail: null, connectPrompt: false, whatsNew: null };
  private listeners = new Set<Listener>();
  private started = false;
  private suppressCeremonyUntil = 0;
  /** Laufende Story-Prüfung (andere Aufrufer warten darauf, statt parallel etwas zu öffnen). */
  private storyCheck: Promise<void> | null = null;
  private checkingWhatsNew = false;
  /** „Was ist neu“ ist für diese Sitzung erledigt (gesehen, gemerkt oder nicht nötig). */
  private whatsNewDone = false;
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

  /**
   * Andere Vollbilder oder Sheets offen? Dann nichts automatisch darüberlegen.
   * `ignoreWhatsNew`: Die Zeremonie hat Vorrang vor „Was ist neu“ (das Sheet weicht und kommt später wieder).
   */
  private busy(ignoreWhatsNew = false): boolean {
    return !!(
      this.state.ceremony || this.state.story || this.state.detail || this.state.connectPrompt ||
      (!ignoreWhatsNew && this.state.whatsNew) || workout.state.phase !== 'idle' || workout.state.recovery
    );
  }

  /** Im Hintergrund ist Ruhe (kein Verbindungsaufbau, Sync oder Berechnung). */
  private calm(): boolean {
    const s = app.state;
    return !(s.conn === 'connecting' || s.conn === 'syncing' || s.postSync || s.computing);
  }

  private async maybeCeremony(syncStartedAt: number) {
    if (this.busy(true) || Date.now() < this.suppressCeremonyUntil) return;
    const date = today();
    const lastSync = app.state.lastSync;
    let last: string | undefined;
    try {
      last = await getKv<string>('ceremonyDate');
    } catch {
      return;
    }
    if (!ceremonyDue({ now: new Date(), today: date, lastCeremonyDate: last, lastSyncSec: lastSync })) return;
    if (app.state.conn !== 'syncing' || this.busy(true)) return;
    this.ceremonyDate = date;
    // Ein offenes „Was ist neu“ weicht (ungesehen) und erscheint, wenn wieder Ruhe ist.
    this.set({ ceremony: true, ceremonyAt: syncStartedAt, exiting: false, whatsNew: null });
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
  maybeAutoStory(afterCeremony = false): Promise<void> {
    if (this.storyCheck) return this.storyCheck;
    const s = app.state;
    if (this.busy()) return Promise.resolve();
    if (!afterCeremony && (s.conn === 'connecting' || s.conn === 'syncing' || s.postSync || s.computing)) return Promise.resolve();
    const check = this.checkStory().finally(() => {
      if (this.storyCheck === check) this.storyCheck = null;
    });
    this.storyCheck = check;
    return check;
  }

  private async checkStory(): Promise<void> {
    try {
      const date = today();
      const shown = await getKv<string>('storyShownDate');
      if (shown === date) return;
      const day = await getDay(date);
      if (!storyDue({ now: new Date(), today: date, storyShownDate: shown, sleepEndSec: day?.sleep?.end ?? null })) return;
      // Prüfen und Öffnen ohne `await` dazwischen – sonst könnte sich ein anderes Vollbild/Sheet dazwischenschieben.
      if (this.busy()) return;
      this.set({ story: { date }, exiting: false });
      await setKv('storyShownDate', date);
    } catch {
      // Speicher nicht verfügbar – keine Story (bzw. nicht gemerkt)
    }
  }

  /**
   * „Was ist neu in <Version>“ einmal nach einem Update – erst wenn Ruhe ist und kein anderes Vollbild/Sheet offen ist
   * (Zeremonie, Story, Workout, Detail, Verbindungs- oder Workout-Hinweis haben Vorrang). Nicht bei der Erstinstallation.
   */
  async maybeWhatsNew(): Promise<void> {
    // Die Morgen-Story hat Vorrang: eine laufende Story-Prüfung erst abwarten.
    if (this.storyCheck) await this.storyCheck;
    if (this.whatsNewDone || this.checkingWhatsNew || this.state.whatsNew) return;
    if (!app.state.stats || this.busy() || !this.calm()) return;
    this.checkingWhatsNew = true;
    try {
      const lastSeen = await getKv<string>(WHATS_NEW_KEY);
      const s = app.state;
      const hasData = !!(s.profile || s.lastSync || (s.stats?.count ?? 0) > 0);
      const action = whatsNewAction({ version: APP_VERSION, lastSeen, hasData, changelog: APP_CHANGELOG });
      if (action === 'none') {
        this.whatsNewDone = true;
        return;
      }
      if (action === 'mark') {
        await setKv(WHATS_NEW_KEY, APP_VERSION);
        this.whatsNewDone = true;
        return;
      }
      if (this.busy() || !this.calm()) return;
      this.set({ whatsNew: { version: APP_VERSION, text: APP_CHANGELOG } });
    } catch {
      // Speicher nicht verfügbar – kein Hinweis
    } finally {
      this.checkingWhatsNew = false;
    }
  }

  /** „Was ist neu“ geschlossen: für diese Version merken. */
  async closeWhatsNew(): Promise<void> {
    const shown = this.state.whatsNew;
    this.set({ whatsNew: null });
    if (!shown) return;
    this.whatsNewDone = true;
    await setKv(WHATS_NEW_KEY, shown.version).catch(() => {});
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
