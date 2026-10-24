// Bequemer Sync in der nativen App: beim Zurückkehren in den Vordergrund ohne Auswahldialog mit dem
// gemerkten Band verbinden und den Verlauf holen, wenn der letzte Sync älter als 5 Minuten ist.
// Beim App-Start erledigt das bereits AppController.init() (reconnect → automatischer Sync nach dem Verbinden).
// Beim Wechsel in den Hintergrund wird bewusst NICHT getrennt (UIBackgroundModes: bluetooth-central).
// Eingebunden per Side-Effect-Import in src/main.tsx; im Browser passiert hier nichts.
import { App } from '@capacitor/app';
import type { AppController } from '../ui/controller';
import { app } from '../ui/controller';
import { isNativeApp } from './platform';

export const SYNC_MAX_AGE_SEC = 5 * 60;

/** Was beim Zurückkehren in die App zu tun ist (exportiert für Tests). */
export async function onForeground(ctl: Pick<AppController, 'state' | 'reconnectRemembered' | 'syncNow'>, nowSec = Date.now() / 1000): Promise<void> {
  const s = ctl.state;
  if (s.demo) return;
  if (s.conn === 'disconnected') {
    // Verbindet nur, wenn ein Band gemerkt ist und der Nutzer nicht selbst getrennt hat; nach dem
    // Verbinden synchronisiert WhoopDevice automatisch. Ist das Band außer Reichweite, landet das nur im Protokoll.
    await ctl.reconnectRemembered();
    return;
  }
  if (s.conn === 'connected' && (s.lastSync == null || nowSec - s.lastSync > SYNC_MAX_AGE_SEC)) {
    await ctl.syncNow(true);
  }
}

export function installNativeLifecycle(ctl: AppController = app): void {
  if (!isNativeApp()) return;
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    onForeground(ctl).finally(() => {
      busy = false;
    });
  };
  void App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) run();
  });
}

installNativeLifecycle();
