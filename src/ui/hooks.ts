import { useEffect, useRef, useState } from 'preact/hooks';
import type { WorkoutRecord } from '../analytics/workout';
import { getDay, getDays, getSamples, getWorkouts } from '../store/db';
import type { DailySummary, SampleRecord } from '../types';
import { app, type AppState } from './controller';
import { addDays } from './format';

type Store<S> = { state: S; subscribe(fn: (s: S) => void): () => void };

/** Flacher Vergleich: Primitive per ===, Arrays und einfache Objekte eine Ebene tief. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/**
 * Abonniert nur einen Ausschnitt eines Stores: neu gerendert wird erst, wenn sich der
 * ausgewählte Wert (flach verglichen) ändert. Liest den Zustand beim Abonnieren neu,
 * damit Änderungen zwischen Render und Effekt nicht verloren gehen.
 */
export function useSelect<S, T>(store: Store<S>, select: (s: S) => T): T {
  const [v, setV] = useState(() => select(store.state));
  const sel = useRef(select);
  sel.current = select;
  const cur = useRef(v);
  cur.current = v;
  useEffect(() => {
    const update = (s: S) => {
      const nv = sel.current(s);
      if (!shallowEqual(nv, cur.current)) {
        cur.current = nv;
        setV(nv);
      }
    };
    update(store.state);
    return store.subscribe(update);
  }, [store]);
  return v;
}

/** Alles außer den Live-Pulsdaten (die kommen bis zu 1×/s) – für Seiten und Karten. */
export type AppView = Omit<AppState, 'live' | 'liveSeries'>;
function withoutLive(s: AppState): AppView {
  const { live: _l, liveSeries: _ls, ...rest } = s;
  return rest;
}

export function useApp(): AppView {
  return useSelect(app, withoutLive);
}

/** Live-Puls (nur für Komponenten, die ihn wirklich anzeigen). */
export function useLive(): Pick<AppState, 'live' | 'liveSeries' | 'liveOn' | 'conn'> {
  return useSelect(app, (s) => ({ live: s.live, liveSeries: s.liveSeries, liveOn: s.liveOn, conn: s.conn }));
}

export function useDay(date: string, version: number): DailySummary | null | undefined {
  const [day, setDay] = useState<DailySummary | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    getDay(date).then((d) => alive && setDay(d ?? null));
    return () => { alive = false; };
  }, [date, version]);
  return day;
}

export function useDays(from: string, to: string, version: number): DailySummary[] {
  const [days, setDays] = useState<DailySummary[]>([]);
  useEffect(() => {
    let alive = true;
    getDays(from, to).then((d) => alive && setDays(d));
    return () => { alive = false; };
  }, [from, to, version]);
  return days;
}

/** Lädt Rohdaten eines Zeitraums, auf Minuten verdichtet (für Diagramme). */
export function useMinuteHr(from: number | null, to: number | null, version: number): { ts: number; hr: number }[] {
  const [pts, setPts] = useState<{ ts: number; hr: number }[]>([]);
  useEffect(() => {
    if (from == null || to == null) { setPts([]); return; }
    let alive = true;
    getSamples(from, to).then((s) => alive && setPts(minuteMeans(s)));
    return () => { alive = false; };
  }, [from, to, version]);
  return pts;
}

function minuteMeans(samples: SampleRecord[]): { ts: number; hr: number }[] {
  const out: { ts: number; hr: number }[] = [];
  let minute = -1, sum = 0, n = 0;
  for (const s of samples) {
    if (s.hr <= 0) continue;
    const m = Math.floor(s.ts / 60) * 60;
    if (m !== minute) {
      if (n) out.push({ ts: minute, hr: sum / n });
      minute = m; sum = 0; n = 0;
    }
    sum += s.hr; n++;
  }
  if (n) out.push({ ts: minute, hr: sum / n });
  return out;
}

/** Die bis zu 30 Vortage eines Datums (für Baseline, Trends und Empfehlung). */
export function usePrevious(date: string, version: number): DailySummary[] {
  return useDays(addDays(date, -30), addDays(date, -1), version);
}

/** Alle gespeicherten Workouts, neueste zuerst. */
export function useWorkouts(version: number): WorkoutRecord[] | null {
  const [list, setList] = useState<WorkoutRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    getWorkouts().then((w) => alive && setList(w)).catch(() => alive && setList([]));
    return () => { alive = false; };
  }, [version]);
  return list;
}

/** Abonniert einen einfachen Store mit subscribe()/state. */
export function useStore<S>(store: Store<S>): S {
  const [s, setS] = useState(store.state);
  useEffect(() => {
    setS(store.state);
    return store.subscribe(setS);
  }, [store]);
  return s;
}
