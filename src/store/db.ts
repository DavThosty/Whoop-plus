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
  const tx = d.transaction('samples', 'readwrite');
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
  await Promise.all(ops);
  await tx.done;
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
