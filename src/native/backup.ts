// Automatische tägliche Sicherung (nur native App): schreibt die normale JSON-Sicherung nach
// Documents/Sicherungen. Dank UIFileSharingEnabled sieht man sie in der Dateien-App unter
// „Auf meinem iPhone → Whoop Plus → Sicherungen“.
//
// Schutzmechanismen:
// - atomar: erst in <name>.tmp schreiben, dann umbenennen – eine gute Datei wird nie durch eine halbe ersetzt;
// - gestreamt: die Sicherung wird stückweise geschrieben (nie komplett im Speicher);
// - nur nach ≥ 60 s ununterbrochener Ruhe (kein Verbindungsaufbau/Sync/Auswertung/Workout), damit sie nicht
//   direkt vor dem automatischen Verbinden + Sync beim Öffnen startet;
// - Absturzschutz: vor dem Export wird ein „Versuch läuft“-Vermerk gespeichert; endete der letzte Versuch nie,
//   wird bis zum nächsten Tag ausgesetzt;
// - Rotation: die neuesten 7 bleiben, zusätzlich immer die größte; ist die neue Sicherung kleiner als die Hälfte
//   der bisher neuesten, wird gar nicht aufgeräumt.
// Fehler landen nur im Protokoll + einer leisen Statuszeile.

import { localDateString } from '../analytics/time';
import type { AppState } from '../ui/controller';
import type { WorkoutPhase } from '../ui/workout';

export const BACKUP_DIR = 'Sicherungen';
export const BACKUP_KEEP = 7;
/** Mindestabstand zwischen zwei automatischen Sicherungen. */
export const BACKUP_MIN_INTERVAL_MS = 20 * 3600_000;
/** So lange muss die App ununterbrochen ruhig sein, bevor eine Sicherung startet. */
export const BACKUP_IDLE_MS = 60_000;
/** Neue Sicherung kleiner als dieser Anteil der bisher neuesten → nicht aufräumen. */
export const BACKUP_SHRINK_RATIO = 0.5;
/** Nach einem Fehler frühestens so viel später erneut versuchen. */
export const BACKUP_RETRY_MS = 3600_000;
const NAME_RE = /^WhoopPlus-Sicherung-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/;
const TMP_SUFFIX = '.tmp';

export function backupFileName(atMs: number, n = 1): string {
  return `WhoopPlus-Sicherung-${localDateString(atMs / 1000)}${n > 1 ? `-${n}` : ''}.json`;
}

/** Datum aus einem Sicherungsnamen ('YYYY-MM-DD') oder null, wenn die Datei keine automatische Sicherung ist. */
export function backupDate(name: string): string | null {
  return NAME_RE.exec(name)?.[1] ?? null;
}

export interface FileEntry {
  name: string;
  size: number;
}

function sortKey(name: string): string {
  const m = NAME_RE.exec(name)!;
  return `${m[1]}#${(m[2] ?? '1').padStart(4, '0')}`;
}

/** Automatische Sicherungen, neueste zuerst (andere Dateien im Ordner bleiben unberührt). */
export function sortBackups<T extends { name: string }>(files: T[]): T[] {
  return files.filter((f) => backupDate(f.name) != null).sort((a, b) => (sortKey(a.name) < sortKey(b.name) ? 1 : -1));
}

/** Zu löschende Dateien: alle außer den neuesten `keep` und der größten. */
export function backupsToDelete(files: FileEntry[], keep = BACKUP_KEEP): string[] {
  const sorted = sortBackups(files);
  const largest = sorted.reduce<FileEntry | null>((m, f) => (!m || f.size > m.size ? f : m), null);
  return sorted.slice(keep).filter((f) => f !== largest).map((f) => f.name);
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

export interface BackupContext {
  app: IdleView;
  workoutPhase: WorkoutPhase;
}

export interface BackupMeta {
  /** Letzte erfolgreiche Sicherung (ms) und ihre Datei. */
  at?: number;
  file?: string;
  /** Beginn eines Versuchs, der (noch) nicht beendet wurde. */
  attemptAt?: number;
}

export interface BackupFile {
  name: string;
  /** Datum aus dem Dateinamen ('YYYY-MM-DD'). */
  date: string;
  size: number;
}

export interface BackupState {
  lastAt: number | null;
  lastFile: string | null;
  running: boolean;
  /** Leise Statuszeile (kein Banner). */
  error: string | null;
  files: BackupFile[];
}

export interface BackupDeps {
  now(): number;
  context(): BackupContext;
  getMeta(): Promise<BackupMeta | undefined>;
  setMeta(m: BackupMeta): Promise<void>;
  /** Die Sicherung als Folge von Textteilen (gestreamt). */
  exportParts(): AsyncIterable<string>;
  /** Schreibt die Teile nach `Sicherungen/<name>` (überschreibt); liefert die Größe in Bytes. */
  writeParts(name: string, parts: AsyncIterable<string>): Promise<number>;
  list(): Promise<FileEntry[]>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Datei als File zum Einspielen (ohne den Inhalt als einen String über die Bridge zu schicken). */
  open(name: string): Promise<File>;
  log(line: string): void;
}

type Listener = (s: BackupState) => void;

export class AutoBackup {
  state: BackupState = { lastAt: null, lastFile: null, running: false, error: null, files: [] };
  private listeners = new Set<Listener>();
  private loaded: Promise<void> | null = null;
  private ready = false;
  private running: Promise<boolean> | null = null;
  private meta: BackupMeta = {};
  private idleSince: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;

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
        this.meta = (await this.deps.getMeta()) ?? {};
        this.set({ lastAt: this.meta.at ?? null, lastFile: this.meta.file ?? null });
        if (this.meta.attemptAt != null) {
          this.deps.log('Hinweis: Die letzte automatische Sicherung wurde nicht beendet (App beendet oder abgestürzt) – nächster Versuch frühestens morgen.');
        }
      } catch {
        /* egal */
      }
      await this.refreshFiles(true);
      this.ready = true;
      this.poke();
    })();
    return this.loaded;
  }

  async refreshFiles(sweepTmp = false): Promise<void> {
    try {
      const all = await this.deps.list();
      if (sweepTmp && !this.running) {
        for (const f of all.filter((x) => x.name.endsWith(TMP_SUFFIX))) await this.deps.remove(f.name).catch(() => {});
      }
      this.set({ files: sortBackups(all).map((f) => ({ name: f.name, date: backupDate(f.name)!, size: f.size })) });
    } catch {
      this.set({ files: [] }); // Ordner existiert noch nicht
    }
  }

  /** Blockiert ein abgebrochener Versuch von heute die Sicherung? (Absturzschutz) */
  private blockedByAttempt(now: number): boolean {
    const a = this.meta.attemptAt;
    return a != null && localDateString(a / 1000) === localDateString(now / 1000);
  }

  private due(now: number): boolean {
    return isBackupDue(this.state.lastAt, now) && !this.blockedByAttempt(now) && now >= this.retryAt;
  }

  /**
   * Bei jeder Zustandsänderung aufrufen. Startet die Sicherung erst nach `BACKUP_IDLE_MS` ununterbrochener Ruhe;
   * jede Unruhe setzt die Wartezeit zurück.
   */
  poke(): void {
    if (!this.ready || this.running) return;
    const now = this.deps.now();
    const ctx = this.deps.context();
    if (!this.due(now) || !isIdleForBackup(ctx.app, ctx.workoutPhase)) {
      this.idleSince = null;
      this.clearTimer();
      return;
    }
    this.idleSince ??= now;
    if (!this.timer) this.arm(BACKUP_IDLE_MS - (now - this.idleSince));
  }

  /** Rückkehr in die App: Wartezeit neu beginnen (gleich startet evtl. Verbinden + Sync). */
  restartIdle(): void {
    this.idleSince = null;
    this.clearTimer();
    this.poke();
  }

  private arm(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = this.deps.now();
      const ctx = this.deps.context();
      // Unmittelbar vor dem Start noch einmal prüfen.
      if (this.idleSince != null && now - this.idleSince >= BACKUP_IDLE_MS && this.due(now) && isIdleForBackup(ctx.app, ctx.workoutPhase)) {
        void this.run();
      } else {
        this.poke();
      }
    }, Math.max(0, ms));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Sichert sofort (nicht während einer laufenden Sicherung). */
  run(): Promise<boolean> {
    this.clearTimer();
    this.running ??= this.doRun().finally(() => {
      this.running = null;
      this.idleSince = null;
    });
    return this.running;
  }

  private async doRun(): Promise<boolean> {
    this.set({ running: true });
    await this.load();
    const at = this.deps.now();
    let tmp: string | null = null;
    try {
      // Absturzschutz: Versuch vermerken, bevor der (speicherintensive) Export beginnt.
      this.meta = { ...this.meta, attemptAt: at };
      await this.deps.setMeta(this.meta);

      const before = sortBackups(await this.deps.list().catch(() => [] as FileEntry[]));
      let name = backupFileName(at);
      tmp = name + TMP_SUFFIX;
      const size = await this.deps.writeParts(tmp, this.deps.exportParts());

      const sameDay = before.find((f) => f.name === name);
      const largest = before.reduce<FileEntry | null>((m, f) => (!m || f.size > m.size ? f : m), null);
      if (sameDay && sameDay === largest && size < sameDay.size * BACKUP_SHRINK_RATIO) {
        // Die größte Sicherung nicht durch eine verdächtig kleine ersetzen – daneben ablegen.
        let n = 2;
        while (before.some((f) => f.name === backupFileName(at, n))) n++;
        name = backupFileName(at, n);
      } else if (sameDay) {
        await this.deps.remove(name); // rename überschreibt auf iOS nicht; die neue Datei ist bereits vollständig
      }
      await this.deps.rename(tmp, name);
      tmp = null;

      this.meta = { at, file: name };
      await this.deps.setMeta(this.meta);
      this.set({ lastAt: at, lastFile: name, error: null });
      this.deps.log(`Automatische Sicherung gespeichert: ${BACKUP_DIR}/${name} (${(size / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB)`);

      const newestOther = before.find((f) => f.name !== name);
      if (newestOther && size < newestOther.size * BACKUP_SHRINK_RATIO) {
        this.deps.log(`Hinweis: Neue Sicherung ist deutlich kleiner als ${newestOther.name} – alte Sicherungen werden vorsichtshalber nicht gelöscht.`);
      } else {
        try {
          for (const old of backupsToDelete(await this.deps.list())) await this.deps.remove(old);
        } catch (e) {
          this.deps.log(`Alte Sicherungen aufräumen: ${msg(e)}`);
        }
      }
      return true;
    } catch (e) {
      if (tmp) await this.deps.remove(tmp).catch(() => {});
      // Versuch ist (mit Fehler) beendet – kein Absturz, also Vermerk entfernen.
      this.meta = { at: this.meta.at, file: this.meta.file };
      await this.deps.setMeta(this.meta).catch(() => {});
      this.retryAt = at + BACKUP_RETRY_MS;
      this.deps.log(`Automatische Sicherung fehlgeschlagen: ${msg(e)}`);
      this.set({ error: 'Automatische Sicherung fehlgeschlagen – wird später erneut versucht.' });
      return false;
    } finally {
      this.set({ running: false });
      await this.refreshFiles();
    }
  }

  /** Eine automatische Sicherung als Datei (für „Einspielen“). */
  readFile(name: string): Promise<File> {
    return this.deps.open(name);
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
