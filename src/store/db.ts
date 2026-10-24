// Lokaler Speicher im Browser (IndexedDB). Nichts davon verlässt das Gerät.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DailySummary, Profile, SampleRecord } from '../types';

interface WhoopDb extends DBSchema {
  samples: { key: number; value: SampleRecord };
  days: { key: string; value: DailySummary };
  kv: { key: string; value: unknown };
}

const DB_NAME = 'whoop-plus';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<WhoopDb>> | null = null;

export function db(): Promise<IDBPDatabase<WhoopDb>> {
  if (!dbPromise) {
    dbPromise = openDB<WhoopDb>(DB_NAME, DB_VERSION, {
      upgrade(d) {
        d.createObjectStore('samples', { keyPath: 'ts' });
        d.createObjectStore('days', { keyPath: 'date' });
        d.createObjectStore('kv');
      },
    });
  }
  return dbPromise;
}

/**
 * Speichert Datensätze. Verlaufsdaten vom Band überschreiben Live-Werte derselben Sekunde,
 * Live-Werte überschreiben niemals Verlaufsdaten. Das Promise löst erst nach dem Commit auf –
 * erst danach darf dem Band der Empfang bestätigt werden.
 */
export async function putSamples(records: SampleRecord[]): Promise<void> {
  if (records.length === 0) return;
  const d = await db();
  // 'strict': erst nach dem Schreiben auf den Datenträger melden – danach wird dem Band bestätigt.
  const tx = d.transaction('samples', 'readwrite', { durability: 'strict' });
  const store = tx.store;
  const ops: Promise<unknown>[] = [];
  for (const r of records) {
    if (r.src === 'history') {
      ops.push(store.put(r));
    } else {
      ops.push(
        store.get(r.ts).then((existing) => {
          if (!existing || existing.src === 'live') return store.put(r);
        }),
      );
    }
  }
  // tx.done zuerst absichern, damit ein Abbruch nicht als unbehandelte Ablehnung endet.
  const done = tx.done;
  try {
    await Promise.all(ops);
  } catch (e) {
    await done.catch(() => {});
    throw e;
  }
  await done;
}

export async function getSamples(from: number, to: number): Promise<SampleRecord[]> {
  const d = await db();
  return d.getAll('samples', IDBKeyRange.bound(from, to, false, true));
}

export async function sampleBounds(): Promise<{ oldest: number | null; newest: number | null; count: number }> {
  const d = await db();
  const tx = d.transaction('samples');
  const first = await tx.store.openCursor();
  const last = await tx.store.openCursor(null, 'prev');
  const count = await tx.store.count();
  return { oldest: first?.value.ts ?? null, newest: last?.value.ts ?? null, count };
}

/** Löscht Rohdaten, die älter als `beforeTs` sind. Tageswerte bleiben erhalten. */
export async function pruneSamples(beforeTs: number): Promise<void> {
  const d = await db();
  await d.delete('samples', IDBKeyRange.upperBound(beforeTs, true));
}

export async function putDay(day: DailySummary): Promise<void> {
  const d = await db();
  await d.put('days', day);
}

export async function getDay(date: string): Promise<DailySummary | undefined> {
  const d = await db();
  return d.get('days', date);
}

/** Tageswerte im Bereich [from, to] (Datumsstrings YYYY-MM-DD), aufsteigend sortiert. */
export async function getDays(from = '0000-00-00', to = '9999-99-99'): Promise<DailySummary[]> {
  const d = await db();
  return d.getAll('days', IDBKeyRange.bound(from, to));
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return (await d.get('kv', key)) as T | undefined;
}

export async function setKv<T>(key: string, value: T): Promise<void> {
  const d = await db();
  await d.put('kv', value, key);
}

export const getProfile = () => getKv<Profile>('profile');
export const setProfile = (p: Profile) => setKv('profile', p);

/** Löscht alle lokalen Daten (Rohdaten, Tageswerte, Einstellungen). */
export async function wipeAll(): Promise<void> {
  const d = await db();
  await Promise.all([d.clear('samples'), d.clear('days'), d.clear('kv')]);
}

/** Bittet den Browser, die Daten nicht automatisch zu löschen. Ergebnis: ob dauerhaft gespeichert wird. */
export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && e.usage != null && e.quota != null ? { usage: e.usage, quota: e.quota } : null;
  } catch {
    return null;
  }
}

// --- Backup ---
// Kompaktes Format: Rohdaten als Arrays [ts, hr, rr[], gx, gy, gz, src(0=history,1=live)].

type PackedSample = [number, number, number[], number | null, number | null, number | null, 0 | 1];

export interface BackupFile {
  app: 'whoop-plus';
  version: 1;
  exportedAt: number;
  kv: Record<string, unknown>;
  days: DailySummary[];
  samples: PackedSample[];
}

/** Erzeugt ein Backup als Blob. Rohdaten werden blockweise gelesen, um den Speicher zu schonen. */
export async function exportBackup(): Promise<Blob> {
  const d = await db();
  const kv: Record<string, unknown> = {};
  let cursor = await d.transaction('kv').store.openCursor();
  while (cursor) {
    kv[String(cursor.key)] = cursor.value;
    cursor = await cursor.continue();
  }
  const days = await d.getAll('days');
  const parts: string[] = [
    `{"app":"whoop-plus","version":1,"exportedAt":${Date.now()},"kv":${JSON.stringify(kv)},"days":${JSON.stringify(days)},"samples":[`,
  ];
  let from = -Infinity;
  let first = true;
  for (;;) {
    const range = from === -Infinity ? undefined : IDBKeyRange.lowerBound(from, true);
    const chunk = await d.getAll('samples', range, 20000);
    if (chunk.length === 0) break;
    const packed = chunk.map((r): PackedSample => [
      r.ts, r.hr, r.rr, r.grav?.[0] ?? null, r.grav?.[1] ?? null, r.grav?.[2] ?? null, r.src === 'live' ? 1 : 0,
    ]);
    const json = JSON.stringify(packed);
    parts.push((first ? '' : ',') + json.slice(1, -1));
    first = false;
    from = chunk[chunk.length - 1].ts;
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

/** Spielt ein Backup ein (zusammenführen, nichts wird gelöscht). Liefert die Anzahl Datensätze. */
export async function importBackup(text: string): Promise<number> {
  const data = JSON.parse(text) as BackupFile;
  if (data.app !== 'whoop-plus' || data.version !== 1) throw new Error('Keine gültige Whoop-Plus-Sicherung.');
  const d = await db();
  for (const [k, v] of Object.entries(data.kv ?? {})) await d.put('kv', v, k);
  const daysTx = d.transaction('days', 'readwrite');
  await Promise.all([...(data.days ?? []).map((day) => daysTx.store.put(day)), daysTx.done]);
  const samples = data.samples ?? [];
  for (let i = 0; i < samples.length; i += 20000) {
    const batch = samples.slice(i, i + 20000).map(([ts, hr, rr, gx, gy, gz, src]): SampleRecord => ({
      ts, hr, rr,
      ...(gx != null && gy != null && gz != null ? { grav: [gx, gy, gz] as [number, number, number] } : {}),
      src: src === 1 ? 'live' : 'history',
    }));
    await putSamples(batch);
  }
  return samples.length;
}
