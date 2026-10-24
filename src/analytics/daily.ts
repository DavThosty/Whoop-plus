// Tagesauswertung: verbindet Schlaf, HRV, Strain, Kalorien und Recovery.
//
// Ein "Tag" ist der lokale Kalendertag. Der Hauptschlaf zählt zu dem Tag, an dem
// man aufwacht (Suche Vortag 18:00 – 14:00). Strain, TRIMP, Zonen, kcal-Aktivanteil,
// Durchschnitts- und Maximalpuls werden über den Kalendertag OHNE die Minuten der
// erkannten Schlafperiode berechnet (Schlaf ist keine Belastung). Der Grundumsatz
// zählt für alle Minuten des Tages (23/24/25 h bei Zeitumstellung).

import type { DailySummary, Profile, SampleRecord, SleepPeriod } from '../types';
import { buildEpochs, ensureSorted, sliceSamples, type Epoch } from './epochs';
import { caloriesFromEpochs, type CalorieResult } from './calories';
import { computeRecovery, type RecoveryResult } from './recovery';
import { detectSleepDetailed, type SleepDetection } from './sleep';
import { resolveRhr, strainFromTrimp, trimpFromEpochs, type ZoneMinutes } from './strain';
import { dayBounds, localDateString, sleepWindow } from './time';

export interface DayDetails {
  summary: DailySummary;
  recovery: RecoveryResult;
  /** Für Zonen und Kalorien verwendeter Ruhepuls. */
  rhrUsed: number;
  /** Woher der Ruhepuls stammt. */
  rhrSource: 'tonight' | 'previous' | 'default';
  calories: CalorieResult;
  sleepDetection: Omit<SleepDetection, 'epochs' | 'rest'>;
}

interface ActivityStats {
  strain: number;
  trimp: number;
  zoneMinutes: ZoneMinutes;
  calories: CalorieResult;
  avgHr: number | null;
  maxHr: number | null;
  coveredMin: number;
}

function activityStats(
  epochs: readonly Epoch[],
  sleep: SleepPeriod | null,
  profile: Profile,
  rhr: number,
  totalMinutes: number,
): ActivityStats {
  const awake = sleep ? epochs.filter((e) => e.t < sleep.start || e.t >= sleep.end) : epochs;
  const { trimp, zoneMinutes } = trimpFromEpochs(awake, rhr, profile.maxHr);
  let hrSum = 0;
  let hrN = 0;
  let maxHr = 0;
  for (const e of awake) {
    if (e.hrCount === 0) continue;
    hrSum += e.hrMean * e.hrCount;
    hrN += e.hrCount;
    if (e.hrMax > maxHr) maxHr = e.hrMax;
  }
  let coveredMin = 0;
  for (const e of epochs) if (e.hrCount > 0) coveredMin++;
  return {
    strain: strainFromTrimp(trimp),
    trimp,
    zoneMinutes,
    calories: caloriesFromEpochs(awake, profile, rhr, totalMinutes),
    avgHr: hrN > 0 ? Math.round(hrSum / hrN) : null,
    maxHr: hrN > 0 ? Math.round(maxHr) : null,
    coveredMin,
  };
}

/** Wie computeDay, liefert zusätzlich Zwischenergebnisse für die Erklär-Ansichten. */
export function computeDayDetailed(
  date: string,
  samples: readonly SampleRecord[],
  profile: Profile,
  previous: readonly DailySummary[],
): DayDetails {
  const sorted = ensureSorted(samples);
  const sw = sleepWindow(date);
  const db = dayBounds(date);

  const detection = detectSleepDetailed(sliceSamples(sorted, sw.start, sw.end), sw.start, sw.end);
  const sleep = detection.period;
  const sleepPerformance = sleep
    ? Math.round(Math.min(100, (sleep.asleepMin / (profile.sleepNeedH * 60)) * 100))
    : null;

  const prior = previous.filter((d) => d.date < date).sort((a, b) => (a.date < b.date ? 1 : -1));
  const prevRhr = prior.find((d) => d.sleep?.restingHr)?.sleep?.restingHr ?? null;
  const rhrUsed = resolveRhr(sleep?.restingHr, prevRhr);
  const rhrSource = sleep?.restingHr ? 'tonight' : prevRhr ? 'previous' : 'default';

  const dayEpochs = buildEpochs(sliceSamples(sorted, db.start, db.end), db.start, db.end);
  const act = activityStats(dayEpochs, sleep, profile, rhrUsed, (db.end - db.start) / 60);

  const recovery = computeRecovery(
    { hrv: sleep?.hrvRmssd ?? null, rhr: sleep?.restingHr ?? null, sleepPerformance },
    prior,
  );

  const summary: DailySummary = {
    date,
    sleep,
    sleepPerformance,
    recovery: recovery.recovery,
    baselineNights: recovery.baselineNights,
    strain: act.strain,
    trimp: act.trimp,
    zoneMinutes: act.zoneMinutes,
    kcal: act.calories.kcal,
    avgHr: act.avgHr,
    maxHr: act.maxHr,
    coveredMin: act.coveredMin,
    computedAt: Date.now(),
  };
  const detectionInfo = {
    period: detection.period,
    threshold: detection.threshold,
    thresholdHrOnly: detection.thresholdHrOnly,
    gravCoverage: detection.gravCoverage,
    mode: detection.mode,
  };
  return { summary, recovery, rhrUsed, rhrSource, calories: act.calories, sleepDetection: detectionInfo };
}

/**
 * Tagesauswertung für `date` ('YYYY-MM-DD'). `samples` sollten mindestens
 * sleepWindow(date).start bis dayBounds(date).end abdecken; es wird intern gefiltert.
 * `previous` = frühere Tagesergebnisse (für Baseline und Ruhepuls-Ersatz).
 */
export function computeDay(
  date: string,
  samples: readonly SampleRecord[],
  profile: Profile,
  previous: readonly DailySummary[],
): DailySummary {
  return computeDayDetailed(date, samples, profile, previous).summary;
}

export interface LiveDayStats {
  date: string;
  strain: number;
  trimp: number;
  zoneMinutes: ZoneMinutes;
  kcal: number;
  activeKcal: number;
  avgHr: number | null;
  maxHr: number | null;
  coveredMin: number;
  /** Minuten seit lokaler Mitternacht. */
  elapsedMin: number;
}

/**
 * "Heute bisher": Strain, kcal (Grundumsatz seit Mitternacht + Aktivanteil) und
 * Zonenminuten von lokaler Mitternacht bis `nowSec`. Wird `sleep` übergeben,
 * werden dessen Minuten wie in computeDay ausgenommen.
 */
export function liveDayStats(
  samples: readonly SampleRecord[],
  profile: Profile,
  rhr: number | null | undefined,
  opts: { nowSec?: number; sleep?: SleepPeriod | null } = {},
): LiveDayStats {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const date = localDateString(now);
  const db = dayBounds(date);
  const end = Math.min(db.end, now + 1);
  const sorted = ensureSorted(samples);
  const epochs = buildEpochs(sliceSamples(sorted, db.start, end), db.start, end);
  const elapsedMin = Math.max(0, (end - db.start) / 60);
  const act = activityStats(epochs, opts.sleep ?? null, profile, resolveRhr(rhr), elapsedMin);
  return {
    date,
    strain: act.strain,
    trimp: act.trimp,
    zoneMinutes: act.zoneMinutes,
    kcal: act.calories.kcal,
    activeKcal: act.calories.activeKcal,
    avgHr: act.avgHr,
    maxHr: act.maxHr,
    coveredMin: act.coveredMin,
    elapsedMin: Math.round(elapsedMin),
  };
}
