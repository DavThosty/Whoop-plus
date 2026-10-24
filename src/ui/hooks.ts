import { useEffect, useState } from 'preact/hooks';
import { getDay, getDays, getSamples } from '../store/db';
import type { DailySummary, SampleRecord } from '../types';
import { app, type AppState } from './controller';

export function useApp(): AppState {
  const [s, setS] = useState(app.state);
  useEffect(() => app.subscribe(setS), []);
  return s;
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
