// Automatische tägliche Sicherung (nur native App): schreibt die normale JSON-Sicherung nach
// Documents/Sicherungen. Dank UIFileSharingEnabled sieht man sie in der Dateien-App unter
// „Auf meinem iPhone → Whoop Plus → Sicherungen“. Es bleiben die neuesten 7 Dateien.
// Läuft nie während Verbindungsaufbau, Sync, Auswertung oder Workout; Fehler nur im Protokoll + leise Statuszeile.

import { localDateString } from '../analytics/time';
import type { AppState } from '../ui/controller';
import type { WorkoutPhase } from '../ui/workout';

export const BACKUP_DIR = 'Sicherungen';
export const BACKUP_KEEP = 7;
/** Mindestabstand zwischen zwei automatischen Sicherungen. */
export const BACKUP_MIN_INTERVAL_MS = 20 * 3600_000;
const NAME_RE = /^WhoopPlus-Sicherung-(\d{4}-\d{2}-\d{2})\.json$/;

export function backupFileName(atMs: number): string {
  return `WhoopPlus-Sicherung-${localDateString(atMs / 1000)}.json`;
}

/** Datum aus einem Sicherungsnamen ('YYYY-MM-DD') oder null, wenn die Datei keine automatische Sicherung ist. */
export function backupDate(name: string): string | null {
  return NAME_RE.exec(name)?.[1] ?? null;
}

/** Automatische Sicherungen, neueste zuerst (andere Dateien im Ordner bleiben unberührt). */
export function sortBackups(names: string[]): string[] {
  return names.filter((n) => backupDate(n) != null).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Welche Dateien gelöscht werden, damit nur die neuesten `keep` bleiben. */
export function backupsToDelete(names: string[], keep = BACKUP_KEEP): string[] {
  return sortBackups(names).slice(keep);
}

export function isBackupDue(lastAt: number | null, nowMs: number): boolean {
  return lastAt == null || nowMs - lastAt > BACKUP_MIN_INTERVAL_MS || lastAt > nowMs + 3600_000; // Uhr zurückgestellt
}

type IdleView = Pick<AppState, 'conn' | 'postSync' | 'computing' | 'demo' | 'stats'>;

/** Ruhiger Moment für eine Sicherung? (Kein Aufbau/Sync/Auswertung/Workout, Daten geladen und vorhanden.) */
export function isIdleForBackup(s: IdleView, workoutPhase: WorkoutPhase): boolean {
  if (s.demo) return false;
  if (s.conn === 'connecting' || s.conn === 'syncing' || s.postSync || s.computing) return false;
  if (workoutPhase !== 'idle' && workoutPhase !== 'summary') return false;
  return !!s.stats && s.stats.count > 0;
}

export interface BackupFile {
  name: string;
  /** Datum aus dem Dateinamen ('YYYY-MM-DD'). */
  date: string;
}

export interface BackupState {
  /** Zeitpunkt der letzten erfolgreichen automatischen Sicherung (ms). */
  lastAt: number | null;
  lastFile: string | null;
  running: boolean;
  /** Leise Statuszeile bei einem Fehler (kein Banner). */
  error: string | null;
  files: BackupFile[];
}

export interface BackupDeps {
  now(): number;
  getMeta(): Promise<{ at: number; file: string } | undefined>;
  setMeta(m: { at: number; file: string }): Promise<void>;
  exportBlob(): Promise<Blob>;
  /** Schreibt in `Sicherungen/<name>` (überschreibt). */
  write(name: string, blob: Blob): Promise<void>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
  read(name: string): Promise<string>;
  log(line: string): void;
}

type Listener = (s: BackupState) => void;

export class AutoBackup {
  state: BackupState = { lastAt: null, lastFile: null, running: false, error: null, files: [] };
  private listeners = new Set<Listener>();
  private loaded: Promise<void> | null = null;
  private ready = false;
  private running: Promise<boolean> | null = null;

  constructor(private readonly deps: BackupDeps) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<BackupState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Liest Metadaten und Dateiliste (einmal; Fehler werden geschluckt). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const m = await this.deps.getMeta();
        if (m) this.set({ lastAt: m.at, lastFile: m.file });
      } catch {
        /* egal */
      }
      await this.refreshFiles();
      this.ready = true;
    })();
    return this.loaded;
  }

  async refreshFiles(): Promise<void> {
    try {
      const names = sortBackups(await this.deps.list());
      this.set({ files: names.map((name) => ({ name, date: backupDate(name)! })) });
    } catch {
      // Ordner existiert noch nicht
      this.set({ files: [] });
    }
  }

  /** Prüft, ob jetzt gesichert werden soll, und startet die Sicherung im Hintergrund. Liefert, ob gestartet wurde. */
  maybeRun(app: IdleView, workoutPhase: WorkoutPhase): boolean {
    if (!this.ready || this.running) return false;
    if (!isBackupDue(this.state.lastAt, this.deps.now())) return false;
    if (!isIdleForBackup(app, workoutPhase)) return false;
    void this.run();
    return true;
  }

  /** Sichert sofort (nicht während einer laufenden Sicherung). */
  run(): Promise<boolean> {
    this.running ??= this.doRun().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRun(): Promise<boolean> {
    this.set({ running: true });
    await this.load();
    const at = this.deps.now();
    const name = backupFileName(at);
    try {
      const blob = await this.deps.exportBlob();
      await this.deps.write(name, blob);
      await this.deps.setMeta({ at, file: name });
      this.set({ lastAt: at, lastFile: name, error: null });
      this.deps.log(`Automatische Sicherung gespeichert: ${BACKUP_DIR}/${name} (${(blob.size / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB)`);
      try {
        for (const old of backupsToDelete(await this.deps.list())) await this.deps.remove(old);
      } catch (e) {
        this.deps.log(`Alte Sicherungen aufräumen: ${msg(e)}`);
      }
      return true;
    } catch (e) {
      this.deps.log(`Automatische Sicherung fehlgeschlagen: ${msg(e)}`);
      this.set({ error: 'Automatische Sicherung fehlgeschlagen – wird beim nächsten Öffnen erneut versucht.' });
      return false;
    } finally {
      await this.refreshFiles();
      this.set({ running: false });
    }
  }

  /** Inhalt einer automatischen Sicherung als Datei (für „Einspielen“). */
  async readFile(name: string): Promise<File> {
    const text = await this.deps.read(name);
    return new File([text], name, { type: 'application/json' });
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
