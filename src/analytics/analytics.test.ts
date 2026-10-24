// Zeitzone vor jeder Date-Verwendung festlegen (Tests enthalten Sommerzeit-Tage).
(globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import type { DailySummary, SampleRecord } from '../types';
import {
  addDays,
  buildEpochs,
  buildRrSeries,
  cleanRr,
  computeDay,
  computeDayDetailed,
  computeRecovery,
  dayBounds,
  detectSleep,
  detectSleepDetailed,
  EXPLANATIONS,
  hrZone,
  keytelKcalPerMin,
  liveDayStats,
  localDateString,
  malikFilter,
  nightlyRmssd,
  rmssd,
  sleepWindow,
  strainFromTrimp,
  trimpFromEpochs,
  zAngleDeg,
} from './index';
import { at, buildScenario, gaussian, makeSummary, mulberry32, TEST_PROFILE } from './test-fixtures';

const MIN = 60;
const H = 3600;

function assertNoNaN(value: unknown, path = 'root'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
  }
}

describe('time', () => {
  it('formats local dates around midnight', () => {
    const t = at('2026-06-10', '00:30');
    expect(localDateString(t)).toBe('2026-06-10');
    expect(localDateString(t - H)).toBe('2026-06-09');
  });

  it('handles DST transitions in dayBounds and sleepWindow', () => {
    const autumn = dayBounds('2026-10-25');
    expect((autumn.end - autumn.start) / H).toBe(25);
    const spring = dayBounds('2026-03-29');
    expect((spring.end - spring.start) / H).toBe(23);
    const normal = dayBounds('2026-06-10');
    expect((normal.end - normal.start) / H).toBe(24);
    expect(localDateString(autumn.start)).toBe('2026-10-25');
    expect(localDateString(autumn.end)).toBe('2026-10-26');

    const sw = sleepWindow('2026-03-29');
    expect((sw.end - sw.start) / H).toBe(19); // 18:00 CET → 14:00 CEST
    expect(new Date(sw.start * 1000).getHours()).toBe(18);
    expect(new Date(sw.end * 1000).getHours()).toBe(14);
    expect(localDateString(sw.start)).toBe('2026-03-28');
    expect((sleepWindow('2026-10-25').end - sleepWindow('2026-10-25').start) / H).toBe(21);
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('epochs', () => {
  it('aggregates HR, RR and z-angle per minute', () => {
    const t0 = 1_800_000_000 - (1_800_000_000 % 60);
    const s: SampleRecord[] = [];
    for (let i = 0; i < 600; i++) {
      s.push({ ts: t0 + i, hr: i < 60 ? 60 : 0, rr: i < 60 ? [1000] : [], grav: [0, 0.5, 0.5], src: 'history' });
    }
    const e = buildEpochs(s, t0, t0 + 600);
    expect(e).toHaveLength(10);
    expect(e[0].hrMean).toBe(60);
    expect(e[0].hrCount).toBe(60);
    expect(e[0].rr).toHaveLength(60);
    expect(e[1].hrCount).toBe(0);
    expect(e[0].angleMean).toBeCloseTo(45, 5);
    expect(e.every((x) => x.still)).toBe(true);
    expect(zAngleDeg([0, 0, 1])).toBeCloseTo(90);
    expect(zAngleDeg([0, 0, 0])).toBe(0);
  });
});

describe('hrv', () => {
  it('splits RR runs at empty seconds, ts gaps and hr=0', () => {
    const mk = (ts: number, hr: number, rr: number[]): SampleRecord => ({ ts, hr, rr, src: 'history' });
    const runs = buildRrSeries([
      mk(100, 60, [1000]),
      mk(101, 60, [990, 1010]),
      mk(102, 60, []), // keine RR → neuer Lauf
      mk(103, 60, [1000]),
      mk(105, 60, [1000]), // Lücke → neuer Lauf
      mk(106, 0, [1000]), // hr = 0 → ungültig
      mk(107, 60, [1000]),
    ]);
    expect(runs.map((r) => r.rr)).toEqual([[1000, 990, 1010], [1000], [1000], [1000]]);
  });

  it('Malik filter removes injected ectopic beats', () => {
    const g = gaussian(mulberry32(7));
    const rr: number[] = [];
    const ectopic = new Set<number>();
    for (let i = 0; i < 400; i++) {
      if (i % 37 === 20) {
        rr.push(600, 1400);
        ectopic.add(rr.length - 2);
        ectopic.add(rr.length - 1);
        i++;
      } else rr.push(Math.round(1000 + 25 * g()));
    }
    const ok = malikFilter(rr);
    for (const idx of ectopic) expect(ok[idx]).toBe(false);
    const rejected = ok.filter((x) => !x).length;
    expect(rejected).toBe(ectopic.size);
    const clean = cleanRr(rr);
    const raw = rmssd(rr)!;
    const cleaned = Math.sqrt(
      clean.flatMap((seg) => seg.slice(1).map((v, i) => (v - seg[i]) ** 2)).reduce((a, b) => a + b, 0) /
        clean.reduce((a, seg) => a + seg.length - 1, 0),
    );
    expect(raw).toBeGreaterThan(100);
    expect(cleaned).toBeGreaterThan(25 * Math.SQRT2 * 0.85);
    expect(cleaned).toBeLessThan(25 * Math.SQRT2 * 1.15);
  });

  it('nightly RMSSD matches the generated value within 10 %, also with ectopics', () => {
    for (const ectopicEvery of [0, 50]) {
      const { samples, truth } = buildScenario({ date: '2026-06-10', seed: 3, ectopicEvery });
      const night = samples.filter((s) => s.ts >= truth.sleepStart + 10 * MIN && s.ts < truth.sleepEnd - 10 * MIN);
      const res = nightlyRmssd(night);
      expect(res.rmssd).not.toBeNull();
      expect(Math.abs(res.rmssd! - truth.trueRmssd) / truth.trueRmssd).toBeLessThan(0.1);
      expect(res.validWindows).toBeGreaterThan(80);
      if (ectopicEvery) expect(res.rejectedBeats).toBeGreaterThanOrEqual(truth.ectopicBeats * 0.9);
    }
  });

  it('returns null with fewer than 3 valid windows', () => {
    const { samples, truth } = buildScenario({ date: '2026-06-10', seed: 3 });
    const short = samples.filter((s) => s.ts >= truth.sleepStart + H && s.ts < truth.sleepStart + H + 10 * MIN);
    expect(nightlyRmssd(short).rmssd).toBeNull();
  });
});

describe('sleep', () => {
  const wakeEpisodes = [
    { atMin: 150, durMin: 6 },
    { atMin: 300, durMin: 10 },
  ];

  it('detects start/end within ±10 min and wake episodes', () => {
    const { samples, truth } = buildScenario({
      date: '2026-06-10',
      seed: 11,
      wakeEpisodes,
      rollovers: [60, 220, 400],
      offWrist: { start: '19:00', durMin: 60 },
    });
    const w = sleepWindow('2026-06-10');
    const det = detectSleepDetailed(samples, w.start, w.end);
    const p = det.period!;
    expect(p).not.toBeNull();
    expect(det.mode).toBe('accel');
    expect(Math.abs(p.start - truth.sleepStart)).toBeLessThanOrEqual(10 * MIN);
    expect(Math.abs(p.end - truth.sleepEnd)).toBeLessThanOrEqual(10 * MIN);
    expect(p.wakeEpisodes).toBe(2);
    expect(p.awakeMin).toBeGreaterThanOrEqual(16);
    expect(p.awakeMin).toBeLessThan(30);
    expect(p.asleepMin + p.awakeMin).toBe(p.epochs.length);
    expect(p.efficiency).toBeGreaterThan(0.9);
    expect(p.efficiency).toBeLessThan(1);
    expect(p.restingHr).toBeGreaterThan(50);
    expect(p.restingHr).toBeLessThan(55);
    expect(Math.abs(p.hrvRmssd! - truth.trueRmssd) / truth.trueRmssd).toBeLessThan(0.1);
  });

  it('falls back to HR only when gravity is missing', () => {
    const { samples, truth } = buildScenario({ date: '2026-06-10', seed: 5, grav: false, wakeEpisodes });
    const w = sleepWindow('2026-06-10');
    const det = detectSleepDetailed(samples, w.start, w.end);
    expect(det.mode).toBe('hr-only');
    const p = det.period!;
    expect(p).not.toBeNull();
    expect(Math.abs(p.start - truth.sleepStart)).toBeLessThanOrEqual(10 * MIN);
    expect(Math.abs(p.end - truth.sleepEnd)).toBeLessThanOrEqual(10 * MIN);
    expect(p.wakeEpisodes).toBe(2);
    expect(p.hrvRmssd).not.toBeNull();
  });

  it('merges across short data gaps and counts them as awake', () => {
    const { samples, truth } = buildScenario({ date: '2026-06-10', seed: 9, syncGaps: [{ atMin: 200, durMin: 8 }] });
    const w = sleepWindow('2026-06-10');
    const p = detectSleep(samples, w.start, w.end)!;
    expect(Math.abs(p.start - truth.sleepStart)).toBeLessThanOrEqual(10 * MIN);
    expect(Math.abs(p.end - truth.sleepEnd)).toBeLessThanOrEqual(10 * MIN);
    expect(p.awakeMin).toBeGreaterThanOrEqual(8);
  });

  it('returns null for rest shorter than 3 h and for an off-wrist strap', () => {
    // nur 2 h Schlaf (23:00–01:00)
    const { samples } = buildScenario({ date: '2026-06-10', seed: 2, bedtime: '23:00', wakeTime: '01:00' });
    const w = sleepWindow('2026-06-10');
    expect(detectSleep(samples, w.start, w.end)).toBeNull();

    const off: SampleRecord[] = [];
    for (let t = w.start; t < w.end; t++) off.push({ ts: t, hr: 0, rr: [], grav: [0, 0, 1.04], src: 'history' });
    expect(detectSleep(off, w.start, w.end)).toBeNull();
    expect(detectSleep([], w.start, w.end)).toBeNull();
  });
});

describe('strain', () => {
  it('maps %HRR to Edwards zones', () => {
    expect(hrZone(100, 60, 160)).toBe(0); // 40 %
    expect(hrZone(110, 60, 160)).toBe(1); // 50 %
    expect(hrZone(135, 60, 160)).toBe(3); // 75 %
    expect(hrZone(150, 60, 160)).toBe(5); // 90 %
    expect(hrZone(0, 60, 160)).toBe(0);
  });

  it('computes TRIMP and strain from epochs', () => {
    const epochs = Array.from({ length: 60 }, () => ({ hrMean: 135, hrCount: 60 }));
    const r = trimpFromEpochs(epochs, 60, 160);
    expect(r.trimp).toBe(180);
    expect(r.zoneMinutes).toEqual([0, 0, 60, 0, 0]);
    expect(strainFromTrimp(180)).toBeCloseTo((21 * Math.log(181)) / Math.log(7201), 1);
    expect(strainFromTrimp(0)).toBe(0);
    expect(strainFromTrimp(7200)).toBe(21);
    expect(strainFromTrimp(1e9)).toBe(21);
    // halb abgedeckte Minuten zählen halb
    expect(trimpFromEpochs([{ hrMean: 135, hrCount: 30 }], 60, 160).trimp).toBe(1.5);
  });

  it('is monotonic in workout intensity and in range; zone minutes match', () => {
    const strains: number[] = [];
    let base: DailySummary | null = null;
    for (const hr of [0, 130, 150, 170]) {
      const { samples } = buildScenario({
        date: '2026-06-10',
        seed: 4,
        workout: hr ? { start: '17:00', durMin: 45, hr } : null,
      });
      const d = computeDay('2026-06-10', samples, TEST_PROFILE, []);
      if (!hr) base = d;
      strains.push(d.strain);
      expect(d.strain).toBeGreaterThanOrEqual(0);
      expect(d.strain).toBeLessThanOrEqual(21);
    }
    for (let i = 1; i < strains.length; i++) expect(strains[i]).toBeGreaterThan(strains[i - 1]);
    expect(base!.zoneMinutes.reduce((a, b) => a + b, 0)).toBeLessThan(5);
  });

  it('puts a steady workout into the expected zone', () => {
    // RHR ≈ 52 aus dem Schlaf, MaxHR 190 → Zone 3 (70–80 %) Mitte ≈ 52 + 0.75·138 ≈ 155
    const { samples } = buildScenario({ date: '2026-06-10', seed: 4, workout: { start: '17:00', durMin: 40, hr: 155 } });
    const det = computeDayDetailed('2026-06-10', samples, TEST_PROFILE, []);
    expect(det.rhrSource).toBe('tonight');
    const zm = det.summary.zoneMinutes;
    expect(Math.abs(zm[2] - 40)).toBeLessThanOrEqual(3);
    expect(zm[3] + zm[4]).toBeLessThan(1);
    expect(det.summary.maxHr).toBeGreaterThan(150);
  });
});

describe('calories', () => {
  it('uses Keytel, never negative', () => {
    expect(keytelKcalPerMin(150, TEST_PROFILE)).toBeCloseTo(
      (-55.0969 + 0.6309 * 150 + 0.1988 * 75 + 0.2017 * 35) / 4.184,
      6,
    );
    expect(keytelKcalPerMin(20, TEST_PROFILE)).toBe(0);
    expect(keytelKcalPerMin(20, { ...TEST_PROFILE, sex: 'w' })).toBe(0);
  });

  it('counts missing minutes as BMR', () => {
    const d = computeDay('2026-06-10', [], TEST_PROFILE, []);
    expect(d.kcal).toBe(Math.round(22 * 75));
    expect(d.sleep).toBeNull();
    expect(d.strain).toBe(0);
    expect(d.coveredMin).toBe(0);
    expect(d.avgHr).toBeNull();
    assertNoNaN(d);
  });
});

describe('recovery', () => {
  const nights = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeSummary(addDays('2026-06-09', -i), 50 * Math.exp(0.1 * Math.sin(i * 1.7)), 55 + 1.5 * Math.cos(i * 2.3)),
    );

  it('is null during calibration (< 4 nights)', () => {
    const r = computeRecovery({ hrv: 60, rhr: 52, sleepPerformance: 95 }, nights(3));
    expect(r.recovery).toBeNull();
    expect(r.baselineNights).toBe(3);
    expect(r.reason).toBe('calibrating');
    const r2 = computeRecovery({ hrv: 60, rhr: 52, sleepPerformance: 95 }, [...nights(3), makeSummary('2026-05-01', null, 55)]);
    expect(r2.recovery).toBeNull();
  });

  it('is higher when HRV is above baseline and stays within 1–99', () => {
    const prev = nights(14);
    const hi = computeRecovery({ hrv: 70, rhr: 55, sleepPerformance: 90 }, prev);
    const mid = computeRecovery({ hrv: 50, rhr: 55, sleepPerformance: 90 }, prev);
    const lo = computeRecovery({ hrv: 35, rhr: 55, sleepPerformance: 90 }, prev);
    expect(hi.recovery!).toBeGreaterThan(mid.recovery!);
    expect(mid.recovery!).toBeGreaterThan(lo.recovery!);
    expect(hi.components!.zHrv).toBeGreaterThan(0);
    for (const r of [hi, mid, lo]) {
      expect(r.recovery!).toBeGreaterThanOrEqual(1);
      expect(r.recovery!).toBeLessThanOrEqual(99);
    }
    expect(computeRecovery({ hrv: 500, rhr: 30, sleepPerformance: 100 }, prev).recovery).toBe(99);
    expect(computeRecovery({ hrv: 5, rhr: 90, sleepPerformance: 10 }, prev).recovery).toBe(1);
    // genau Baseline → ≈ 57 %
    const exact = computeRecovery({ hrv: 50, rhr: 55, sleepPerformance: 85 }, Array.from({ length: 5 }, (_, i) => makeSummary(addDays('2026-06-09', -i), 50, 55)));
    expect(exact.recovery).toBe(57);
    expect(computeRecovery({ hrv: 50, rhr: 55, sleepPerformance: 85 }, nights(40)).baselineNights).toBe(30);
  });

  it('computeDay uses only previous days for the baseline', () => {
    const { samples } = buildScenario({ date: '2026-06-10', seed: 21 });
    const prev = nights(10);
    const withToday = [...prev, makeSummary('2026-06-10', 10, 90)];
    const a = computeDay('2026-06-10', samples, TEST_PROFILE, prev);
    const b = computeDay('2026-06-10', samples, TEST_PROFILE, withToday);
    expect(a.recovery).not.toBeNull();
    expect(a.recovery).toBe(b.recovery);
    expect(a.baselineNights).toBe(10);
  });
});

describe('daily', () => {
  it('produces a complete DailySummary without NaN', () => {
    const { samples, truth } = buildScenario({
      date: '2026-06-10',
      seed: 13,
      wakeEpisodes: [{ atMin: 200, durMin: 5 }],
      workout: { start: '17:00', durMin: 45, hr: 150 },
    });
    const d = computeDay('2026-06-10', samples, TEST_PROFILE, []);
    assertNoNaN(d);
    expect(d.date).toBe('2026-06-10');
    expect(d.sleep).not.toBeNull();
    expect(Math.abs(d.sleep!.end - truth.sleepEnd)).toBeLessThanOrEqual(10 * MIN);
    expect(d.sleepPerformance).toBeGreaterThan(90);
    expect(d.sleepPerformance).toBeLessThanOrEqual(100);
    expect(d.recovery).toBeNull();
    expect(d.baselineNights).toBe(0);
    expect(d.coveredMin).toBe(1440);
    expect(d.kcal).toBeGreaterThan(22 * 75);
    expect(d.kcal).toBeLessThan(5000);
    expect(d.avgHr).toBeGreaterThan(65);
    expect(d.computedAt).toBeGreaterThan(0);
  });

  it('handles the DST day (25 h, sleep across the change)', () => {
    const date = '2026-10-25';
    const { samples, truth } = buildScenario({ date, seed: 17, bedtime: '23:00', wakeTime: '07:00' });
    expect((truth.sleepEnd - truth.sleepStart) / H).toBe(9); // 8 lokale Stunden + 1 h Umstellung
    const d = computeDay(date, samples, TEST_PROFILE, []);
    assertNoNaN(d);
    expect(Math.abs(d.sleep!.start - truth.sleepStart)).toBeLessThanOrEqual(10 * MIN);
    expect(Math.abs(d.sleep!.end - truth.sleepEnd)).toBeLessThanOrEqual(10 * MIN);
    expect(d.coveredMin).toBe(1500);
    expect(d.sleepPerformance).toBe(100);

    const spring = '2026-03-29';
    const s2 = buildScenario({ date: spring, seed: 18 });
    const d2 = computeDay(spring, s2.samples, TEST_PROFILE, []);
    expect(d2.coveredMin).toBe(1380);
    expect(Math.abs(d2.sleep!.end - s2.truth.sleepEnd)).toBeLessThanOrEqual(10 * MIN);
    expect(d2.sleep!.end - d2.sleep!.start).toBeLessThan(7.2 * H);
  });

  it('excludes sleep minutes from strain', () => {
    // Max-Puls 60: Ruhepuls ≈ 50, Zone 1 ab ≈ 55 bpm. Wachpuls tagsüber 44–52 (keine Zonen),
    // die beiden Wachphasen im Schlaf (≈ 70 bpm) lägen in Zone 5 – sie gehören aber zur
    // Schlafperiode und dürfen nicht zählen.
    const profile = { ...TEST_PROFILE, maxHr: 60 };
    const { samples } = buildScenario({
      date: '2026-06-10',
      seed: 23,
      awakeHr: 48,
      sleepHr: 52,
      wakeEpisodes: [
        { atMin: 150, durMin: 10 },
        { atMin: 300, durMin: 10 },
      ],
    });
    const det = computeDayDetailed('2026-06-10', samples, profile, []);
    const d = det.summary;
    expect(d.sleep).not.toBeNull();
    expect(d.sleep!.wakeEpisodes).toBeGreaterThanOrEqual(2);
    expect(d.zoneMinutes.reduce((a, b) => a + b, 0)).toBeLessThan(3);
    const db = dayBounds('2026-06-10');
    const all = buildEpochs(samples.filter((s) => s.ts >= db.start && s.ts < db.end), db.start, db.end);
    const naive = trimpFromEpochs(all, det.rhrUsed, profile.maxHr);
    expect(naive.zoneMinutes.reduce((a, b) => a + b, 0)).toBeGreaterThan(15);
  });

  it('liveDayStats reports today so far', () => {
    const { samples } = buildScenario({ date: '2026-06-10', seed: 4, workout: { start: '17:00', durMin: 45, hr: 160 } });
    const now = at('2026-06-10', '18:00');
    const live = liveDayStats(samples, TEST_PROFILE, 52, { nowSec: now });
    expect(live.date).toBe('2026-06-10');
    expect(live.elapsedMin).toBe(18 * 60);
    expect(live.strain).toBeGreaterThan(5);
    expect(live.zoneMinutes.reduce((a, b) => a + b, 0)).toBeGreaterThan(40);
    expect(live.kcal).toBeGreaterThan((22 * 75 * 18) / 24);
    assertNoNaN(live);
    const early = liveDayStats(samples, TEST_PROFILE, null, { nowSec: at('2026-06-10', '16:00') });
    expect(early.strain).toBeLessThan(live.strain);
  });

  it('runs computeDay over 36 h of per-second samples in < 1.5 s', () => {
    const { samples } = buildScenario({ date: '2026-06-10', seed: 99, workout: { start: '17:00', durMin: 60, hr: 150 } });
    expect(samples.length).toBeGreaterThan(36 * H - 10);
    const t0 = performance.now();
    const d = computeDay('2026-06-10', samples, TEST_PROFILE, []);
    const ms = performance.now() - t0;
    expect(d.sleep).not.toBeNull();
    expect(ms).toBeLessThan(1500);
  });
});

describe('explain', () => {
  it('has German texts for all topics', () => {
    for (const k of ['recovery', 'strain', 'sleep', 'hrv', 'restingHr', 'calories'] as const) {
      expect(EXPLANATIONS[k].paragraphs.length).toBeGreaterThan(0);
      expect(EXPLANATIONS[k].formulas.length).toBeGreaterThan(0);
      expect(EXPLANATIONS[k].paragraphs.join(' ')).not.toMatch(/undefined|NaN/);
      expect(EXPLANATIONS[k].formulas.join(' ')).not.toMatch(/undefined|NaN/);
    }
    expect(EXPLANATIONS.strain.formula).toContain('ln(7201)');
  });
});
