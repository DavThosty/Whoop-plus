// Deterministische synthetische Testdaten: eine Nacht mit bekanntem Schlafbeginn
// und -ende, ruhigem Arm, kurzen Wachphasen, RR-Intervallen mit bekannter RMSSD
// und einem Workout. Nur für Tests.

import type { DailySummary, Profile, SampleRecord, SleepPeriod } from '../types';
import { addDays, parseDate, localUnix } from './time';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** Lokale Uhrzeit 'HH:MM' an `date` (+ dayOffset Tage) als Unix-Sekunden. */
export function at(date: string, hhmm: string, dayOffset = 0): number {
  const [y, m, d] = parseDate(date);
  const [hh, mm] = hhmm.split(':').map(Number);
  return localUnix(y, m, d + dayOffset, hh, mm);
}

export const TEST_PROFILE: Profile = { age: 35, weightKg: 75, sex: 'm', maxHr: 190, sleepNeedH: 8 };

export interface ScenarioOptions {
  /** Datum des Aufwachens. */
  date: string;
  seed?: number;
  /** Zubettgehzeit am Vortag (lokal). */
  bedtime?: string;
  /** Aufwachzeit am Tag selbst (lokal). */
  wakeTime?: string;
  /** Wachphasen im Bett: Minuten nach Schlafbeginn und Dauer. */
  wakeEpisodes?: { atMin: number; durMin: number }[];
  /** Kurze Lagewechsel (Minuten nach Schlafbeginn). */
  rollovers?: number[];
  /** Fehlende Datensätze in der Nacht (Minuten nach Schlafbeginn). */
  syncGaps?: { atMin: number; durMin: number }[];
  /** Workout am Tag selbst. */
  workout?: { start: string; durMin: number; hr: number } | null;
  /** Abgelegtes Band am Vorabend. */
  offWrist?: { start: string; durMin: number } | null;
  /** Schwerkraftvektor mitliefern? */
  grav?: boolean;
  sleepHr?: number;
  awakeHr?: number;
  /** Standardabweichung des RR-Rauschens im Schlaf (ms); RMSSD ≈ σ·√2. */
  rrSigma?: number;
  /** Alle N Schläge im Schlaf ein Extraschlag (vorzeitig + kompensatorische Pause); 0 = keine. */
  ectopicEvery?: number;
  /** Datenbereich; Standard Vortag 12:00 bis Folgetag 00:00 (36 h). */
  from?: number;
  to?: number;
}

export interface ScenarioTruth {
  sleepStart: number;
  sleepEnd: number;
  wakeEpisodes: number;
  /** RMSSD aller sauberen Schlag-zu-Schlag-Differenzen im Schlaf (ohne Extraschläge). */
  trueRmssd: number;
  ectopicBeats: number;
  workoutStart: number | null;
  workoutEnd: number | null;
}

type State = 'awake' | 'sleep' | 'wake' | 'workout' | 'off' | 'gap';

export function buildScenario(opts: ScenarioOptions): { samples: SampleRecord[]; truth: ScenarioTruth } {
  const date = opts.date;
  const rand = mulberry32(opts.seed ?? 1);
  const gauss = gaussian(rand);
  const sleepStart = at(date, opts.bedtime ?? '23:00', -1);
  const sleepEnd = at(date, opts.wakeTime ?? '07:00');
  const from = opts.from ?? at(date, '12:00', -1);
  const to = opts.to ?? at(addDays(date, 1), '00:00');
  const grav = opts.grav ?? true;
  const sleepHr = opts.sleepHr ?? 54;
  const awakeHr = opts.awakeHr ?? 74;
  const rrSigma = opts.rrSigma ?? 35;
  const ectopicEvery = opts.ectopicEvery ?? 0;
  const wakes = (opts.wakeEpisodes ?? []).map((w) => [sleepStart + w.atMin * 60, sleepStart + (w.atMin + w.durMin) * 60]);
  const gaps = (opts.syncGaps ?? []).map((w) => [sleepStart + w.atMin * 60, sleepStart + (w.atMin + w.durMin) * 60]);
  const rolls = new Set((opts.rollovers ?? []).map((m) => sleepStart + m * 60 + 20));
  const wo = opts.workout ? [at(date, opts.workout.start), at(date, opts.workout.start) + opts.workout.durMin * 60] : null;
  const off = opts.offWrist ? [at(date, opts.offWrist.start, -1), at(date, opts.offWrist.start, -1) + opts.offWrist.durMin * 60] : null;
  const inR = (t: number, r: number[] | null) => r !== null && t >= r[0] && t < r[1];

  const stateAt = (t: number): State => {
    if (gaps.some((g) => inR(t, g))) return 'gap';
    if (inR(t, off)) return 'off';
    if (inR(t, wo)) return 'workout';
    if (t >= sleepStart && t < sleepEnd) return wakes.some((w) => inR(t, w)) ? 'wake' : 'sleep';
    return 'awake';
  };

  const target = (t: number, s: State): number => {
    switch (s) {
      case 'sleep':
        return sleepHr + 2 * Math.sin((2 * Math.PI * (t - sleepStart)) / 5400);
      case 'wake':
        return sleepHr + 18;
      case 'workout':
        return opts.workout!.hr;
      default:
        return awakeHr + 4 * Math.sin((2 * Math.PI * t) / 10800);
    }
  };

  const samples: SampleRecord[] = [];
  let hrSmooth = awakeHr;
  let nextBeat = from + 0.5; // Zeitpunkt des nächsten Schlags (s)
  let lastHr = awakeHr;
  // Wahrheit für die RMSSD
  let prevNormal: number | null = null;
  let sq = 0;
  let nDiff = 0;
  let ectopicBeats = 0;
  let beatCounter = 0;
  let pendingCompensation = 0;
  // Armwinkel
  let theta = 10;
  let phi = 0;
  let posture = -20;
  const postures = [-20, 15, -35, 25, 0];
  let postureIdx = 0;

  for (let t = from; t < to; t++) {
    const s = stateAt(t);
    const tgt = target(t, s);
    hrSmooth += (tgt - hrSmooth) * (1 - Math.exp(-1 / 30));

    // Herzschläge, die in dieser Sekunde enden
    const rr: number[] = [];
    while (nextBeat < t + 1) {
      const base = 60000 / hrSmooth;
      const sigma = s === 'sleep' ? rrSigma : s === 'workout' ? 5 : 20;
      let interval: number;
      let normal = true;
      if (pendingCompensation > 0) {
        interval = pendingCompensation;
        pendingCompensation = 0;
        normal = false;
      } else if (s === 'sleep' && ectopicEvery > 0 && ++beatCounter % ectopicEvery === 0) {
        interval = 0.6 * base;
        pendingCompensation = 1.4 * base;
        normal = false;
        ectopicBeats += 2;
      } else {
        interval = base + sigma * gauss();
      }
      interval = Math.round(interval);
      nextBeat += interval / 1000;
      if (s === 'sleep' && normal) {
        if (prevNormal !== null) {
          sq += (interval - prevNormal) ** 2;
          nDiff++;
        }
        prevNormal = interval;
      } else {
        prevNormal = null;
      }
      if (interval >= 200 && interval <= 2500) rr.push(interval);
    }

    if (s === 'gap') continue;

    // Armwinkel
    if (s === 'sleep') {
      if (rolls.has(t)) posture = postures[++postureIdx % postures.length];
      theta = posture + 0.2 * gauss();
    } else if (s === 'off') {
      theta = 88;
    } else {
      theta += (s === 'workout' ? 10 : 6) * gauss();
      if (theta > 80) theta = 160 - theta;
      if (theta < -80) theta = -160 - theta;
      phi += 0.2 * gauss();
    }
    const th = (theta * Math.PI) / 180;
    const k = 1.046;
    const g: [number, number, number] = [
      k * Math.cos(th) * Math.cos(phi),
      k * Math.cos(th) * Math.sin(phi),
      k * Math.sin(th),
    ];

    if (s === 'off') {
      samples.push({ ts: t, hr: 0, rr: [], grav: grav ? g : undefined, src: 'history' });
      continue;
    }
    if (rr.length) lastHr = Math.round(60000 / rr[rr.length - 1]);
    const rec: SampleRecord = { ts: t, hr: lastHr, rr, src: 'history' };
    if (grav) rec.grav = g;
    samples.push(rec);
  }

  return {
    samples,
    truth: {
      sleepStart,
      sleepEnd,
      wakeEpisodes: wakes.length,
      trueRmssd: Math.sqrt(sq / Math.max(1, nDiff)),
      ectopicBeats,
      workoutStart: wo ? wo[0] : null,
      workoutEnd: wo ? wo[1] : null,
    },
  };
}

/** Minimaler DailySummary für Baseline-Tests. */
export function makeSummary(date: string, hrv: number | null, rhr: number | null): DailySummary {
  const sleep: SleepPeriod = {
    start: 0,
    end: 8 * 3600,
    asleepMin: 450,
    awakeMin: 30,
    wakeEpisodes: 2,
    efficiency: 0.94,
    restingHr: rhr,
    hrvRmssd: hrv,
    epochs: [],
  };
  return {
    date,
    sleep,
    sleepPerformance: 94,
    recovery: null,
    baselineNights: 0,
    strain: 10,
    trimp: 100,
    zoneMinutes: [0, 0, 0, 0, 0],
    kcal: 2400,
    avgHr: 70,
    maxHr: 150,
    coveredMin: 1400,
    computedAt: 0,
  };
}
