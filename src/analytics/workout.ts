// Workout-Auswertung (live und nachträglich).
//
// Strain: Edwards-TRIMP wie für den Tag (strain.ts), aber sekundengenau:
//   TRIMP = Σ (Sekunden in Zone z · z) / 60, Strain = strainFromTrimp(TRIMP).
// Jede Pulsmessung zählt für die Zeit bis zur nächsten Messung, höchstens MAX_GAP_SEC
// (Lücken – z. B. Verbindungsabbrüche – zählen nicht). Pausen werden vom Aufrufer
// ausgelassen (keine Samples während der Pause; die Lücke wird über `resetGap()` beendet).
// kcal: wie calories.ts – über der Aktivschwelle Keytel (mindestens Grundumsatz),
// sonst Grundumsatz; pro Sekunde anteilig.

import type { Profile } from '../types';
import { activeThresholdHr, bmrKcalPerMin, keytelKcalPerMin } from './calories';
import { hrZone, strainFromTrimp } from './strain';

export const MAX_GAP_SEC = 5;
export const POINT_BUCKET_SEC = 5;
/** Zone muss so lange stabil sein, bevor das Band vibriert. */
export const ZONE_STABLE_MS = 10_000;
/** Höchstens ein Zonen-Vibrieren in diesem Abstand. */
export const ZONE_BUZZ_MIN_INTERVAL_MS = 30_000;

export type ZoneSeconds = [number, number, number, number, number];

export interface WorkoutRecord {
  /** = start (Unix-Sekunden), Primärschlüssel. */
  id: number;
  start: number;
  end: number;
  /** Aktive Dauer ohne Pausen (s). */
  durationS: number;
  strain: number;
  trimp: number;
  kcal: number;
  avgHr: number | null;
  maxHr: number | null;
  /** Sekunden in Zone 1–5 (Index 0 = Zone 1). */
  zoneSeconds: ZoneSeconds;
  /** 5-Sekunden-Mittelwerte des Pulses. */
  hr: { ts: number; hr: number }[];
  /** Verwendeter Ruhe- und Maximalpuls (zur Nachvollziehbarkeit). */
  rhr?: number;
  maxHrRef?: number;
}

export interface WorkoutParams {
  rhr: number;
  maxHr: number;
  profile: Profile | null;
}

export interface WorkoutStats {
  /** Gezählte Sekunden mit Puls. */
  coveredS: number;
  trimp: number;
  strain: number;
  kcal: number;
  avgHr: number | null;
  maxHr: number | null;
  zoneSeconds: ZoneSeconds;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Laufende Auswertung: Samples nacheinander hinzufügen. */
export class WorkoutAccumulator {
  private last: { ts: number; hr: number } | null = null;
  private trimp = 0;
  private kcal = 0;
  private hrSum = 0;
  private hrWeight = 0;
  private max = 0;
  private covered = 0;
  private readonly zones: ZoneSeconds = [0, 0, 0, 0, 0];
  private readonly bucketMap = new Map<number, { sum: number; n: number }>();

  constructor(readonly params: WorkoutParams) {}

  /** Puls-Sample (Unix-Sekunden, bpm). Werte ≤ 0 beenden nur die laufende Messung. */
  add(ts: number, hr: number): void {
    if (!(hr > 0) || !Number.isFinite(ts)) {
      this.closeLast(ts);
      this.last = null;
      return;
    }
    if (this.last && ts <= this.last.ts) {
      // Doppelte oder rückwärtige Zeitstempel: nur den Wert aktualisieren.
      this.last = { ts: this.last.ts, hr };
    } else {
      this.closeLast(ts);
      this.last = { ts, hr };
    }
    if (hr > this.max) this.max = hr;
    const b = Math.floor(ts / POINT_BUCKET_SEC) * POINT_BUCKET_SEC;
    const e = this.bucketMap.get(b);
    if (e) {
      e.sum += hr;
      e.n++;
    } else this.bucketMap.set(b, { sum: hr, n: 1 });
  }

  /** Beendet die laufende Messung (z. B. bei Pause), ohne die Lücke zu zählen. */
  resetGap(): void {
    this.last = null;
  }

  /** Schließt die offene Messung bis `untilTs` ab (für die letzte Messung vor dem Ende). */
  finish(untilTs: number): void {
    this.closeLast(untilTs);
    this.last = null;
  }

  private closeLast(ts: number): void {
    const l = this.last;
    if (!l) return;
    const dt = Math.min(MAX_GAP_SEC, Math.max(0, ts - l.ts));
    if (dt <= 0) return;
    this.accumulate(l.hr, dt);
  }

  private accumulate(hr: number, dt: number): void {
    const { rhr, maxHr, profile } = this.params;
    const z = hrZone(hr, rhr, maxHr);
    if (z > 0) {
      this.zones[z - 1] += dt;
      this.trimp += (z * dt) / 60;
    }
    if (profile) {
      const bmr = bmrKcalPerMin(profile);
      const perMin = hr > activeThresholdHr(rhr, maxHr) ? Math.max(bmr, keytelKcalPerMin(hr, profile)) : bmr;
      this.kcal += (perMin * dt) / 60;
    }
    this.hrSum += hr * dt;
    this.hrWeight += dt;
    this.covered += dt;
  }

  /** Aktueller Stand inklusive der offenen Messung bis `nowTs` (falls angegeben). */
  stats(nowTs?: number): WorkoutStats {
    let trimp = this.trimp;
    let kcal = this.kcal;
    let hrSum = this.hrSum;
    let hrWeight = this.hrWeight;
    let covered = this.covered;
    const zones = [...this.zones] as ZoneSeconds;
    const l = this.last;
    if (l && nowTs != null) {
      const dt = Math.min(MAX_GAP_SEC, Math.max(0, nowTs - l.ts));
      if (dt > 0) {
        const { rhr, maxHr, profile } = this.params;
        const z = hrZone(l.hr, rhr, maxHr);
        if (z > 0) {
          zones[z - 1] += dt;
          trimp += (z * dt) / 60;
        }
        if (profile) {
          const bmr = bmrKcalPerMin(profile);
          kcal += ((l.hr > activeThresholdHr(rhr, maxHr) ? Math.max(bmr, keytelKcalPerMin(l.hr, profile)) : bmr) * dt) / 60;
        }
        hrSum += l.hr * dt;
        hrWeight += dt;
        covered += dt;
      }
    }
    return {
      coveredS: Math.round(covered),
      trimp: round1(trimp),
      strain: strainFromTrimp(trimp),
      kcal: Math.round(kcal),
      avgHr: hrWeight > 0 ? Math.round(hrSum / hrWeight) : null,
      maxHr: this.max > 0 ? Math.round(this.max) : null,
      zoneSeconds: zones.map((s) => Math.round(s)) as ZoneSeconds,
    };
  }

  /** 5-Sekunden-Mittelwerte, aufsteigend. */
  points(): { ts: number; hr: number }[] {
    return [...this.bucketMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, e]) => ({ ts, hr: Math.round((e.sum / e.n) * 10) / 10 }));
  }
}

/** Komplette Auswertung einer Sample-Liste (sortiert oder nicht). */
export function computeWorkout(
  samples: readonly { ts: number; hr: number }[],
  params: WorkoutParams,
): WorkoutStats & { points: { ts: number; hr: number }[] } {
  const acc = new WorkoutAccumulator(params);
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  for (const s of sorted) acc.add(s.ts, s.hr);
  const last = sorted[sorted.length - 1];
  if (last) acc.finish(last.ts + 1);
  return { ...acc.stats(), points: acc.points() };
}

/** Anzeige-Zone 0–5 für einen Puls (0 = unter Zone 1). */
export function workoutZone(hr: number | null | undefined, rhr: number, maxHr: number): 0 | 1 | 2 | 3 | 4 | 5 {
  return hr && hr > 0 ? hrZone(hr, rhr, maxHr) : 0;
}

/**
 * Entscheidet, wann das Band bei einem Zonenwechsel vibrieren soll:
 * Die neue Zone muss ZONE_STABLE_MS stabil sein, zwischen zwei Impulsen liegen
 * mindestens ZONE_BUZZ_MIN_INTERVAL_MS. Die Startzone löst keinen Impuls aus.
 */
export class ZoneBuzzer {
  private announced: number | null = null;
  private candidate: number | null = null;
  private candidateSince = 0;
  private lastBuzz = -Infinity;

  constructor(
    private readonly stableMs = ZONE_STABLE_MS,
    private readonly minIntervalMs = ZONE_BUZZ_MIN_INTERVAL_MS,
  ) {}

  /** Liefert die Zone, für die jetzt vibriert werden soll, sonst null. */
  update(zone: number, nowMs: number): number | null {
    if (zone !== this.candidate) {
      this.candidate = zone;
      this.candidateSince = nowMs;
    }
    if (nowMs - this.candidateSince < this.stableMs) return null;
    if (this.announced === null) {
      // Erste stabile Zone wird nur gemerkt.
      this.announced = zone;
      return null;
    }
    if (zone === this.announced) return null;
    if (nowMs - this.lastBuzz < this.minIntervalMs) return null;
    this.announced = zone;
    this.lastBuzz = nowMs;
    return zone;
  }

  /** Nach einem manuellen Impuls (Start/Stopp) die Sperrzeit neu beginnen. */
  noteBuzz(nowMs: number): void {
    this.lastBuzz = nowMs;
  }
}
