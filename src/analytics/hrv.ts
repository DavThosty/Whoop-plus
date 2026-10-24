// Herzratenvariabilität (HRV) als RMSSD.
//
// 1. Läufe benachbarter Schläge (buildRrSeries)
//    Das Band liefert pro Sekunde 0–4 RR-Intervalle. Zwei RR-Werte gelten nur dann
//    als direkt aufeinanderfolgende Herzschläge, wenn sie im selben Sample stehen
//    oder in zwei Samples, deren Zeitstempel sich um genau 1 s unterscheiden und die
//    beide gültig sind (hr > 0) und beide RR-Werte enthalten. Ein neuer Lauf beginnt
//    bei jeder Sekunde ohne RR-Wert, bei jeder Lücke im Zeitstempel und bei hr = 0.
//    Das ist bewusst konservativ: Eine Sekunde ohne RR kann ein verpasster Schlag
//    sein, und eine Differenz über einen verpassten Schlag hinweg würde die RMSSD
//    stark verfälschen.
//
// 2. Artefaktfilter nach Malik (malikFilter / cleanRr)
//    Ein Intervall wird verworfen, wenn es um mehr als 20 % vom zuletzt akzeptierten
//    Intervall abweicht. Für den ersten Schlag eines Laufs dient der Median der
//    ersten (bis zu) 5 Intervalle als Referenz. Nach 3 Verwerfungen in Folge wird
//    angenommen, dass sich der Rhythmus wirklich geändert hat: das aktuelle
//    Intervall wird akzeptiert und neue Referenz. Sukzessive Differenzen werden nur
//    zwischen zwei unmittelbar benachbarten, beide akzeptierten Intervallen gebildet –
//    Differenzen, die ein verworfenes Intervall berühren, entfallen.
//
// 3. RMSSD = sqrt(mittelwert((RR[i] − RR[i−1])²)).
//
// 4. Nächtliche HRV (nightlyRmssd): Die Differenzen werden 5-Minuten-Fenstern
//    (an der Uhr ausgerichtet) zugeordnet. Ein Fenster zählt mit ≥ 20 sauberen
//    Differenzen. Ergebnis = Median der Fenster-RMSSDs; null bei < 3 gültigen Fenstern.

import type { SampleRecord } from '../types';

export const MALIK_THRESHOLD = 0.2;
export const MALIK_RESET_AFTER = 3;
export const HRV_WINDOW_SEC = 300;
export const HRV_MIN_DIFFS_PER_WINDOW = 20;
export const HRV_MIN_WINDOWS = 3;

/** Ein Lauf direkt benachbarter Herzschläge. */
export interface RrRun {
  /** RR-Intervalle in ms. */
  rr: number[];
  /** Zeitstempel (Unix-Sekunden) des Samples, in dem das jeweilige Intervall stand. */
  ts: number[];
}

export interface HrvWindow {
  /** Fensterbeginn (Unix-Sekunden). */
  t: number;
  /** RMSSD des Fensters in ms. */
  rmssd: number;
  /** Anzahl sauberer sukzessiver Differenzen. */
  diffs: number;
  /** Erfüllt das Fenster die Mindestanzahl Differenzen? */
  valid: boolean;
}

export interface NightlyHrv {
  /** Median der gültigen Fenster-RMSSDs (ms, 1 Nachkommastelle) oder null. */
  rmssd: number | null;
  /** Alle Fenster (auch ungültige) für Diagramme, zeitlich sortiert. */
  windows: HrvWindow[];
  validWindows: number;
  totalBeats: number;
  rejectedBeats: number;
}

/** Zerlegt die RR-Daten in Läufe direkt benachbarter Schläge (Regel siehe oben). */
export function buildRrSeries(samples: readonly SampleRecord[]): RrRun[] {
  const runs: RrRun[] = [];
  let cur: RrRun | null = null;
  let prevTs = Number.NaN;
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    if (s.hr <= 0 || s.rr.length === 0) {
      cur = null;
      prevTs = Number.NaN;
      continue;
    }
    if (cur === null || s.ts !== prevTs + 1) {
      cur = { rr: [], ts: [] };
      runs.push(cur);
    }
    for (let j = 0; j < s.rr.length; j++) {
      cur.rr.push(s.rr[j]);
      cur.ts.push(s.ts);
    }
    prevTs = s.ts;
  }
  return runs;
}

function median(values: number[]): number {
  const a = [...values].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Malik-Filter: true = Intervall akzeptiert. */
export function malikFilter(rr: readonly number[], threshold = MALIK_THRESHOLD): boolean[] {
  const ok: boolean[] = new Array(rr.length).fill(false);
  if (rr.length === 0) return ok;
  let ref = median(rr.slice(0, Math.min(5, rr.length)));
  let rejectedInRow = 0;
  for (let i = 0; i < rr.length; i++) {
    const x = rr[i];
    if (Math.abs(x - ref) <= threshold * ref) {
      ok[i] = true;
      ref = x;
      rejectedInRow = 0;
    } else {
      rejectedInRow++;
      if (rejectedInRow >= MALIK_RESET_AFTER) {
        ok[i] = true;
        ref = x;
        rejectedInRow = 0;
      }
    }
  }
  return ok;
}

/** Zerlegt einen Lauf in Segmente aus unmittelbar benachbarten, akzeptierten Intervallen. */
export function cleanRr(rr: readonly number[], threshold = MALIK_THRESHOLD): number[][] {
  const ok = malikFilter(rr, threshold);
  const segs: number[][] = [];
  let cur: number[] | null = null;
  for (let i = 0; i < rr.length; i++) {
    if (ok[i]) {
      if (!cur) {
        cur = [];
        segs.push(cur);
      }
      cur.push(rr[i]);
    } else {
      cur = null;
    }
  }
  return segs;
}

/** Sukzessive Differenzen innerhalb jedes Segments. */
export function successiveDiffs(segments: readonly (readonly number[])[]): number[] {
  const d: number[] = [];
  for (const seg of segments) for (let i = 1; i < seg.length; i++) d.push(seg[i] - seg[i - 1]);
  return d;
}

/** RMSSD aus sukzessiven Differenzen (ms) oder null bei leerer Liste. */
export function rmssdFromDiffs(diffs: readonly number[]): number | null {
  if (diffs.length === 0) return null;
  let s = 0;
  for (const d of diffs) s += d * d;
  return Math.sqrt(s / diffs.length);
}

/** RMSSD eines Laufs benachbarter Intervalle (ohne Filter); null bei < 2 Intervallen. */
export function rmssd(run: readonly number[]): number | null {
  return rmssdFromDiffs(successiveDiffs([run]));
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Nächtliche RMSSD nach der oben beschriebenen Methode. `samples` sortiert nach ts. */
export function nightlyRmssd(samples: readonly SampleRecord[]): NightlyHrv {
  const runs = buildRrSeries(samples);
  const acc = new Map<number, { sq: number; n: number }>();
  let totalBeats = 0;
  let rejectedBeats = 0;
  for (const run of runs) {
    const ok = malikFilter(run.rr);
    totalBeats += run.rr.length;
    for (let i = 0; i < run.rr.length; i++) {
      if (!ok[i]) {
        rejectedBeats++;
        continue;
      }
      if (i === 0 || !ok[i - 1]) continue;
      const d = run.rr[i] - run.rr[i - 1];
      const w = Math.floor(run.ts[i] / HRV_WINDOW_SEC) * HRV_WINDOW_SEC;
      let e = acc.get(w);
      if (!e) {
        e = { sq: 0, n: 0 };
        acc.set(w, e);
      }
      e.sq += d * d;
      e.n++;
    }
  }
  const windows: HrvWindow[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, e]) => ({
      t,
      rmssd: round1(Math.sqrt(e.sq / e.n)),
      diffs: e.n,
      valid: e.n >= HRV_MIN_DIFFS_PER_WINDOW,
    }));
  const valid = windows.filter((w) => w.valid).map((w) => Math.sqrt(acc.get(w.t)!.sq / w.diffs));
  return {
    rmssd: valid.length >= HRV_MIN_WINDOWS ? round1(median(valid)) : null,
    windows,
    validWindows: valid.length,
    totalBeats,
    rejectedBeats,
  };
}
