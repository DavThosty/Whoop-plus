import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoBackup, BACKUP_IDLE_MS, BACKUP_KEEP, BACKUP_RETRY_MS, backupDate, backupFileName, backupsToDelete, isBackupDue, isIdleForBackup, sortBackups,
  type BackupContext, type BackupDeps, type BackupMeta, type FileEntry,
} from './backup';

const H = 3600_000;
const T0 = new Date(2026, 9, 24, 7, 12).getTime();
const day = (d: number) => `WhoopPlus-Sicherung-2026-10-${String(d).padStart(2, '0')}.json`;

type Ctx = { -readonly [K in keyof BackupContext['app']]: BackupContext['app'][K] };
const idleApp = (): Ctx => ({ conn: 'disconnected', postSync: false, computing: false, demo: false, stats: { oldest: 1, newest: 2, count: 500 } });

/** Simuliertes Dateisystem + Abhängigkeiten. Inhalt der Sicherung = `content` (steuerbar für Größentests). */
function fakeFs(initial: [string, number][] = []) {
  const files = new Map<string, string>(initial.map(([n, size]) => [n, 'x'.repeat(size)]));
  let meta: BackupMeta | undefined;
  let now = T0;
  let content = 'y'.repeat(1000);
  let failWrite: Error | null = null;
  let failAfterBytes: number | null = null;
  const ctx: { app: Ctx; workoutPhase: BackupContext['workoutPhase'] } = { app: idleApp(), workoutPhase: 'idle' };
  const log: string[] = [];
  const deps: BackupDeps = {
    now: () => now,
    context: () => ctx,
    getMeta: async () => meta,
    setMeta: vi.fn(async (m: BackupMeta) => void (meta = { ...m })),
    exportParts: async function* () {
      // in drei Teilen, wie der echte Export
      const third = Math.ceil(content.length / 3);
      for (let i = 0; i < content.length; i += third) yield content.slice(i, i + third);
    },
    writeParts: vi.fn(async (name: string, parts: AsyncIterable<string>) => {
      let data = '';
      for await (const p of parts) {
        data += p;
        files.set(name, data); // Datei wächst schrittweise wie beim echten Anhängen
        if (failAfterBytes != null && data.length >= failAfterBytes) throw new Error('Speicher voll');
      }
      if (failWrite) throw failWrite;
      return data.length;
    }),
    list: async () => [...files].map(([name, d]): FileEntry => ({ name, size: d.length })),
    rename: vi.fn(async (from: string, to: string) => {
      if (files.has(to)) throw new Error('Ziel existiert');
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    remove: vi.fn(async (name: string) => {
      if (!files.delete(name)) throw new Error('nicht gefunden');
    }),
    open: async (name) => new File([files.get(name)!], name),
    log: (l) => log.push(l),
  };
  return {
    files, deps, log, ctx,
    setNow: (t: number) => (now = t),
    advance: async (ms: number) => {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    setContent: (n: number) => (content = 'y'.repeat(n)),
    failWith: (e: Error | null) => (failWrite = e),
    failAfter: (n: number | null) => (failAfterBytes = n),
    getMeta: () => meta,
    setMeta: (m: BackupMeta) => (meta = m),
  };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

async function loaded(fs: ReturnType<typeof fakeFs>) {
  const b = new AutoBackup(fs.deps);
  await b.load();
  return b;
}

describe('Sicherungen: Namen und Rotation', () => {
  it('benennt nach lokalem Datum', () => {
    expect(backupFileName(T0)).toBe(day(24));
    expect(backupFileName(T0, 2)).toBe('WhoopPlus-Sicherung-2026-10-24-2.json');
    expect(backupDate(day(24))).toBe('2026-10-24');
    expect(backupDate('WhoopPlus-Sicherung-2026-10-24-2.json')).toBe('2026-10-24');
    expect(backupDate(`${day(24)}.tmp`)).toBeNull();
    expect(backupDate('notizen.txt')).toBeNull();
  });

  it('behält die neuesten 7 plus die größte; fremde Dateien bleiben', () => {
    const files: FileEntry[] = Array.from({ length: 10 }, (_, i) => ({ name: day(10 + i), size: 100 }));
    files[1].size = 999; // 11. ist die größte
    const mixed = [...files].reverse().concat([{ name: 'eigene-Notiz.json', size: 5 }]);
    expect(sortBackups(mixed)[0].name).toBe(day(19));
    expect(sortBackups([{ name: day(24), size: 1 }, { name: 'WhoopPlus-Sicherung-2026-10-24-2.json', size: 1 }])[0].name).toBe('WhoopPlus-Sicherung-2026-10-24-2.json');
    expect(backupsToDelete(mixed)).toEqual([day(12), day(10)]);
    expect(backupsToDelete(files.slice(0, BACKUP_KEEP))).toEqual([]);
  });

  it('ist fällig nach mehr als 20 Stunden (oder ohne bisherige Sicherung)', () => {
    expect(isBackupDue(null, T0)).toBe(true);
    expect(isBackupDue(T0 - 19 * H, T0)).toBe(false);
    expect(isBackupDue(T0 - 20 * H - 1, T0)).toBe(true);
    expect(isBackupDue(T0 + 5 * H, T0)).toBe(true); // Uhr zurückgestellt
  });

  it('sichert nur in ruhigen Momenten', () => {
    const idle = idleApp();
    expect(isIdleForBackup(idle, 'idle')).toBe(true);
    expect(isIdleForBackup({ ...idle, conn: 'connected' }, 'summary')).toBe(true);
    expect(isIdleForBackup({ ...idle, conn: 'syncing' }, 'idle')).toBe(false);
    expect(isIdleForBackup({ ...idle, conn: 'connecting' }, 'idle')).toBe(false);
    expect(isIdleForBackup({ ...idle, postSync: true }, 'idle')).toBe(false);
    expect(isIdleForBackup({ ...idle, computing: true }, 'idle')).toBe(false);
    expect(isIdleForBackup(idle, 'active')).toBe(false);
    expect(isIdleForBackup(idle, 'paused')).toBe(false);
    expect(isIdleForBackup({ ...idle, demo: true }, 'idle')).toBe(false);
    expect(isIdleForBackup({ ...idle, stats: null }, 'idle')).toBe(false);
    expect(isIdleForBackup({ ...idle, stats: { oldest: null, newest: null, count: 0 } }, 'idle')).toBe(false);
  });
});

describe('AutoBackup: Zeitpunkt (60 s Ruhe)', () => {
  it('startet erst nach 60 s ununterbrochener Ruhe; Unruhe setzt die Wartezeit zurück', async () => {
    const fs = fakeFs();
    const b = await loaded(fs); // load() stößt die Wartezeit selbst an
    await fs.advance(BACKUP_IDLE_MS - 1000);
    expect(fs.deps.writeParts).not.toHaveBeenCalled();
    // Beim Öffnen beginnt das automatische Verbinden → Wartezeit zurück.
    fs.ctx.app.conn = 'connecting';
    b.poke();
    await fs.advance(5000);
    fs.ctx.app.conn = 'syncing';
    b.poke();
    await fs.advance(30_000);
    fs.ctx.app.conn = 'connected';
    fs.ctx.app.postSync = true;
    b.poke();
    await fs.advance(BACKUP_IDLE_MS);
    expect(fs.deps.writeParts).not.toHaveBeenCalled();
    // Nach Sync + Auswertung: 60 s Ruhe, dann Sicherung.
    fs.ctx.app.postSync = false;
    b.poke();
    await fs.advance(BACKUP_IDLE_MS - 1);
    expect(fs.deps.writeParts).not.toHaveBeenCalled();
    await fs.advance(1);
    await vi.waitFor(() => expect(b.state.lastAt).not.toBeNull());
    expect(fs.files.has(day(24))).toBe(true);
  });

  it('prüft direkt vor dem Start erneut (Workout begonnen, ohne dass poke kam)', async () => {
    const fs = fakeFs();
    const b = await loaded(fs);
    await fs.advance(30_000);
    fs.ctx.workoutPhase = 'active';
    await fs.advance(BACKUP_IDLE_MS);
    expect(fs.deps.writeParts).not.toHaveBeenCalled();
    fs.ctx.workoutPhase = 'summary';
    b.poke();
    await fs.advance(BACKUP_IDLE_MS);
    await vi.waitFor(() => expect(b.state.lastAt).not.toBeNull());
  });

  it('Rückkehr in die App startet die Wartezeit neu', async () => {
    const fs = fakeFs();
    const b = await loaded(fs);
    await fs.advance(50_000);
    b.restartIdle();
    await fs.advance(50_000);
    expect(fs.deps.writeParts).not.toHaveBeenCalled();
    await fs.advance(10_000);
    await vi.waitFor(() => expect(b.state.lastAt).not.toBeNull());
  });

  it('nicht fällig: kein Start; 21 h später wieder', async () => {
    const fs = fakeFs();
    fs.setMeta({ at: T0 - 2 * H, file: day(24) });
    const b = await loaded(fs);
    await fs.advance(5 * BACKUP_IDLE_MS);
    expect(fs.deps.writeParts).not.toHaveBeenCalled();
    fs.setNow(T0 + 19 * H);
    b.poke();
    await fs.advance(BACKUP_IDLE_MS);
    expect(fs.deps.writeParts).toHaveBeenCalledTimes(1);
  });
});

describe('AutoBackup: Schreiben und Schutz', () => {
  it('schreibt atomar über .tmp und ersetzt eine Datei vom selben Tag erst, wenn die neue vollständig ist', async () => {
    const fs = fakeFs([[day(24), 1200]]);
    const b = await loaded(fs);
    // Schreiben bricht mitten drin ab → die gute Datei bleibt unverändert, .tmp wird entfernt.
    fs.failAfter(400);
    expect(await b.run()).toBe(false);
    expect(fs.files.get(day(24))).toHaveLength(1200);
    expect([...fs.files.keys()]).toEqual([day(24)]);
    // Zweiter Versuch gelingt: alte Datei wird erst nach dem vollständigen Schreiben ersetzt.
    fs.failAfter(null);
    fs.setNow(T0 + 2 * H); // Fehler-Wartezeit vorbei
    expect(await b.run()).toBe(true);
    expect(fs.files.get(day(24))).toHaveLength(1000);
    expect([...fs.files.keys()]).toEqual([day(24)]);
    expect((fs.deps.rename as ReturnType<typeof vi.fn>).mock.calls).toEqual([[`${day(24)}.tmp`, day(24)]]);
  });

  it('räumt liegengebliebene .tmp-Dateien beim Laden weg', async () => {
    const fs = fakeFs([[day(23), 1000], [`${day(23)}.tmp`, 300]]);
    const b = await loaded(fs);
    expect(fs.files.has(`${day(23)}.tmp`)).toBe(false);
    expect(b.state.files.map((f) => f.name)).toEqual([day(23)]);
  });

  it('rotiert auf 7 + die größte', async () => {
    const old: [string, number][] = Array.from({ length: 7 }, (_, i) => [day(10 + i), 900]);
    old[0][1] = 1500; // älteste ist die größte
    const fs = fakeFs([...old, [day(9), 800]]);
    const b = await loaded(fs);
    expect(await b.run()).toBe(true);
    const names = [...fs.files.keys()].sort();
    expect(names).toEqual([day(10), day(11), day(12), day(13), day(14), day(15), day(16), day(24)]);
    expect(fs.getMeta()).toEqual({ at: T0, file: day(24) });
  });

  it('räumt nicht auf, wenn die neue Sicherung kleiner als die Hälfte der letzten ist', async () => {
    const old: [string, number][] = Array.from({ length: 8 }, (_, i) => [day(10 + i), 3000]);
    const fs = fakeFs(old);
    fs.setContent(1000);
    const b = await loaded(fs);
    expect(await b.run()).toBe(true);
    expect(fs.files.size).toBe(9);
    expect(fs.log.some((l) => l.includes('deutlich kleiner'))).toBe(true);
  });

  it('ersetzt die größte Sicherung vom selben Tag nicht durch eine verdächtig kleine', async () => {
    const fs = fakeFs([[day(24), 5000]]);
    fs.setContent(1000);
    const b = await loaded(fs);
    expect(await b.run()).toBe(true);
    expect(fs.files.get(day(24))).toHaveLength(5000);
    expect(fs.files.get('WhoopPlus-Sicherung-2026-10-24-2.json')).toHaveLength(1000);
    expect(b.state.files[0].name).toBe('WhoopPlus-Sicherung-2026-10-24-2.json');
  });

  it('Absturzschutz: Vermerk vor dem Export; unbeendeter Versuch von heute → bis morgen aussetzen', async () => {
    const fs = fakeFs();
    // Vermerk wird vor dem Schreiben gesetzt …
    (fs.deps.writeParts as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      expect(fs.getMeta()?.attemptAt).toBe(T0);
      throw new Error('abgebrochen');
    });
    const b1 = await loaded(fs);
    await b1.run();
    // … und nach einem (normalen) Fehler wieder entfernt.
    expect(fs.getMeta()?.attemptAt).toBeUndefined();

    // Simulierter Absturz: Vermerk blieb stehen.
    fs.setMeta({ attemptAt: T0 - H });
    const b2 = await loaded(fs);
    expect(fs.log.some((l) => l.includes('nicht beendet'))).toBe(true);
    await fs.advance(3 * BACKUP_IDLE_MS);
    expect(fs.deps.writeParts).toHaveBeenCalledTimes(1); // nur der erste Versuch oben
    // Am nächsten Tag wieder.
    const next = new Date(2026, 9, 25, 8, 0).getTime();
    fs.setNow(next);
    b2.poke();
    await fs.advance(BACKUP_IDLE_MS);
    await vi.waitFor(() => expect(b2.state.lastFile).toBe(day(25)));
    expect(fs.getMeta()).toEqual({ at: next + BACKUP_IDLE_MS, file: day(25) });
  });

  it('Fehler: nur Protokoll und leise Statuszeile; erneuter Versuch frühestens nach einer Stunde', async () => {
    const fs = fakeFs();
    const b = await loaded(fs);
    fs.failWith(new Error('Speicher voll'));
    expect(await b.run()).toBe(false);
    expect(b.state.error).toMatch(/fehlgeschlagen/);
    expect(b.state.lastAt).toBeNull();
    expect(fs.log.some((l) => l.includes('Speicher voll'))).toBe(true);
    expect([...fs.files.keys()]).toEqual([]);
    fs.failWith(null);
    b.poke();
    await fs.advance(BACKUP_IDLE_MS * 5);
    expect(fs.deps.writeParts).toHaveBeenCalledTimes(1);
    fs.setNow(T0 + BACKUP_RETRY_MS);
    b.poke();
    await fs.advance(BACKUP_IDLE_MS);
    await vi.waitFor(() => expect(b.state.lastAt).not.toBeNull());
    expect(b.state.error).toBeNull();
  });

  it('liest eine Sicherung als Datei zum Einspielen', async () => {
    const fs = fakeFs([[day(23), 10]]);
    const b = new AutoBackup(fs.deps);
    const f = await b.readFile(day(23));
    expect(f.name).toBe(day(23));
    expect(await f.text()).toBe('x'.repeat(10));
  });
});
