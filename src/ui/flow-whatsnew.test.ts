import { beforeEach, describe, expect, it, vi } from 'vitest';

// „Was ist neu“ im Zusammenspiel mit den anderen Vollbildern (Speicher, App-Zustand und Workout sind Stubs).
const h = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  app: {
    state: { conn: 'disconnected', postSync: false, computing: false, profile: null as unknown, lastSync: null as number | null, stats: { oldest: null, newest: null, count: 0 } as unknown },
    listeners: [] as ((s: unknown) => void)[],
    subscribe(fn: (s: unknown) => void) {
      this.listeners.push(fn);
      return () => {};
    },
  },
  workout: { state: { phase: 'idle', recovery: null as unknown } },
}));
vi.mock('../store/db', () => ({
  getKv: vi.fn(async (k: string) => h.kv.get(k)),
  setKv: vi.fn(async (k: string, v: unknown) => void h.kv.set(k, v)),
  getDay: vi.fn(async () => undefined),
}));
vi.mock('./controller', () => ({ app: h.app }));
vi.mock('./workout', () => ({ workout: h.workout }));
vi.mock('../version', () => ({ APP_VERSION: '0.1.12', APP_BUILD: '12', APP_CHANGELOG: 'Neu: Wecker' }));

import { flow, WHATS_NEW_KEY } from './flow';

type Internals = { whatsNewDone: boolean; checkingWhatsNew: boolean };

beforeEach(() => {
  h.kv.clear();
  Object.assign(h.app.state, { conn: 'disconnected', postSync: false, computing: false, profile: null, lastSync: null, stats: { oldest: null, newest: null, count: 0 } });
  h.workout.state = { phase: 'idle', recovery: null };
  flow.state = { ceremony: false, ceremonyAt: 0, exiting: false, story: null, detail: null, connectPrompt: false, whatsNew: null };
  Object.assign(flow as unknown as Internals, { whatsNewDone: false, checkingWhatsNew: false });
});

const updatedUser = () => {
  h.kv.set(WHATS_NEW_KEY, '0.1.11');
  h.app.state.lastSync = 1_700_000_000;
};

describe('„Was ist neu“', () => {
  it('nach einem Update: zeigen, beim Schließen merken, danach nicht wieder', async () => {
    updatedUser();
    await flow.maybeWhatsNew();
    expect(flow.state.whatsNew).toEqual({ version: '0.1.12', text: 'Neu: Wecker' });
    await flow.closeWhatsNew();
    expect(flow.state.whatsNew).toBeNull();
    expect(h.kv.get(WHATS_NEW_KEY)).toBe('0.1.12');
    await flow.maybeWhatsNew();
    expect(flow.state.whatsNew).toBeNull();
  });

  it('Erstinstallation: nichts zeigen, nur die Version merken', async () => {
    await flow.maybeWhatsNew();
    expect(flow.state.whatsNew).toBeNull();
    expect(h.kv.get(WHATS_NEW_KEY)).toBe('0.1.12');
  });

  it('wartet, solange ein anderes Vollbild offen ist oder im Hintergrund gearbeitet wird', async () => {
    updatedUser();
    flow.state = { ...flow.state, story: { date: '2026-10-24' } };
    await flow.maybeWhatsNew();
    expect(flow.state.whatsNew).toBeNull();
    flow.state = { ...flow.state, story: null };
    h.workout.state = { phase: 'running', recovery: null };
    await flow.maybeWhatsNew();
    expect(flow.state.whatsNew).toBeNull();
    h.workout.state = { phase: 'idle', recovery: null };
    h.app.state.conn = 'syncing';
    await flow.maybeWhatsNew();
    expect(flow.state.whatsNew).toBeNull();
    h.app.state.conn = 'connected';
    await flow.maybeWhatsNew();
    expect(flow.state.whatsNew).not.toBeNull();
    expect(h.kv.get(WHATS_NEW_KEY)).toBe('0.1.11'); // erst beim Schließen gemerkt
  });

  it('die Morgen-Story legt sich nicht über das offene Sheet', async () => {
    updatedUser();
    await flow.maybeWhatsNew();
    expect(flow.state.whatsNew).not.toBeNull();
    await flow.maybeAutoStory();
    expect(flow.state.story).toBeNull();
  });

  it('die Sync-Zeremonie hat Vorrang: das Sheet weicht ungesehen und kommt danach wieder', async () => {
    updatedUser();
    h.app.state.lastSync = null;
    h.app.state.stats = { oldest: null, newest: null, count: 5 };
    vi.useFakeTimers({ now: new Date('2026-10-24T08:00:00'), toFake: ['Date'] });
    try {
      flow.start();
      await flow.maybeWhatsNew();
      expect(flow.state.whatsNew).not.toBeNull();
      h.app.state.conn = 'syncing';
      for (const l of h.app.listeners) l(h.app.state);
      await vi.waitFor(() => expect(flow.state.ceremony).toBe(true));
      expect(flow.state.whatsNew).toBeNull();
      expect(h.kv.get(WHATS_NEW_KEY)).toBe('0.1.11');
      await flow.maybeWhatsNew(); // während der Zeremonie: nein
      expect(flow.state.whatsNew).toBeNull();
      await flow.endCeremony(true, true);
      h.app.state.conn = 'connected';
      await flow.maybeWhatsNew();
      expect(flow.state.whatsNew).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
