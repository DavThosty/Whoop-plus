import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  addListener: vi.fn(),
  native: false,
  app: { state: {}, reconnectRemembered: vi.fn(), syncNow: vi.fn() },
}));

vi.mock('@capacitor/app', () => ({ App: { addListener: m.addListener } }));
vi.mock('./platform', () => ({ isNativeApp: () => m.native }));
vi.mock('../ui/controller', () => ({ app: m.app }));

import { installNativeLifecycle, onForeground, SYNC_MAX_AGE_SEC } from './native-lifecycle';
import type { AppController } from '../ui/controller';

type Ctl = Parameters<typeof onForeground>[0];

function ctl(state: Partial<AppController['state']>): Ctl & { reconnectRemembered: ReturnType<typeof vi.fn>; syncNow: ReturnType<typeof vi.fn> } {
  return {
    state: { demo: false, conn: 'disconnected', lastSync: null, ...state } as AppController['state'],
    reconnectRemembered: vi.fn().mockResolvedValue(undefined),
    syncNow: vi.fn().mockResolvedValue(undefined),
  };
}

const NOW = 1_800_000_000;

describe('native Lebenszyklus', () => {
  beforeEach(() => {
    m.addListener.mockReset();
  });

  it('registriert im Browser nichts (Import-Zeitpunkt)', () => {
    expect(m.addListener).not.toHaveBeenCalled();
  });

  it('verbindet beim Zurückkehren ohne Dialog, wenn getrennt', async () => {
    const c = ctl({ conn: 'disconnected' });
    await onForeground(c, NOW);
    expect(c.reconnectRemembered).toHaveBeenCalledTimes(1);
    expect(c.syncNow).not.toHaveBeenCalled();
  });

  it('synchronisiert, wenn verbunden und der letzte Sync älter als 5 Minuten ist', async () => {
    const old = ctl({ conn: 'connected', lastSync: NOW - SYNC_MAX_AGE_SEC - 1 });
    await onForeground(old, NOW);
    expect(old.syncNow).toHaveBeenCalledTimes(1);

    const never = ctl({ conn: 'connected', lastSync: null });
    await onForeground(never, NOW);
    expect(never.syncNow).toHaveBeenCalledTimes(1);

    const fresh = ctl({ conn: 'connected', lastSync: NOW - 60 });
    await onForeground(fresh, NOW);
    expect(fresh.syncNow).not.toHaveBeenCalled();
  });

  it('lässt laufende Vorgänge und die Demo in Ruhe', async () => {
    for (const c of [ctl({ conn: 'syncing' }), ctl({ conn: 'connecting' }), ctl({ demo: true })]) {
      await onForeground(c, NOW);
      expect(c.reconnectRemembered).not.toHaveBeenCalled();
      expect(c.syncNow).not.toHaveBeenCalled();
    }
  });

  it('hört nativ auf appStateChange und reagiert nur auf isActive', async () => {
    m.native = true;
    const c = ctl({ conn: 'disconnected' });
    installNativeLifecycle(c as unknown as AppController);
    expect(m.addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function));
    const cb = m.addListener.mock.calls[0][1] as (s: { isActive: boolean }) => void;
    cb({ isActive: false });
    expect(c.reconnectRemembered).not.toHaveBeenCalled();
    cb({ isActive: true });
    cb({ isActive: true }); // läuft schon → kein zweiter Versuch
    await vi.waitFor(() => expect(c.reconnectRemembered).toHaveBeenCalledTimes(1));
    m.native = false;
  });
});
