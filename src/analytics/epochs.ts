// Aggregation der Sekundendaten zu 1-Minuten-Epochen.
//
// Pro Minute werden gesammelt:
//  - Puls: Mittelwert, Maximum und Anzahl gültiger Sekunden (hr > 0)
//  - alle RR-Intervalle der Minute in zeitlicher Reihenfolge
//  - Armwinkel (van Hees 2015): z-Winkel = atan(gz / sqrt(gx² + gy²)) in Grad,
//    gemittelt über 5-Sekunden-Blöcke. `angleChange` ist die größte absolute
//    Differenz zwischen zwei aufeinanderfolgenden 5-s-Blöcken, deren zweiter in
//    dieser Minute beginnt.
//  - Ruhe ("still"): Eine Minute ist still, wenn sie Teil eines Laufs von
//    mindestens 5 aufeinanderfolgenden Minuten ist, in denen keine Winkeländerung
//    ≥ 5° auftritt (rollierendes 5-Minuten-Fenster nach van Hees).
//
// Die Funktion läuft in einem Durchgang über die (sortierten) Samples und nutzt
// typisierte Arrays, sodass ~130 000 Samples in wenigen Millisekunden verarbeitet werden.

import type { SampleRecord } from '../types';

export const EPOCH_SEC = 60;
/** Länge der Blöcke, über die der z-Winkel gemittelt wird. */
export const ANGLE_BLOCK_SEC = 5;
/** Winkeländerung (Grad), ab der eine Bewegung vorliegt. */
export const STILL_ANGLE_DEG = 5;
/** Mindestlänge eines ruhigen Laufs in Minuten. */
export const STILL_RUN_MIN = 5;
/** Mindestanzahl von 5-s-Differenzen, damit eine Minute einen Winkelwert hat. */
export const MIN_ANGLE_DIFFS = 3;

export interface Epoch {
  /** Minutenbeginn (Unix-Sekunden, auf volle Minute ausgerichtet). */
  t: number;
  /** Mittlerer Puls der gültigen Sekunden; 0, wenn hrCount = 0. */
  hrMean: number;
  /** Anzahl Sekunden mit gültigem Puls (0–60). */
  hrCount: number;
  /** Höchster Sekundenpuls; 0, wenn keine Daten. */
  hrMax: number;
  /** RR-Intervalle (ms) der Minute in Reihenfolge. */
  rr: number[];
  /** Anzahl Sekunden mit Schwerkraftvektor. */
  gravCount: number;
  /** Mittlerer z-Winkel (Grad) oder null ohne Schwerkraftdaten. */
  angleMean: number | null;
  /** Größte 5-s-Winkeländerung (Grad) oder null, wenn zu wenige Daten. */
  angleChange: number | null;
  /** Teil eines ≥ 5-minütigen Laufs ohne Winkeländerung ≥ 5°. */
  still: boolean;
}

/** z-Winkel nach van Hees in Grad (−90…90). atan2 vermeidet die Division durch 0. */
export function zAngleDeg(g: readonly [number, number, number]): number {
  return (Math.atan2(g[2], Math.hypot(g[0], g[1])) * 180) / Math.PI;
}

/** Gibt die Samples nach ts sortiert zurück (ohne Kopie, wenn bereits sortiert). */
export function ensureSorted(samples: readonly SampleRecord[]): readonly SampleRecord[] {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].ts < samples[i - 1].ts) {
      return [...samples].sort((a, b) => a.ts - b.ts);
    }
  }
  return samples;
}

/** Erster Index mit ts >= t in einem sortierten Array. */
export function lowerBound(samples: readonly SampleRecord[], t: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Samples mit start <= ts < end aus einem sortierten Array. */
export function sliceSamples(samples: readonly SampleRecord[], start: number, end: number): readonly SampleRecord[] {
  const a = lowerBound(samples, start);
  const b = lowerBound(samples, end);
  return a === 0 && b === samples.length ? samples : samples.slice(a, b);
}

/**
 * Baut ein lückenloses Minutenraster von floor(start/60)·60 bis end (exklusiv).
 * Minuten ohne Daten erscheinen mit hrCount = 0. `samples` müssen sortiert sein.
 * Ohne start/end wird der Bereich der Samples verwendet.
 */
export function buildEpochs(samples: readonly SampleRecord[], start?: number, end?: number): Epoch[] {
  if (samples.length === 0 && (start === undefined || end === undefined)) return [];
  const s0 = start ?? samples[0].ts;
  const e0 = end ?? samples[samples.length - 1].ts + 1;
  const gridStart = Math.floor(s0 / EPOCH_SEC) * EPOCH_SEC;
  const n = Math.max(0, Math.ceil((e0 - gridStart) / EPOCH_SEC));
  if (n === 0) return [];

  const hrSum = new Float64Array(n);
  const hrCount = new Int32Array(n);
  const hrMax = new Float64Array(n);
  const angSum = new Float64Array(n);
  const gravCount = new Int32Array(n);
  const diffMax = new Float64Array(n);
  const diffCount = new Int32Array(n);
  const rr: number[][] = new Array(n);
  for (let i = 0; i < n; i++) rr[i] = [];

  // Streaming-Zustand für die 5-s-Blöcke des z-Winkels.
  let curBlock = Number.NaN;
  let blockSum = 0;
  let blockN = 0;
  let prevBlock = Number.NaN;
  let prevAngle = 0;
  const finalizeBlock = () => {
    if (blockN === 0) return;
    const a = blockSum / blockN;
    if (prevBlock === curBlock - 1) {
      const idx = Math.floor((curBlock * ANGLE_BLOCK_SEC - gridStart) / EPOCH_SEC);
      if (idx >= 0 && idx < n) {
        const d = Math.abs(a - prevAngle);
        if (d > diffMax[idx]) diffMax[idx] = d;
        diffCount[idx]++;
      }
    }
    prevBlock = curBlock;
    prevAngle = a;
  };

  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    if (s.ts < gridStart || s.ts >= e0) continue;
    const idx = Math.floor((s.ts - gridStart) / EPOCH_SEC);
    if (s.hr > 0) {
      hrSum[idx] += s.hr;
      hrCount[idx]++;
      if (s.hr > hrMax[idx]) hrMax[idx] = s.hr;
      if (s.rr.length > 0) {
        const bucket = rr[idx];
        for (let j = 0; j < s.rr.length; j++) bucket.push(s.rr[j]);
      }
    }
    const g = s.grav;
    if (g) {
      const ang = zAngleDeg(g);
      if (Number.isFinite(ang)) {
        angSum[idx] += ang;
        gravCount[idx]++;
        const b = Math.floor(s.ts / ANGLE_BLOCK_SEC);
        if (b !== curBlock) {
          finalizeBlock();
          curBlock = b;
          blockSum = 0;
          blockN = 0;
        }
        blockSum += ang;
        blockN++;
      }
    }
  }
  finalizeBlock();

  // Ruhe: Läufe von ≥ STILL_RUN_MIN Minuten mit kleiner Winkeländerung.
  const low = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    low[i] = diffCount[i] >= MIN_ANGLE_DIFFS && diffMax[i] < STILL_ANGLE_DEG ? 1 : 0;
  }
  const still = new Uint8Array(n);
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && low[i]) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart >= STILL_RUN_MIN) still.fill(1, runStart, i);
      runStart = -1;
    }
  }

  const out: Epoch[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = hrCount[i];
    out[i] = {
      t: gridStart + i * EPOCH_SEC,
      hrMean: c > 0 ? hrSum[i] / c : 0,
      hrCount: c,
      hrMax: hrMax[i],
      rr: rr[i],
      gravCount: gravCount[i],
      angleMean: gravCount[i] > 0 ? angSum[i] / gravCount[i] : null,
      angleChange: diffCount[i] >= MIN_ANGLE_DIFFS ? diffMax[i] : null,
      still: still[i] === 1,
    };
  }
  return out;
}
