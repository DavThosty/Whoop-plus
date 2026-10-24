import { describe, expect, it, vi } from 'vitest';
import {
  AutoBackup, BACKUP_KEEP, backupDate, backupFileName, backupsToDelete, isBackupDue, isIdleForBackup, sortBackups, type BackupDeps,
} from './backup';

const H = 3600_000;
const T0 = new Date(2026, 9, 24, 7, 12).getTime();

const idle = { conn: 'disconnected', postSync: false, computing: false, demo: false, stats: { oldest: 1, newest: 2, count: 500 } } as const;

function fakeFs(initial: string[] = []) {
  const files = new Map<string, string>(initial.map((n) => [n, '{}']));
  let meta: { at: number; file: string } | undefined;
  let now = T0;
  const log: string[] = [];
  const deps: BackupDeps = {
    now: () => now,
    getMeta: async () => meta,
    setMeta: async (m) => void (meta = m),
    exportBlob: vi.fn(async () => new Blob([`{"app":"whoop-plus","at":${now}}`])),
    write: vi.fn(async (name: string, blob: Blob) => void files.set(name, await blob.text())),
    list: async () => [...files.keys()],
    remove: vi.fn(async (name: string) => void files.delete(name)),
    read: async (name) => files.get(name)!,
    log: (l) => log.push(l),
  };
  return { files, deps, log, setNow: (t: number) => (now = t), getMeta: () => meta };
}

describe('Sicherungen: Namen und Rotation', () => {
  it('benennt nach lokalem Datum', () => {
    expect(backupFileName(T0)).toBe('WhoopPlus-Sicherung-2026-10-24.json');
    expect(backupDate('WhoopPlus-Sicherung-2026-10-24.json')).toBe('2026-10-24');
    expect(backupDate('WhoopPlus-Sicherung-2026-10-24.json.tmp')).toBeNull();
    expect(backupDate('notizen.txt')).toBeNull();
  });

  it('sortiert neueste zuerst und behält nur die letzten 7 automatischen Sicherungen', () => {
    const names = Array.from({ length: 10 }, (_, i) => `WhoopPlus-Sicherung-2026-10-${String(10 + i).padStart(2, '0')}.json`);
    const mixed = [...names].reverse().concat(['eigene-Notiz.json', 'whoop-plus-backup-2026-10-01.json']);
    expect(sortBackups(mixed)[0]).toBe('WhoopPlus-Sicherung-2026-10-19.json');
    const del = backupsToDelete(mixed);
    expect(del).toEqual(['WhoopPlus-Sicherung-2026-10-12.json', 'WhoopPlus-Sicherung-2026-10-11.json', 'WhoopPlus-Sicherung-2026-10-10.json']);
    expect(del).not.toContain('eigene-Notiz.json');
    expect(backupsToDelete(names.slice(0, BACKUP_KEEP))).toEqual([]);
  });

  it('ist fällig nach mehr als 20 Stunden (oder ohne bisherige Sicherung)', () => {
    expect(isBackupDue(null, T0)).toBe(true);
    expect(isBackupDue(T0 - 19 * H, T0)).toBe(false);
    expect(isBackupDue(T0 - 20 * H - 1, T0)).toBe(true);
    expect(isBackupDue(T0 + 5 * H, T0)).toBe(true); // Uhr zurückgestellt
  });

  it('sichert nur in ruhigen Momenten', () => {
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

describe('AutoBackup', () => {
  it('startet erst nach dem Laden, schreibt, merkt sich den Zeitpunkt und räumt auf', async () => {
    const old = Array.from({ length: 7 }, (_, i) => `WhoopPlus-Sicherung-2026-10-${String(10 + i).padStart(2, '0')}.json`);
    const fs = fakeFs(old);
    const b = new AutoBackup(fs.deps);
    expect(b.maybeRun(idle, 'idle')).toBe(false); // noch nicht geladen
    await b.load();
    expect(b.state.files).toHaveLength(7);
    expect(b.maybeRun(idle, 'idle')).toBe(true);
    expect(b.maybeRun(idle, 'idle')).toBe(false); // läuft schon
    await vi.waitFor(() => expect(b.state.running).toBe(false));
    expect(fs.files.has('WhoopPlus-Sicherung-2026-10-24.json')).toBe(true);
    expect(fs.files.has('WhoopPlus-Sicherung-2026-10-10.json')).toBe(false); // älteste gelöscht
    expect([...fs.files.keys()]).toHaveLength(7);
    expect(b.state.lastAt).toBe(T0);
    expect(b.state.files[0].date).toBe('2026-10-24');
    expect(fs.getMeta()).toEqual({ at: T0, file: 'WhoopPlus-Sicherung-2026-10-24.json' });
    expect(fs.log.some((l) => l.includes('Automatische Sicherung gespeichert'))).toBe(true);

    // Gleich danach und 19 h später: nicht fällig; 21 h später: wieder.
    expect(b.maybeRun(idle, 'idle')).toBe(false);
    fs.setNow(T0 + 19 * H);
    expect(b.maybeRun(idle, 'idle')).toBe(false);
    fs.setNow(T0 + 21 * H);
    expect(b.maybeRun({ ...idle, conn: 'syncing' }, 'idle')).toBe(false);
    expect(b.maybeRun(idle, 'idle')).toBe(true);
    await vi.waitFor(() => expect(b.state.lastAt).toBe(T0 + 21 * H));
    expect(fs.files.has('WhoopPlus-Sicherung-2026-10-25.json')).toBe(true);
  });

  it('übernimmt den gespeicherten Zeitpunkt beim Start (keine doppelte Sicherung nach Neustart)', async () => {
    const fs = fakeFs();
    await fs.deps.setMeta({ at: T0 - 2 * H, file: 'WhoopPlus-Sicherung-2026-10-24.json' });
    const b = new AutoBackup(fs.deps);
    await b.load();
    expect(b.state.lastAt).toBe(T0 - 2 * H);
    expect(b.maybeRun(idle, 'idle')).toBe(false);
    expect(fs.deps.write).not.toHaveBeenCalled();
  });

  it('Fehler: nur Protokoll und leise Statuszeile, nächster Versuch bleibt fällig', async () => {
    const fs = fakeFs();
    (fs.deps.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Speicher voll'));
    const b = new AutoBackup(fs.deps);
    await b.load();
    expect(await b.run()).toBe(false);
    expect(b.state.error).toMatch(/fehlgeschlagen/);
    expect(b.state.lastAt).toBeNull();
    expect(fs.log.some((l) => l.includes('Speicher voll'))).toBe(true);
    expect(b.maybeRun(idle, 'idle')).toBe(true);
    await vi.waitFor(() => expect(b.state.lastAt).toBe(T0));
    expect(b.state.error).toBeNull();
  });

  it('liest eine Sicherung als Datei zum Einspielen', async () => {
    const fs = fakeFs(['WhoopPlus-Sicherung-2026-10-23.json']);
    fs.files.set('WhoopPlus-Sicherung-2026-10-23.json', '{"app":"whoop-plus"}');
    const b = new AutoBackup(fs.deps);
    const f = await b.readFile('WhoopPlus-Sicherung-2026-10-23.json');
    expect(f.name).toBe('WhoopPlus-Sicherung-2026-10-23.json');
    expect(await f.text()).toBe('{"app":"whoop-plus"}');
  });
});
