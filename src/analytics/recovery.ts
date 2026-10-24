// Recovery (Erholung) als Abweichung vom persönlichen Normalwert.
//
// Baseline: bis zu 30 der letzten Vortage, die einen Schlaf mit HRV und Ruhepuls haben.
// Mindestens 4 solche Nächte sind nötig, sonst null ("Kalibrierung").
//
//   zHRV   = (ln(HRV) − Mittel(ln HRV)) / SD(ln HRV)        SD mindestens 0.05
//   zRHR   = −(RHR − Mittel(RHR)) / SD(RHR)                 SD mindestens 1.5 bpm
//   zSchlaf = (Schlafleistung/100 − 0.85) / 0.15            (fehlend → 0)
//   c = 0.60·zHRV + 0.25·zRHR + 0.15·zSchlaf
//   Recovery = round(100 / (1 + e^−(1.2·c + 0.3))), begrenzt auf 1–99 %
//
// SD = Stichproben-Standardabweichung (n − 1). Die HRV wird logarithmiert, weil
// RMSSD rechtsschief verteilt ist; eine Verdopplung und eine Halbierung wirken
// dadurch gleich stark. Bei c = 0 (alles normal) ergibt sich ≈ 57 %.

import type { DailySummary } from '../types';

export const BASELINE_MAX_NIGHTS = 30;
export const BASELINE_MIN_NIGHTS = 4;
export const LN_HRV_SD_FLOOR = 0.05;
export const RHR_SD_FLOOR = 1.5;
export const SLEEP_REF = 0.85;
export const SLEEP_SCALE = 0.15;
export const W_HRV = 0.6;
export const W_RHR = 0.25;
export const W_SLEEP = 0.15;
export const LOGISTIC_SLOPE = 1.2;
export const LOGISTIC_OFFSET = 0.3;

export interface RecoveryInput {
  /** Nächtliche RMSSD (ms). */
  hrv: number | null;
  /** Ruhepuls (bpm). */
  rhr: number | null;
  /** Schlafleistung 0–100. */
  sleepPerformance: number | null;
}

export interface RecoveryBaseline {
  nights: number;
  lnHrvMean: number;
  lnHrvSd: number;
  /** exp(Mittel ln HRV) = geometrisches Mittel der HRV in ms. */
  hrvTypical: number;
  rhrMean: number;
  rhrSd: number;
}

export interface RecoveryComponents {
  zHrv: number;
  zRhr: number;
  zSleep: number;
  composite: number;
  /** Gewichtete Beiträge (0.60·zHRV usw.) für die Erklärung. */
  contributions: { hrv: number; rhr: number; sleep: number };
}

export interface RecoveryResult {
  recovery: number | null;
  baselineNights: number;
  baseline: RecoveryBaseline | null;
  components: RecoveryComponents | null;
  /** Warum keine Recovery berechnet wurde. */
  reason: 'ok' | 'calibrating' | 'missing-today';
}

function meanSd(xs: number[]): [number, number] {
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return [m, 0];
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1);
  return [m, Math.sqrt(v)];
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Baseline aus den Vortagen (neueste zuerst, maximal 30 Nächte mit HRV und RHR). */
export function computeBaseline(previous: readonly DailySummary[]): RecoveryBaseline | null {
  const nights = [...previous]
    .filter(
      (d) =>
        d.sleep !== null &&
        typeof d.sleep.hrvRmssd === 'number' &&
        d.sleep.hrvRmssd > 0 &&
        typeof d.sleep.restingHr === 'number' &&
        d.sleep.restingHr > 0,
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, BASELINE_MAX_NIGHTS);
  if (nights.length === 0) return null;
  const [lnHrvMean, lnHrvSd] = meanSd(nights.map((d) => Math.log(d.sleep!.hrvRmssd!)));
  const [rhrMean, rhrSd] = meanSd(nights.map((d) => d.sleep!.restingHr!));
  return {
    nights: nights.length,
    lnHrvMean,
    lnHrvSd,
    hrvTypical: Math.exp(lnHrvMean),
    rhrMean,
    rhrSd,
  };
}

/** Recovery für heute relativ zur Baseline aus `previous` (nur Vortage übergeben). */
export function computeRecovery(today: RecoveryInput, previous: readonly DailySummary[]): RecoveryResult {
  const baseline = computeBaseline(previous);
  const baselineNights = baseline?.nights ?? 0;
  if (!baseline || baselineNights < BASELINE_MIN_NIGHTS) {
    return { recovery: null, baselineNights, baseline, components: null, reason: 'calibrating' };
  }
  if (!(today.hrv && today.hrv > 0) || !(today.rhr && today.rhr > 0)) {
    return { recovery: null, baselineNights, baseline, components: null, reason: 'missing-today' };
  }
  const zHrv = (Math.log(today.hrv) - baseline.lnHrvMean) / Math.max(baseline.lnHrvSd, LN_HRV_SD_FLOOR);
  const zRhr = -(today.rhr - baseline.rhrMean) / Math.max(baseline.rhrSd, RHR_SD_FLOOR);
  const zSleep =
    today.sleepPerformance === null || !Number.isFinite(today.sleepPerformance)
      ? 0
      : (today.sleepPerformance / 100 - SLEEP_REF) / SLEEP_SCALE;
  const composite = W_HRV * zHrv + W_RHR * zRhr + W_SLEEP * zSleep;
  const raw = Math.round(100 / (1 + Math.exp(-(LOGISTIC_SLOPE * composite + LOGISTIC_OFFSET))));
  const recovery = Math.min(99, Math.max(1, raw));
  return {
    recovery,
    baselineNights,
    baseline,
    components: {
      zHrv: round2(zHrv),
      zRhr: round2(zRhr),
      zSleep: round2(zSleep),
      composite: round2(composite),
      contributions: {
        hrv: round2(W_HRV * zHrv),
        rhr: round2(W_RHR * zRhr),
        sleep: round2(W_SLEEP * zSleep),
      },
    },
    reason: 'ok',
  };
}
