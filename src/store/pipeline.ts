// Berechnet Tageswerte aus den gespeicherten Rohdaten neu.
import { computeDay, dayBounds, localDateString, sleepWindow } from '../analytics';
import type { DailySummary, Profile } from '../types';
import { addDays, today } from '../ui/format';
import { getDays, getSamples, putDay } from './db';

const BASELINE_DAYS = 30;

/**
 * Berechnet alle Tage neu, die von Daten im Zeitraum [fromTs, toTs] betroffen sind.
 * Ein Datensatz am Abend gehört auch zum Schlaffenster des Folgetags, deshalb wird
 * ein Tag mehr gerechnet. Tage werden aufsteigend berechnet, weil die Recovery die
 * vorherigen Tage als Baseline braucht.
 */
export async function recomputeRange(fromTs: number, toTs: number, profile: Profile): Promise<string[]> {
  const first = localDateString(fromTs);
  const last = minDate(addDays(localDateString(toTs), 1), today());
  const done: string[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    const day = await recomputeDay(date, profile);
    if (day) done.push(date);
  }
  return done;
}

export async function recomputeDay(date: string, profile: Profile): Promise<DailySummary | null> {
  const from = sleepWindow(date).start;
  const to = dayBounds(date).end;
  const samples = await getSamples(from, to);
  if (samples.length === 0) return null;
  const previous = await getDays(addDays(date, -BASELINE_DAYS), addDays(date, -1));
  const day = computeDay(date, samples, profile, previous);
  if (day.coveredMin === 0 && !day.sleep) return null;
  await putDay(day);
  return day;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}
