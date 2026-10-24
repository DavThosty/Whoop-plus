// Deterministischer Generator für synthetische Physiologie (1 Hz): Puls, R-R-Intervalle, Schwerkraftvektor.
// Tagesablauf (lokale Zeit): Schlaf ~23–7 Uhr (Puls 50–58, ruhig, wenige Lagewechsel, 2–3 kurze
// Wachphasen), tagsüber Alltag (65–95, häufige Bewegung), ein ~45-min-Training am späten Nachmittag (130–170).

export interface SynthSample {
  ts: number;
  hr: number;
  rr: number[];
  grav: [number, number, number];
  /** Diagnose: Phase, aus der der Wert stammt. */
  phase: 'sleep' | 'wake' | 'day' | 'workout';
}

export interface SynthOptions {
  seed?: number;
  /** Feste UTC-Abweichung in Minuten; Standard: lokale Zeitzone der Laufzeitumgebung (inkl. Sommerzeit). */
  utcOffsetMin?: number;
}

/** Kleiner, schneller, seedbarer PRNG (mulberry32). */
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

function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

interface NightPlan {
  /** Einschlafen, Sekunden nach Mitternacht des Abendtages (≈ 23:00). */
  sleepStart: number;
  /** Aufwachen, Sekunden nach Mitternacht des Folgetages (≈ 07:00). */
  wake: number;
  baseHr: number;
  /** Wachphasen relativ zum Einschlafen: [Start, Dauer] in s. */
  wakeEpisodes: [number, number][];
  /** Zeitpunkte von Lagewechseln relativ zum Einschlafen. */
  positionChanges: number[];
}

interface DayPlan {
  workoutStart: number; // Sekunden nach Mitternacht
  workoutDur: number;
  workoutPeak: number;
  baseHr: number;
}

const DAY = 86400;

export class PhysiologySynth {
  private ts: number;
  private readonly seed: number;
  private readonly fixedOffset?: number;
  private readonly rnd: () => number;
  private hr: number;
  private nextBeat: number; // absolute Zeit (s, Gleitkomma) des nächsten Herzschlags
  private grav: [number, number, number];
  private poseTarget: [number, number, number];
  private nextPoseChange = 0;
  private nights = new Map<number, NightPlan>();
  private days = new Map<number, DayPlan>();
  private lastPositionIdx = -1;

  constructor(startTs: number, opts: SynthOptions = {}) {
    this.ts = Math.floor(startTs);
    this.seed = (opts.seed ?? 1) >>> 0;
    this.fixedOffset = opts.utcOffsetMin;
    this.rnd = mulberry32(this.seed ^ 0x9e3779b9 ^ this.ts);
    this.hr = 70;
    this.nextBeat = this.ts + this.rnd();
    this.grav = [0, 0, 1];
    this.poseTarget = [0, 0, 1];
  }

  /** Nächste Sekunde erzeugen. */
  next(): SynthSample {
    const ts = this.ts++;
    const { phase, target, hrvMs, breathS, motion } = this.state(ts);

    // Puls folgt dem Ziel träge (Ornstein-Uhlenbeck-artig).
    const k = phase === 'workout' ? 0.05 : 0.02;
    this.hr += (target - this.hr) * k + gauss(this.rnd) * (phase === 'sleep' ? 0.25 : 0.6);
    this.hr = clamp(this.hr, 40, 190);

    // Herzschläge dieser Sekunde: RR um 60000/HR, mit respiratorischer Sinusarrhythmie + Rauschen.
    const rr: number[] = [];
    let guard = 0;
    while (this.nextBeat < ts + 1 && guard++ < 6) {
      const mean = 60000 / this.hr;
      const rsa = hrvMs * Math.sin((2 * Math.PI * this.nextBeat) / breathS);
      const ms = Math.round(clamp(mean + rsa + gauss(this.rnd) * hrvMs * 0.6, 280, 2000));
      if (this.nextBeat >= ts && rr.length < 4) rr.push(ms);
      this.nextBeat += ms / 1000;
    }
    if (this.nextBeat < ts + 1) this.nextBeat = ts + 1; // nie hinterherhinken

    // Schwerkraft: Haltung (Ziel) + Bewegungsrauschen.
    this.updatePose(ts, phase);
    const a = 0.15;
    for (let i = 0; i < 3; i++) {
      this.grav[i] = this.grav[i]! + (this.poseTarget[i]! - this.grav[i]!) * a + gauss(this.rnd) * motion;
    }
    const n = Math.hypot(...this.grav) || 1;
    const scale = 1.046 / n; // reale Bänder lesen ~4,6 % zu hoch
    const grav: [number, number, number] = [
      round4(this.grav[0] * scale),
      round4(this.grav[1] * scale),
      round4(this.grav[2] * scale),
    ];

    return { ts, hr: Math.round(this.hr), rr, grav, phase };
  }

  private offsetSec(ts: number): number {
    if (this.fixedOffset !== undefined) return this.fixedOffset * 60;
    return -new Date(ts * 1000).getTimezoneOffset() * 60;
  }

  private state(ts: number): {
    phase: SynthSample['phase'];
    target: number;
    hrvMs: number;
    breathS: number;
    motion: number;
  } {
    const local = ts + this.offsetSec(ts);
    const day = Math.floor(local / DAY);
    const sod = local - day * DAY;

    // Schlaf: Nacht `day` (abends) oder Nacht `day-1` (morgens).
    const tonight = this.night(day);
    const lastNight = this.night(day - 1);
    let sleepRel: number | null = null;
    let plan: NightPlan | null = null;
    if (sod >= tonight.sleepStart) {
      plan = tonight;
      sleepRel = sod - tonight.sleepStart;
    } else if (sod < lastNight.wake) {
      plan = lastNight;
      sleepRel = sod + DAY - lastNight.sleepStart;
    }
    if (plan && sleepRel !== null) {
      const awake = plan.wakeEpisodes.some(([s, d]) => sleepRel! >= s && sleepRel! < s + d);
      if (awake) return { phase: 'wake', target: plan.baseHr + 14, hrvMs: 30, breathS: 4, motion: 0.02 };
      // Tiefster Puls im ersten Nachtdrittel, leichter Anstieg gegen Morgen.
      const total = plan.wake + DAY - plan.sleepStart;
      const x = sleepRel / total;
      const target = plan.baseHr + 1 - 2 * Math.cos(2 * Math.PI * (x - 0.15)) + 1.5 * x;
      return { phase: 'sleep', target, hrvMs: 55, breathS: 4.8, motion: 0.0015 };
    }

    const dp = this.dayPlan(day);
    if (sod >= dp.workoutStart && sod < dp.workoutStart + dp.workoutDur) {
      const t = sod - dp.workoutStart;
      const ramp = Math.min(1, t / 300, (dp.workoutDur - t) / 300);
      const intervals = 8 * Math.sin((2 * Math.PI * t) / 480);
      const target = dp.baseHr + (dp.workoutPeak + intervals - dp.baseHr) * Math.max(0, ramp);
      return { phase: 'workout', target, hrvMs: 6, breathS: 2.2, motion: 0.12 };
    }
    // Alltag: langsame Schwankungen + gelegentliche Aktivitätsspitzen.
    const slow = 8 * Math.sin((2 * Math.PI * sod) / 5400 + day) + 5 * Math.sin((2 * Math.PI * sod) / 1300);
    const bump = Math.sin(sod / 97 + day * 3) > 0.93 ? 12 : 0;
    const target = clamp(dp.baseHr + slow + bump, 63, 96);
    return { phase: 'day', target, hrvMs: 28, breathS: 3.6, motion: 0.03 };
  }

  private night(day: number): NightPlan {
    let p = this.nights.get(day);
    if (p) return p;
    const r = mulberry32(this.seed * 7919 + day * 104729 + 17);
    const sleepStart = 23 * 3600 + Math.round((r() - 0.5) * 3600);
    const wake = 7 * 3600 + Math.round((r() - 0.5) * 3600);
    const total = wake + DAY - sleepStart;
    const nWake = 2 + (r() < 0.5 ? 1 : 0);
    const wakeEpisodes: [number, number][] = [];
    for (let i = 0; i < nWake; i++) {
      wakeEpisodes.push([Math.round(total * (0.15 + 0.75 * r())), 180 + Math.round(r() * 420)]);
    }
    const positionChanges: number[] = [];
    const nPos = 4 + Math.floor(r() * 5);
    for (let i = 0; i < nPos; i++) positionChanges.push(Math.round(total * r()));
    positionChanges.sort((a, b) => a - b);
    p = { sleepStart, wake, baseHr: 51 + r() * 3, wakeEpisodes, positionChanges };
    this.nights.set(day, p);
    if (this.nights.size > 8) this.nights.delete(this.nights.keys().next().value!);
    return p;
  }

  private dayPlan(day: number): DayPlan {
    let p = this.days.get(day);
    if (p) return p;
    const r = mulberry32(this.seed * 6007 + day * 15485863 + 3);
    p = {
      workoutStart: Math.round((16.5 + r() * 2) * 3600),
      workoutDur: Math.round((40 + r() * 10) * 60),
      workoutPeak: 145 + r() * 17,
      baseHr: 72 + r() * 8,
    };
    this.days.set(day, p);
    if (this.days.size > 8) this.days.delete(this.days.keys().next().value!);
    return p;
  }

  private updatePose(ts: number, phase: SynthSample['phase']): void {
    if (phase === 'sleep' || phase === 'wake') {
      // Lagewechsel nur zu den geplanten Zeitpunkten (bzw. in Wachphasen).
      const local = ts + this.offsetSec(ts);
      const day = Math.floor(local / DAY);
      const sod = local - day * DAY;
      const plan = sod >= this.night(day).sleepStart ? this.night(day) : this.night(day - 1);
      const rel = sod >= plan.sleepStart ? sod - plan.sleepStart : sod + DAY - plan.sleepStart;
      const idx = plan.positionChanges.filter((t) => t <= rel).length;
      if (idx !== this.lastPositionIdx || (phase === 'wake' && this.rnd() < 0.01)) {
        this.lastPositionIdx = idx;
        const poses: [number, number, number][] = [
          [0.05, 0.1, 0.99],
          [0.95, 0.1, 0.25],
          [-0.9, 0.2, 0.35],
          [0.1, -0.2, -0.97],
          [0.3, 0.9, 0.2],
        ];
        this.poseTarget = poses[(idx * 3 + Math.floor(this.rnd() * 2)) % poses.length]!;
      }
      return;
    }
    this.lastPositionIdx = -1;
    if (ts >= this.nextPoseChange) {
      const v: [number, number, number] = [gauss(this.rnd), gauss(this.rnd), gauss(this.rnd) + 0.6];
      const n = Math.hypot(...v) || 1;
      this.poseTarget = [v[0] / n, v[1] / n, v[2] / n];
      const mean = phase === 'workout' ? 4 : 25;
      this.nextPoseChange = ts + 2 + Math.floor(this.rnd() * mean * 2);
    }
  }
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** Bequemlichkeitsfunktion: `count` Sekunden ab `startTs`. */
export function generate(startTs: number, count: number, opts: SynthOptions = {}): SynthSample[] {
  const g = new PhysiologySynth(startTs, opts);
  const out: SynthSample[] = [];
  for (let i = 0; i < count; i++) out.push(g.next());
  return out;
}
