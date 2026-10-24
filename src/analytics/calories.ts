// Energieverbrauch.
//
// Grundumsatz (vereinfacht): Für Mifflin-St Jeor fehlt die Körpergröße im Profil.
// Daher die Faustformel BMR ≈ 22 kcal · kg Körpergewicht · Geschlechtsfaktor pro Tag
// (Mann 1.0, Frau 0.9), gleichmäßig auf die Minuten verteilt (BMR / 1440 je Minute).
// Das ist eine Näherung (typisch ±10–15 % gegenüber Formeln mit Größe und Alter).
//
// Aktive Minuten: Minutenpuls > Ruhepuls + 0.3 · (Maximalpuls − Ruhepuls), d. h.
// über 30 % der Herzfrequenzreserve. Für sie gilt Keytel et al. (2005), kJ/min:
//   Männer: −55.0969 + 0.6309·HR + 0.1988·Gewicht + 0.2017·Alter
//   Frauen: −20.4022 + 0.4472·HR − 0.1263·Gewicht + 0.074·Alter
// kcal = kJ / 4.184; nie negativ und nie unter dem Grundumsatz der Minute.
// Alle übrigen Minuten – auch Schlaf und Minuten ohne Daten – zählen mit dem
// Grundumsatz. Teilweise abgedeckte Minuten werden anteilig gewichtet.

import type { Profile } from '../types';

export const BMR_KCAL_PER_KG_DAY = 22;
export const BMR_SEX_FACTOR = { m: 1.0, w: 0.9 } as const;
export const ACTIVE_HRR_FRACTION = 0.3;
export const KJ_PER_KCAL = 4.184;

/** Grundumsatz pro Tag (kcal) nach der vereinfachten Formel. */
export function bmrKcalPerDay(profile: Profile): number {
  return BMR_KCAL_PER_KG_DAY * profile.weightKg * BMR_SEX_FACTOR[profile.sex];
}

export function bmrKcalPerMin(profile: Profile): number {
  return bmrKcalPerDay(profile) / 1440;
}

/** Keytel-Formel in kcal/min (nie negativ). */
export function keytelKcalPerMin(hr: number, profile: Profile): number {
  const { weightKg: w, age: a } = profile;
  const kj =
    profile.sex === 'm'
      ? -55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * a
      : -20.4022 + 0.4472 * hr - 0.1263 * w + 0.074 * a;
  return Math.max(0, kj / KJ_PER_KCAL);
}

/** Pulsschwelle für "aktive" Minuten. */
export function activeThresholdHr(rhr: number, maxHr: number): number {
  return rhr + ACTIVE_HRR_FRACTION * (maxHr - rhr);
}

export interface CalorieResult {
  /** Gesamt-kcal (gerundet). */
  kcal: number;
  /** Grundumsatz-Anteil über alle Minuten. */
  bmrKcal: number;
  /** Zusatzverbrauch der aktiven Minuten über dem Grundumsatz. */
  activeKcal: number;
  /** Aktive Minuten (anteilig nach Abdeckung). */
  activeMin: number;
}

/**
 * kcal über einen Zeitraum von `totalMinutes` Minuten. `epochs` sind die Minuten
 * mit möglicher Aktivität (Schlafminuten vorher entfernen); alle restlichen
 * Minuten bis totalMinutes zählen mit dem Grundumsatz.
 */
export function caloriesFromEpochs(
  epochs: readonly { hrMean: number; hrCount: number }[],
  profile: Profile,
  rhr: number,
  totalMinutes: number,
): CalorieResult {
  const bmrMin = bmrKcalPerMin(profile);
  const thr = activeThresholdHr(rhr, profile.maxHr);
  let extra = 0;
  let activeMin = 0;
  for (const e of epochs) {
    if (e.hrCount <= 0 || !(e.hrMean > thr)) continue;
    const frac = Math.min(1, e.hrCount / 60);
    extra += frac * Math.max(0, keytelKcalPerMin(e.hrMean, profile) - bmrMin);
    activeMin += frac;
  }
  const bmrKcal = bmrMin * Math.max(0, totalMinutes);
  return {
    kcal: Math.round(bmrKcal + extra),
    bmrKcal: Math.round(bmrKcal),
    activeKcal: Math.round(extra),
    activeMin: Math.round(activeMin * 10) / 10,
  };
}
