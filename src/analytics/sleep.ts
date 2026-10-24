// Schlaferkennung aus Armwinkel (Beschleunigungssensor) und Puls.
//
// Methode (transparent, keine Nachbildung des WHOOP-Algorithmus):
//
// 1. Minutenepochen (epochs.ts): Armwinkel nach van Hees (2015):
//    z-Winkel = atan(gz / sqrt(gx² + gy²)), gemittelt über 5 s. Eine Minute ist
//    "still", wenn sie in einem Lauf von ≥ 5 Minuten liegt, in dem sich der
//    5-s-Winkel nie um ≥ 5° ändert.
//
// 2. Pulsschwelle aus dem Suchfenster (sofern nicht vorgegeben):
//    P10 = 10. Perzentil, MED = Median der Minuten-Pulsmittel im Fenster.
//      - mit Bewegungsdaten:    Schwelle = max(MED, P10 + 10 bpm)
//      - nur Puls (Fallback):   Schwelle = max(P10 + 0.6·(MED − P10), P10 + 5 bpm)
//    Begründung: Das Fenster (Vortag 18:00 bis 14:00) enthält meist mehr Wach- als
//    Schlafzeit, der Median liegt daher im Wachbereich; P10 approximiert den
//    Schlafpuls. Trägt man das Band nur nachts, greift P10 + 10 bpm.
//
// 3. Ruheminute (Kandidat):
//    - Minute mit Schwerkraftdaten: still UND Puls gültig (≥ 10 Sekunden) UND
//      Minutenpuls < Schwelle. (Ein abgelegtes Band ist zwar still, liefert aber
//      keinen Puls und zählt daher nie als Schlaf.)
//    - Minute ohne Schwerkraftdaten (z. B. Live-Daten): reiner Puls-Fallback –
//      Puls < (strengere) Schwelle UND Puls stabil: Spannweite der Minutenmittel
//      im zentrierten 5-Minuten-Fenster ≤ 10 bpm (mind. 3 Minuten mit Puls).
//      Die HRV wird hier bewusst nicht als Kriterium verwendet, da sie im Schlaf
//      ohnehin schwankt und sonst zirkulär in die HRV-Auswertung einginge.
//
// 4. Ruheblöcke = Läufe von Kandidatenminuten. Blöcke, zwischen denen ≤ 15 Minuten
//    liegen, werden verbunden (die Lücke zählt als Wachzeit im Schlaf – auch wenn
//    dort gar keine Daten vorliegen). Hauptschlaf = längster verbundener Block;
//    kürzer als 3 h → kein Schlaf (null).
//
// 5. Innerhalb der Schlafperiode: Minute = Schlaf, wenn sie eine Kandidatenminute
//    ist; sonst wach (Bewegung, Pulsspitze über der Schwelle oder Datenlücke).
//    Wachphasen = zusammenhängende Wachläufe ≥ 2 Minuten. Effizienz =
//    Schlafminuten / Gesamtminuten. Ruhepuls = niedrigster gleitender
//    10-Minuten-Mittelwert (mind. 6 Minuten mit Puls). HRV = nightlyRmssd über die
//    Samples der Schlafminuten (Wachminuten werden ausgelassen).

import type { SampleRecord, SleepPeriod } from '../types';
import { buildEpochs, ensureSorted, sliceSamples, type Epoch, EPOCH_SEC } from './epochs';
import { nightlyRmssd } from './hrv';

export const MIN_HR_SAMPLES_PER_MIN = 10;
export const MERGE_GAP_MIN = 15;
export const MIN_SLEEP_MIN = 180;
export const MIN_WAKE_EPISODE_MIN = 2;
export const RESTING_HR_WINDOW_MIN = 10;
export const RESTING_HR_MIN_COVERED = 6;
export const HR_ONLY_STABILITY_BPM = 10;
export const THRESHOLD_P10_MARGIN_BPM = 10;
export const HR_ONLY_FRACTION = 0.6;
export const HR_ONLY_MIN_MARGIN_BPM = 5;

export interface SleepOptions {
  /** Feste Pulsschwelle (bpm) statt der aus dem Fenster abgeleiteten. */
  hrThreshold?: number;
}

export interface SleepDetection {
  period: SleepPeriod | null;
  /** Schwelle für Minuten mit Bewegungsdaten. */
  threshold: number | null;
  /** Schwelle für Minuten ohne Bewegungsdaten (Puls-Fallback). */
  thresholdHrOnly: number | null;
  /** Anteil der Pulsminuten im Fenster, die Schwerkraftdaten haben (0–1). */
  gravCoverage: number;
  /** 'accel' wenn überwiegend Bewegungsdaten genutzt wurden, sonst 'hr-only'. */
  mode: 'accel' | 'hr-only';
  /** Minutenepochen des gesamten Suchfensters. */
  epochs: Epoch[];
  /** Kandidatenminuten (1 = Ruhe) parallel zu epochs. */
  rest: Uint8Array;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Vollständige Erkennung inkl. Zwischenergebnissen (für Diagramme/Debug). */
export function detectSleepDetailed(
  samples: readonly SampleRecord[],
  windowStart: number,
  windowEnd: number,
  opts: SleepOptions = {},
): SleepDetection {
  const sorted = ensureSorted(samples);
  const win = sliceSamples(sorted, windowStart, windowEnd);
  const epochs = buildEpochs(win, windowStart, windowEnd);
  const n = epochs.length;
  const rest = new Uint8Array(n);
  const hasHr = (e: Epoch) => e.hrCount >= MIN_HR_SAMPLES_PER_MIN;

  const hrs: number[] = [];
  let gravMinutes = 0;
  for (const e of epochs) {
    if (!hasHr(e)) continue;
    hrs.push(e.hrMean);
    if (e.angleChange !== null) gravMinutes++;
  }
  const gravCoverage = hrs.length ? gravMinutes / hrs.length : 0;
  const mode = gravCoverage >= 0.5 ? 'accel' : 'hr-only';
  const empty: SleepDetection = {
    period: null,
    threshold: null,
    thresholdHrOnly: null,
    gravCoverage,
    mode,
    epochs,
    rest,
  };
  if (hrs.length === 0) return empty;

  hrs.sort((a, b) => a - b);
  const p10 = percentile(hrs, 0.1);
  const med = percentile(hrs, 0.5);
  const threshold = opts.hrThreshold ?? Math.max(med, p10 + THRESHOLD_P10_MARGIN_BPM);
  const thresholdHrOnly =
    opts.hrThreshold ?? Math.max(p10 + HR_ONLY_FRACTION * (med - p10), p10 + HR_ONLY_MIN_MARGIN_BPM);

  for (let i = 0; i < n; i++) {
    const e = epochs[i];
    if (!hasHr(e)) continue;
    if (e.angleChange !== null) {
      rest[i] = e.still && e.hrMean < threshold ? 1 : 0;
    } else {
      if (e.hrMean >= thresholdHrOnly) continue;
      let lo = Infinity;
      let hi = -Infinity;
      let c = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
        if (!hasHr(epochs[j])) continue;
        c++;
        if (epochs[j].hrMean < lo) lo = epochs[j].hrMean;
        if (epochs[j].hrMean > hi) hi = epochs[j].hrMean;
      }
      rest[i] = c >= 3 && hi - lo <= HR_ONLY_STABILITY_BPM ? 1 : 0;
    }
  }

  // Ruheblöcke bilden und verbinden.
  let bestStart = -1;
  let bestEnd = -1; // inklusiv
  let mStart = -1;
  let mEnd = -1;
  const consider = () => {
    if (mStart >= 0 && mEnd - mStart > bestEnd - bestStart) {
      bestStart = mStart;
      bestEnd = mEnd;
    }
  };
  let i = 0;
  while (i < n) {
    if (!rest[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && rest[j + 1]) j++;
    // Block [i, j]
    if (mStart >= 0 && i - mEnd - 1 <= MERGE_GAP_MIN) {
      mEnd = j;
    } else {
      consider();
      mStart = i;
      mEnd = j;
    }
    i = j + 1;
  }
  consider();

  if (bestStart < 0 || bestEnd - bestStart + 1 < MIN_SLEEP_MIN) {
    return { ...empty, threshold, thresholdHrOnly };
  }

  const periodEpochs: { t: number; asleep: 0 | 1 }[] = [];
  let asleepMin = 0;
  let wakeEpisodes = 0;
  let awakeRun = 0;
  for (let k = bestStart; k <= bestEnd; k++) {
    const a: 0 | 1 = rest[k] ? 1 : 0;
    periodEpochs.push({ t: epochs[k].t, asleep: a });
    if (a) {
      asleepMin++;
      if (awakeRun >= MIN_WAKE_EPISODE_MIN) wakeEpisodes++;
      awakeRun = 0;
    } else {
      awakeRun++;
    }
  }
  // Der Block endet per Konstruktion mit einer Schlafminute, daher kein Rest-Lauf.
  const total = bestEnd - bestStart + 1;

  // Ruhepuls: niedrigster gleitender 10-Minuten-Mittelwert.
  let restingHr: number | null = null;
  for (let k = bestStart; k + RESTING_HR_WINDOW_MIN - 1 <= bestEnd; k++) {
    let sum = 0;
    let cnt = 0;
    let covered = 0;
    for (let q = k; q < k + RESTING_HR_WINDOW_MIN; q++) {
      const e = epochs[q];
      if (e.hrCount === 0) continue;
      sum += e.hrMean * e.hrCount;
      cnt += e.hrCount;
      if (hasHr(e)) covered++;
    }
    if (covered < RESTING_HR_MIN_COVERED || cnt === 0) continue;
    const m = sum / cnt;
    if (restingHr === null || m < restingHr) restingHr = m;
  }

  // HRV über die Samples der Schlafminuten.
  const start = epochs[bestStart].t;
  const end = epochs[bestEnd].t + EPOCH_SEC;
  const sleepSamples = sliceSamples(win, start, end).filter(
    (s) => rest[Math.floor((s.ts - epochs[0].t) / EPOCH_SEC)] === 1,
  );
  const hrv = nightlyRmssd(sleepSamples);

  return {
    period: {
      start,
      end,
      asleepMin,
      awakeMin: total - asleepMin,
      wakeEpisodes,
      efficiency: Math.round((asleepMin / total) * 1000) / 1000,
      restingHr: restingHr === null ? null : round1(restingHr),
      hrvRmssd: hrv.rmssd,
      epochs: periodEpochs,
    },
    threshold,
    thresholdHrOnly,
    gravCoverage,
    mode,
    epochs,
    rest,
  };
}

/** Hauptschlaf im Fenster [windowStart, windowEnd) oder null (siehe Methode oben). */
export function detectSleep(
  samples: readonly SampleRecord[],
  windowStart: number,
  windowEnd: number,
  opts: SleepOptions = {},
): SleepPeriod | null {
  return detectSleepDetailed(samples, windowStart, windowEnd, opts).period;
}
