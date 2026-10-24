import { describe, expect, it, vi } from 'vitest';
import {
  ExpiryWatch, formatExpiry, planReminders, REMINDER_BODY, REMINDER_IDS, REMINDER_TITLE, shouldShowBanner, type ExpiryDeps, type NotifPermission,
} from './expiry';

const H = 3600_000;
const NOW = new Date(2026, 9, 24, 12, 0).getTime();
const EXP = new Date(2026, 9, 30, 21, 14).getTime();

function setup(opts: { expiry?: string | null; perm?: NotifPermission } = {}) {
  const store = new Map<string, string>();
  let expiry: string | null = opts.expiry === undefined ? new Date(EXP).toISOString() : opts.expiry;
  let perm: NotifPermission = opts.perm ?? 'granted';
  let now = NOW;
  const deps: ExpiryDeps = {
    now: () => now,
    today: () => '2026-10-24',
    readExpiry: vi.fn(async () => expiry),
    checkPermission: vi.fn(async () => perm),
    requestPermission: vi.fn(async (): Promise<NotifPermission> => (perm = 'granted')),
    schedule: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    log: vi.fn(),
  };
  return {
    deps, store,
    setExpiry: (iso: string | null) => (expiry = iso),
    setPerm: (p: NotifPermission) => (perm = p),
    setNow: (t: number) => (now = t),
  };
}

describe('Ablauf: Planung', () => {
  it('erinnert 24 h und 3 h vorher, nur in der Zukunft', () => {
    const r = planReminders(EXP, NOW);
    expect(r.map((x) => x.id)).toEqual([...REMINDER_IDS]);
    expect(r.map((x) => x.at.getTime())).toEqual([EXP - 24 * H, EXP - 3 * H]);
    expect(r[0].title).toBe(REMINDER_TITLE);
    expect(r[0].body).toBe(REMINDER_BODY);
    expect(planReminders(EXP, EXP - 10 * H).map((x) => x.id)).toEqual([REMINDER_IDS[1]]);
    expect(planReminders(EXP, EXP - 2 * H)).toEqual([]);
  });

  it('formatiert das Datum deutsch', () => {
    expect(formatExpiry(EXP)).toBe('Fr., 30. Okt., 21:14');
  });

  it('Banner unter 48 h, für den Tag ausblendbar', () => {
    expect(shouldShowBanner(EXP, EXP - 49 * H, null, 'x')).toBe(false);
    expect(shouldShowBanner(EXP, EXP - 47 * H, null, '2026-10-29')).toBe(true);
    expect(shouldShowBanner(EXP, EXP - 47 * H, '2026-10-29', '2026-10-29')).toBe(false);
    expect(shouldShowBanner(EXP, EXP - 20 * H, '2026-10-29', '2026-10-30')).toBe(true);
    expect(shouldShowBanner(null, NOW, null, 'x')).toBe(false);
  });
});

describe('ExpiryWatch', () => {
  it('liest das Datum, plant Erinnerungen einmal und plant nach dem Verlängern neu', async () => {
    const t = setup();
    const w = new ExpiryWatch(t.deps);
    await w.refresh();
    expect(w.state.expiresAt).toBe(EXP);
    expect(t.deps.cancel).toHaveBeenCalledWith([...REMINDER_IDS]);
    expect(t.deps.schedule).toHaveBeenCalledTimes(1);
    const list = (t.deps.schedule as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(list.map((r: { at: Date }) => r.at.getTime())).toEqual([EXP - 24 * H, EXP - 3 * H]);

    // Gleiches Datum (z. B. Rückkehr in die App): nichts neu planen.
    await w.refresh();
    expect(t.deps.schedule).toHaveBeenCalledTimes(1);

    // Nach dem Aktualisieren in SideStore: neues Datum → alte Erinnerungen weg, neue geplant.
    const exp2 = EXP + 7 * 24 * H;
    t.setExpiry(new Date(exp2).toISOString());
    await w.refresh();
    expect(t.deps.cancel).toHaveBeenCalledTimes(2);
    expect(t.deps.schedule).toHaveBeenCalledTimes(2);
    expect((t.deps.schedule as ReturnType<typeof vi.fn>).mock.calls[1][0][0].at.getTime()).toBe(exp2 - 24 * H);
  });

  it('ohne Profil (Simulator/unsigniert) oder bei Fehlern: kein Datum, nichts geplant', async () => {
    const t = setup({ expiry: null });
    const w = new ExpiryWatch(t.deps);
    await w.refresh();
    expect(w.state.expiresAt).toBeNull();
    expect(t.deps.schedule).not.toHaveBeenCalled();

    (t.deps.readExpiry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('not implemented'));
    await w.refresh();
    expect(w.state.expiresAt).toBeNull();
  });

  it('ohne Erlaubnis nichts planen; Erklär-Sheet nach dem ersten Verbinden, dann iOS-Abfrage und Planung', async () => {
    const t = setup({ perm: 'prompt' });
    const w = new ExpiryWatch(t.deps);
    await w.refresh();
    expect(t.deps.schedule).not.toHaveBeenCalled();
    expect(w.state.askPermission).toBe(false); // nicht beim Start fragen

    await w.onConnected();
    expect(w.state.askPermission).toBe(true);
    expect(t.deps.requestPermission).not.toHaveBeenCalled();

    await w.acceptPermission();
    expect(w.state.askPermission).toBe(false);
    expect(t.deps.requestPermission).toHaveBeenCalledTimes(1);
    expect(t.deps.schedule).toHaveBeenCalledTimes(1);

    // Nur einmal fragen.
    await w.onConnected();
    expect(w.state.askPermission).toBe(false);
  });

  it('„Nein“ im Erklär-Sheet: nicht erneut fragen', async () => {
    const t = setup({ perm: 'prompt' });
    const w = new ExpiryWatch(t.deps);
    await w.onConnected();
    w.declinePermission();
    await new ExpiryWatch(t.deps).onConnected();
    expect(t.deps.requestPermission).not.toHaveBeenCalled();
  });

  it('bereits entschieden (granted/denied): kein Sheet', async () => {
    for (const perm of ['granted', 'denied'] as const) {
      const t = setup({ perm });
      const w = new ExpiryWatch(t.deps);
      await w.onConnected();
      expect(w.state.askPermission).toBe(false);
    }
  });

  it('Banner für heute ausblenden bleibt gespeichert', () => {
    const t = setup();
    const w = new ExpiryWatch(t.deps);
    w.dismissBanner();
    expect(w.state.bannerDismissed).toBe('2026-10-24');
    expect(new ExpiryWatch(t.deps).state.bannerDismissed).toBe('2026-10-24');
  });
});
