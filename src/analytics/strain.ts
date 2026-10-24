// Belastung (Strain) nach Edwards-TRIMP.
//
// %HRR (Herzfrequenzreserve, Karvonen) = (HR − Ruhepuls) / (Maximalpuls − Ruhepuls)
// Zonen nach Edwards (1993):
//   Zone 1: 50–60 % HRR → Gewicht 1     Zone 4: 80–90 % → Gewicht 4
//   Zone 2: 60–70 %     → Gewicht 2     Zone 5: ≥ 90 %  → Gewicht 5
//   Zone 3: 70–80 %     → Gewicht 3     unter 50 %: keine Punkte
// TRIMP = Σ (Minuten in Zone z · z). Grundlage ist der Minutenmittelwert des Pulses;
// eine Minute zählt anteilig nach ihrer Datenabdeckung (gültige Sekunden / 60).
// Strain = 21 · ln(TRIMP + 1) / ln(7201), begrenzt auf 0–21, 1 Nachkommastelle.
// (7200 TRIMP = 24 h in Zone 5 ergäbe genau 21.)

export const ZONE_LOWER_BOUNDS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
export const STRAIN_MAX = 21;
export const STRAIN_TRIMP_REF = 7200;
/** Ersatz-Ruhepuls, solange noch keine Nacht gemessen wurde. */
export const DEFAULT_RHR = 60;

export type ZoneMinutes = [number, number, number, number, number];

/** Anteil der Herzfrequenzreserve (0 = Ruhepuls, 1 = Maximalpuls). */
export function percentHrr(hr: number, rhr: number, maxHr: number): number {
  const reserve = maxHr - rhr;
  if (!(reserve > 0)) return 0;
  return (hr - rhr) / reserve;
}

/** Edwards-Zone 1–5 oder 0 (unter 50 % HRR bzw. kein Puls). */
export function hrZone(hr: number, rhr: number, maxHr: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (!(hr > 0)) return 0;
  const p = percentHrr(hr, rhr, maxHr);
  for (let z = 4; z >= 0; z--) {
    if (p >= ZONE_LOWER_BOUNDS[z]) return (z + 1) as 1 | 2 | 3 | 4 | 5;
  }
  return 0;
}

export interface TrimpResult {
  trimp: number;
  zoneMinutes: ZoneMinutes;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** TRIMP und Zonenminuten aus Minutenepochen. */
export function trimpFromEpochs(
  epochs: readonly { hrMean: number; hrCount: number }[],
  rhr: number,
  maxHr: number,
): TrimpResult {
  const zm: ZoneMinutes = [0, 0, 0, 0, 0];
  let trimp = 0;
  for (const e of epochs) {
    if (e.hrCount <= 0) continue;
    const z = hrZone(e.hrMean, rhr, maxHr);
    if (z === 0) continue;
    const frac = Math.min(1, e.hrCount / 60);
    zm[z - 1] += frac;
    trimp += frac * z;
  }
  return { trimp: round1(trimp), zoneMinutes: zm.map(round1) as ZoneMinutes };
}

/** Strain 0–21 aus TRIMP (logarithmische Skala). */
export function strainFromTrimp(trimp: number): number {
  if (!(trimp > 0)) return 0;
  const s = (STRAIN_MAX * Math.log(trimp + 1)) / Math.log(STRAIN_TRIMP_REF + 1);
  return round1(Math.min(STRAIN_MAX, Math.max(0, s)));
}

/** Erster gültiger Ruhepuls aus den Kandidaten (z. B. heutige Nacht, letzte Nacht), sonst 60. */
export function resolveRhr(...candidates: (number | null | undefined)[]): number {
  for (const c of candidates) if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
  return DEFAULT_RHR;
}
