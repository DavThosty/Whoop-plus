import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveHr } from '../types';

// --- Mocks: Speicher und App-Controller ---
const kv = new Map<string, unknown>();
const db = vi.hoisted(() => ({
  putWorkout: vi.fn(async (_w: unknown) => {}),
  samples: [] as { ts: number; hr: number; rr: number[]; src: 'live' }[],
}));
vi.mock('../store/db', () => ({
  getDays: vi.fn(async () => []),
  getKv: vi.fn(async (k: string) => kv.get(k)),
  setKv: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
  getSamples: vi.fn(async (from: number, to: number) => db.samples.filter((s) => s.ts >= from && s.ts < to)),
  putWorkout: db.putWorkout,
}));

const fake = vi.hoisted(() => {
  type L = (s: unknown) => void;
  const state = {
    conn: 'connected', liveOn: false, profile: { age: 35, weightKg: 75, sex: 'm', maxHr: 190, sleepNeedH: 8 },
  } as { conn: string; liveOn: boolean; profile: unknown };
  const listeners = new Set<L>();
  const live = new Set<(l: LiveHr) => void>();
  return {
    state,
    setLiveImpl: async (on: boolean) => { state.liveOn = on; },
    setLiveCalls: 0,
    haptic: vi.fn(async () => {}),
    keepAwake: vi.fn(async () => {}),
    listeners,
    live,
    emit() { for (const l of listeners) l(state); },
  };
});
vi.mock('./controller', () => ({
  app: {
    get state() { return fake.state; },
    setLive: async (on: boolean) => { fake.setLiveCalls++; await fake.setLiveImpl(on); },
    haptic: fake.haptic,
    keepAwake: fake.keepAwake,
    subscribe: (fn: (s: unknown) => void) => { fake.listeners.add(fn); return () => fake.listeners.delete(fn); },
    subscribeLive: (fn: (l: LiveHr) => void) => { fake.live.add(fn); return () => fake.live.delete(fn); },
  },
}));

import { CHECKPOINT_KEY, WorkoutSession } from './workout';

const T0 = Date.UTC(2026, 2, 10, 8, 0, 0);
const sendHr = (hr: number) => { for (const fn of fake.live) fn({ ts: Math.floor(Date.now() / 1000), hr, rr: [], wearing: true }); };
/** n Sekunden mit Puls `hr` simulieren (1 Messung pro Sekunde). */
async function run(seconds: number, hr: number) {
  for (let i = 0; i < seconds; i++) {
    sendHr(hr);
    await vi.advanceTimersByTimeAsync(1000);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  kv.clear();
  db.samples = [];
  db.putWorkout.mockClear();
  fake.haptic.mockClear();
  fake.state.conn = 'connected';
  fake.state.liveOn = false;
  fake.setLiveCalls = 0;
  fake.setLiveImpl = async (on: boolean) => { fake.state.liveOn = on; };
  fake.listeners.clear();
  fake.live.clear();
});
afterEach(() => vi.useRealTimers());

describe('Workout-Sitzung', () => {
  it('doppeltes Beenden speichert genau einmal mit korrekter Dauer', async () => {
    const w = new WorkoutSession();
    await w.start();
    expect(w.state.phase).toBe('active');
    await run(60, 157);
    const a = w.stop();
    expect(w.state.phase).toBe('stopping'); // synchron gesetzt
    w.pause(); // wirkungslos
    const b = w.stop();
    await Promise.all([a, b]);
    expect(db.putWorkout).toHaveBeenCalledTimes(1);
    expect(w.state.phase).toBe('summary');
    expect(w.state.summary!.durationS).toBe(60);
    expect(w.state.summary!.zoneSeconds[2]).toBeGreaterThanOrEqual(58);
    expect(kv.get(CHECKPOINT_KEY)).toBeNull();
    expect(fake.state.liveOn).toBe(false); // vorheriger Zustand wiederhergestellt
  });

  it('Pausen zählen nicht zur Dauer', async () => {
    const w = new WorkoutSession();
    await w.start();
    await run(30, 157);
    w.pause();
    await vi.advanceTimersByTimeAsync(120_000);
    w.resume();
    await run(30, 157);
    await w.stop();
    expect(w.state.summary!.durationS).toBe(60);
  });

  it('speichert Zwischenstände und kann ein unterbrochenes Workout abschließen', async () => {
    const w = new WorkoutSession();
    await w.start();
    // Live-Daten landen (wie im Controller) als Samples im Speicher.
    for (let i = 0; i < 95; i++) {
      db.samples.push({ ts: Math.floor(Date.now() / 1000), hr: 157, rr: [], src: 'live' });
      sendHr(157);
      await vi.advanceTimersByTimeAsync(1000);
    }
    const cp = kv.get(CHECKPOINT_KEY) as { startTs: number; savedAt: number };
    expect(cp).toBeTruthy();
    expect(cp.savedAt - cp.startTs).toBeGreaterThanOrEqual(89); // alle 30 s gespeichert

    // „App beendet“: neue Sitzung findet den Zwischenstand.
    const w2 = new WorkoutSession();
    await w2.checkRecovery();
    expect(w2.state.recovery).not.toBeNull();
    await w2.finishRecovered();
    expect(db.putWorkout).toHaveBeenCalledTimes(1);
    const rec = w2.state.summary!;
    expect(rec.durationS).toBe(Math.round(cp.savedAt - cp.startTs));
    expect(rec.strain).toBeGreaterThan(0);
    expect(rec.zoneSeconds[2]).toBeGreaterThan(80);
    expect(kv.get(CHECKPOINT_KEY)).toBeNull();
  });

  it('Fortsetzen: Zeit seit dem letzten Speichern zählt als Pause', async () => {
    kv.set(CHECKPOINT_KEY, { v: 1, startTs: T0 / 1000 - 600, pauses: [], pausedAt: null, savedAt: T0 / 1000 - 300, rhr: 60, maxHr: 190, prevLive: false });
    for (let t = T0 / 1000 - 600; t < T0 / 1000 - 300; t++) db.samples.push({ ts: t, hr: 157, rr: [], src: 'live' });
    const w = new WorkoutSession();
    await w.checkRecovery();
    expect(await w.resumeRecovered()).toBe(true);
    expect(w.state.phase).toBe('active');
    expect(w.state.elapsedS).toBe(300);
    await run(10, 157);
    await w.stop();
    expect(w.state.summary!.durationS).toBe(310);
    expect(w.state.summary!.zoneSeconds[2]).toBeGreaterThanOrEqual(305);
  });

  it('Live-Puls: kein Dauerfeuer bei Fehlern, Backoff und nur beim Übergang zu verbunden', async () => {
    fake.setLiveImpl = async () => { /* schlägt fehl: liveOn bleibt false */ };
    const w = new WorkoutSession();
    await w.start();
    expect(fake.setLiveCalls).toBe(1);
    for (let i = 0; i < 5; i++) fake.emit(); // Zustandsänderungen ohne Übergang
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.setLiveCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000); // 10 s Backoff vorbei
    expect(fake.setLiveCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000); // jetzt 30 s Backoff
    expect(fake.setLiveCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(fake.setLiveCalls).toBe(3);
    // Verbindung weg und wieder da → sofortiger Versuch, der jetzt klappt
    fake.state.conn = 'disconnected';
    fake.emit();
    expect(w.state.linkLost).toBe(true);
    fake.setLiveImpl = async (on: boolean) => { fake.state.liveOn = on; };
    fake.state.conn = 'connected';
    fake.emit();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.setLiveCalls).toBe(4);
    expect(fake.state.liveOn).toBe(true);
    expect(w.state.linkLost).toBe(false);
    await w.stop();
  });
});
