// Zeitzone vor jeder Date-Verwendung festlegen.
(globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import { levelForRecovery, median, recommendDay, type RecentNight } from './recommend';
import { at } from './test-fixtures';

const nights = (wakes: string[], awake = 30): RecentNight[] =>
  wakes.map((w, i) => ({ end: at('2026-03-10', w, -i), awakeMin: awake }));

describe('Tagesempfehlung', () => {
  it('Stufen nach Recovery', () => {
    expect(levelForRecovery(80)).toBe('high');
    expect(levelForRecovery(67)).toBe('high');
    expect(levelForRecovery(66)).toBe('moderate');
    expect(levelForRecovery(34)).toBe('moderate');
    expect(levelForRecovery(33)).toBe('low');
    expect(levelForRecovery(null)).toBe('calibration');
  });

  it('gute Recovery und guter Schlaf → 14–18', () => {
    const r = recommendDay({ recovery: 80, sleepPerformance: 92, sleepNeedH: 8, recentNights: [] });
    expect(r.level).toBe('high');
    expect(r.strainRange).toEqual([14, 18]);
    expect(r.sleepAdjusted).toBe(false);
    expect(r.title).toBe('Gut erholt – heute darf es intensiv werden.');
    expect(r.note).toBeNull();
  });

  it('moderat und niedrig', () => {
    expect(recommendDay({ recovery: 50, sleepPerformance: 85, sleepNeedH: 8, recentNights: [] }).strainRange).toEqual([10, 14]);
    const low = recommendDay({ recovery: 20, sleepPerformance: 85, sleepNeedH: 8, recentNights: [] });
    expect(low.level).toBe('low');
    expect(low.strainRange).toEqual([0, 10]);
  });

  it('schlechter Schlaf stuft eine Stufe herunter', () => {
    const a = recommendDay({ recovery: 80, sleepPerformance: 60, sleepNeedH: 8, recentNights: [] });
    expect(a.baseLevel).toBe('high');
    expect(a.level).toBe('moderate');
    expect(a.strainRange).toEqual([10, 14]);
    expect(a.sleepAdjusted).toBe(true);
    expect(a.text).toMatch(/60 %/);
    const b = recommendDay({ recovery: 50, sleepPerformance: 69, sleepNeedH: 8, recentNights: [] });
    expect(b.level).toBe('low');
    // Niedrigste Stufe bleibt
    const c = recommendDay({ recovery: 10, sleepPerformance: 40, sleepNeedH: 8, recentNights: [] });
    expect(c.level).toBe('low');
    expect(c.sleepAdjusted).toBe(false);
    // Genau 70 % ist kein schlechter Schlaf
    expect(recommendDay({ recovery: 80, sleepPerformance: 70, sleepNeedH: 8, recentNights: [] }).level).toBe('high');
  });

  it('Kalibrierung: neutral 8–12, bei kurzer Nacht 4–8, mit Hinweis', () => {
    const r = recommendDay({ recovery: null, sleepPerformance: 90, sleepNeedH: 8, recentNights: [], baselineNights: 2 });
    expect(r.level).toBe('calibration');
    expect(r.strainRange).toEqual([8, 12]);
    expect(r.note).toMatch(/2\/4/);
    expect(r.text).toMatch(/90 %/);
    const p = recommendDay({ recovery: null, sleepPerformance: 50, sleepNeedH: 8, recentNights: [] });
    expect(p.strainRange).toEqual([4, 8]);
    expect(p.sleepAdjusted).toBe(true);
    const n = recommendDay({ recovery: null, sleepPerformance: null, sleepNeedH: 8, recentNights: [] });
    expect(n.strainRange).toEqual([8, 12]);
  });

  it('Schlafenszeit ohne Verlauf: 07:00 − Bedarf', () => {
    const r = recommendDay({ recovery: 70, sleepPerformance: 90, sleepNeedH: 8, recentNights: [] });
    expect(r.bedtime.wakeFromHistory).toBe(false);
    expect(r.bedtime.wakeMinutesOfDay).toBe(420);
    expect([r.bedtime.hour, r.bedtime.minute]).toEqual([23, 0]);
  });

  it('Schlafenszeit aus Median der Aufwachzeiten und Wachminuten, auf 5 min gerundet', () => {
    // Median der Aufwachzeit 06:40, Wachzeit 27 min, Bedarf 7,5 h → 06:40 − 7:30 − 0:27 = 22:43 → 22:45
    const ns = nights(['06:30', '06:40', '07:10', '06:35', '06:50'], 27);
    const r = recommendDay({ recovery: 70, sleepPerformance: 90, sleepNeedH: 7.5, recentNights: ns });
    expect(r.bedtime.wakeFromHistory).toBe(true);
    expect(r.bedtime.wakeMinutesOfDay).toBe(6 * 60 + 40);
    expect(r.bedtime.awakeMin).toBe(27);
    expect(r.bedtime.minutesOfDay).toBe(22 * 60 + 45);
    expect([r.bedtime.hour, r.bedtime.minute]).toEqual([22, 45]);
  });

  it('nur die 7 neuesten Nächte zählen', () => {
    const recent = nights(['06:00', '06:00', '06:00', '06:00', '06:00', '06:00', '06:00'], 0);
    const old = [{ end: at('2026-02-01', '09:00'), awakeMin: 0 }, { end: at('2026-02-02', '09:00'), awakeMin: 0 }];
    const r = recommendDay({ recovery: 70, sleepPerformance: 90, sleepNeedH: 8, recentNights: [...old, ...recent] });
    expect(r.bedtime.wakeMinutesOfDay).toBe(360);
    expect(r.bedtime.minutesOfDay).toBe(22 * 60);
  });

  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
