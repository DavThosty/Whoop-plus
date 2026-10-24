// Abgeleitete Werte für die Oberfläche (Empfehlung, Abweichung vom Normalwert, Recovery-Zerlegung).
import { computeBaseline, computeRecovery, recommendDay, type Recommendation, type RecoveryResult } from '../analytics';
import type { DailySummary, Profile } from '../types';

export function buildRecommendation(day: DailySummary | null | undefined, previous: DailySummary[], profile: Profile | null): Recommendation | null {
  if (!day) return null;
  const nights = [day, ...previous]
    .filter((d) => d.sleep)
    .map((d) => ({ end: d.sleep!.end, awakeMin: d.sleep!.awakeMin }));
  return recommendDay({
    recovery: day.recovery,
    sleepPerformance: day.sleepPerformance,
    sleepNeedH: profile?.sleepNeedH ?? 8,
    recentNights: nights,
    baselineNights: day.baselineNights,
  });
}

export interface Vitals {
  hrv: number | null;
  hrvTypical: number | null;
  /** Abweichung in Prozent vom typischen Wert. */
  hrvDeltaPct: number | null;
  rhr: number | null;
  rhrMean: number | null;
  rhrDelta: number | null;
  /** Normalbereiche (± 1 SD) für Diagramme. */
  hrvBand: { y0: number; y1: number } | null;
  rhrBand: { y0: number; y1: number } | null;
}

export function vitals(day: DailySummary | null | undefined, previous: DailySummary[]): Vitals {
  const base = computeBaseline(previous.filter((d) => !day || d.date < day.date));
  const hrv = day?.sleep?.hrvRmssd ?? null;
  const rhr = day?.sleep?.restingHr ?? null;
  const enough = !!base && base.nights >= 2;
  return {
    hrv,
    hrvTypical: enough ? base!.hrvTypical : null,
    hrvDeltaPct: enough && hrv ? (hrv / base!.hrvTypical - 1) * 100 : null,
    rhr,
    rhrMean: enough ? base!.rhrMean : null,
    rhrDelta: enough && rhr ? rhr - base!.rhrMean : null,
    hrvBand: enough ? { y0: Math.exp(base!.lnHrvMean - base!.lnHrvSd), y1: Math.exp(base!.lnHrvMean + base!.lnHrvSd) } : null,
    rhrBand: enough ? { y0: base!.rhrMean - base!.rhrSd, y1: base!.rhrMean + base!.rhrSd } : null,
  };
}

/** Recovery-Komponenten des Tages neu berechnen (gleiche Funktion wie bei der Tagesauswertung). */
export function recoveryBreakdown(day: DailySummary | null | undefined, previous: DailySummary[]): RecoveryResult | null {
  if (!day) return null;
  return computeRecovery(
    { hrv: day.sleep?.hrvRmssd ?? null, rhr: day.sleep?.restingHr ?? null, sleepPerformance: day.sleepPerformance },
    previous.filter((d) => d.date < day.date),
  );
}
