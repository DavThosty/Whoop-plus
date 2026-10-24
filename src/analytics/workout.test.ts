import { describe, expect, it } from 'vitest';
import { computeWorkout, WorkoutAccumulator, workoutZone, ZoneBuzzer } from './workout';
import { strainFromTrimp } from './strain';
import { keytelKcalPerMin } from './calories';
import { TEST_PROFILE } from './test-fixtures';

const P = { rhr: 60, maxHr: 190, profile: TEST_PROFILE };
// %HRR: (hr − 60) / 130. Zone 3 (70–80 %) z. B. 157 bpm (74,6 %).

describe('Workout-Auswertung', () => {
  it('10 Minuten konstant in Zone 3 → TRIMP 30', () => {
    const samples = Array.from({ length: 600 }, (_, i) => ({ ts: 1000 + i, hr: 157 }));
    const r = computeWorkout(samples, P);
    expect(r.coveredS).toBe(600);
    expect(r.zoneSeconds).toEqual([0, 0, 600, 0, 0]);
    expect(r.trimp).toBe(30);
    expect(r.strain).toBe(strainFromTrimp(30));
    expect(r.avgHr).toBe(157);
    expect(r.maxHr).toBe(157);
    // kcal = 10 min Keytel
    expect(r.kcal).toBe(Math.round(keytelKcalPerMin(157, TEST_PROFILE) * 10));
  });

  it('Lücken über 5 s zählen nur 5 s', () => {
    const r = computeWorkout([{ ts: 0, hr: 157 }, { ts: 100, hr: 157 }], P);
    // 0 → 100: 5 s, letzte Messung bis +1 s
    expect(r.coveredS).toBe(6);
  });

  it('Unter Zone 1 keine Punkte, aber Grundumsatz', () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ ts: i, hr: 80 }));
    const r = computeWorkout(samples, P);
    expect(r.trimp).toBe(0);
    expect(r.strain).toBe(0);
    expect(r.zoneSeconds).toEqual([0, 0, 0, 0, 0]);
    expect(r.kcal).toBeGreaterThanOrEqual(1);
  });

  it('ohne Profil keine kcal', () => {
    const r = computeWorkout([{ ts: 0, hr: 150 }, { ts: 1, hr: 150 }], { ...P, profile: null });
    expect(r.kcal).toBe(0);
  });

  it('5-Sekunden-Punkte sind Mittelwerte', () => {
    const acc = new WorkoutAccumulator(P);
    [100, 110, 120, 130, 140, 150].forEach((hr, i) => acc.add(10 + i, hr));
    expect(acc.points()).toEqual([{ ts: 10, hr: 120 }, { ts: 15, hr: 150 }]);
  });

  it('Pause: resetGap zählt die Lücke nicht', () => {
    const acc = new WorkoutAccumulator(P);
    acc.add(0, 157);
    acc.add(1, 157);
    acc.resetGap();
    acc.add(4, 157);
    acc.finish(5);
    expect(acc.stats().coveredS).toBe(2);
  });

  it('stats(now) bezieht die offene Messung ein', () => {
    const acc = new WorkoutAccumulator(P);
    acc.add(0, 157);
    expect(acc.stats().coveredS).toBe(0);
    expect(acc.stats(3).coveredS).toBe(3);
    expect(acc.stats(30).coveredS).toBe(5);
  });

  it('ungültige Pulswerte beenden die Messung', () => {
    const acc = new WorkoutAccumulator(P);
    acc.add(0, 157);
    acc.add(2, 0);
    acc.add(10, 157);
    acc.finish(11);
    expect(acc.stats().coveredS).toBe(3);
  });

  it('workoutZone', () => {
    expect(workoutZone(null, 60, 190)).toBe(0);
    expect(workoutZone(90, 60, 190)).toBe(0);
    expect(workoutZone(130, 60, 190)).toBe(1);
    expect(workoutZone(185, 60, 190)).toBe(5);
  });
});

describe('ZoneBuzzer', () => {
  it('erste Zone ohne Impuls, Wechsel erst nach 10 s Stabilität', () => {
    const b = new ZoneBuzzer();
    expect(b.update(2, 0)).toBeNull();
    expect(b.update(2, 10_000)).toBeNull(); // Startzone gemerkt
    expect(b.update(3, 11_000)).toBeNull();
    expect(b.update(3, 20_000)).toBeNull();
    expect(b.update(3, 21_000)).toBe(3);
    expect(b.update(3, 40_000)).toBeNull();
  });

  it('kurze Ausreißer lösen nichts aus', () => {
    const b = new ZoneBuzzer();
    b.update(2, 0);
    b.update(2, 10_000);
    expect(b.update(4, 12_000)).toBeNull();
    expect(b.update(2, 15_000)).toBeNull();
    expect(b.update(2, 40_000)).toBeNull();
  });

  it('höchstens ein Impuls pro 30 s', () => {
    const b = new ZoneBuzzer();
    b.update(1, 0);
    b.update(1, 10_000);
    b.update(2, 10_000);
    expect(b.update(2, 20_000)).toBe(2);
    b.update(3, 21_000);
    expect(b.update(3, 31_000)).toBeNull(); // erst 11 s seit letztem Impuls
    expect(b.update(3, 49_000)).toBeNull();
    expect(b.update(3, 50_000)).toBe(3);
  });

  it('noteBuzz sperrt Folgeimpulse', () => {
    const b = new ZoneBuzzer();
    b.update(1, 0);
    b.update(1, 10_000);
    b.noteBuzz(10_000);
    b.update(2, 11_000);
    expect(b.update(2, 21_000)).toBeNull();
    expect(b.update(2, 40_000)).toBe(2);
  });
});
