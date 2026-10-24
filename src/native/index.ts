// Native Zusatzfunktionen (nur in der iOS-App): tägliche Sicherung und Ablauf-Erinnerung.
// Per Side-Effect-Import in src/main.tsx eingebunden; im Browser sind beide `null`.
import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import { localDateString } from '../analytics/time';
import { isNativeApp } from '../ble/platform';
import { exportBackup, getKv, setKv } from '../store/db';
import { writeBlobChunked } from '../store/share-file';
import { app } from '../ui/controller';
import { workout } from '../ui/workout';
import { AutoBackup, BACKUP_DIR } from './backup';
import { ExpiryWatch, type NotifPermission } from './expiry';

interface AppExpiryPlugin {
  getExpiry(): Promise<{ expiresAt: string | null }>;
}
const AppExpiry = registerPlugin<AppExpiryPlugin>('AppExpiry');

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function createBackup(): AutoBackup {
  const dir = Directory.Documents;
  return new AutoBackup({
    now: () => Date.now(),
    getMeta: () => getKv<{ at: number; file: string }>('autoBackup'),
    setMeta: (m) => setKv('autoBackup', m),
    exportBlob: () => exportBackup(),
    write: async (name, blob) => void (await writeBlobChunked(blob, `${BACKUP_DIR}/${name}`, dir)),
    list: async () => (await Filesystem.readdir({ path: BACKUP_DIR, directory: dir })).files.filter((f) => f.type === 'file').map((f) => f.name),
    remove: (name) => Filesystem.deleteFile({ path: `${BACKUP_DIR}/${name}`, directory: dir }),
    read: async (name) => {
      const r = await Filesystem.readFile({ path: `${BACKUP_DIR}/${name}`, directory: dir, encoding: Encoding.UTF8 });
      return typeof r.data === 'string' ? r.data : await r.data.text();
    },
    log: (line) => app.note(line),
  });
}

function createExpiry(): ExpiryWatch {
  return new ExpiryWatch({
    now: () => Date.now(),
    today: () => localDateString(Date.now() / 1000),
    readExpiry: async () => (await AppExpiry.getExpiry()).expiresAt ?? null,
    checkPermission: async () => (await LocalNotifications.checkPermissions()).display as NotifPermission,
    requestPermission: async () => (await LocalNotifications.requestPermissions()).display as NotifPermission,
    schedule: async (list) => {
      await LocalNotifications.schedule({
        notifications: list.map((r) => ({ id: r.id, title: r.title, body: r.body, schedule: { at: r.at, allowWhileIdle: true } })),
      });
    },
    cancel: (ids) => LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) }),
    storage: safeStorage(),
    log: (line) => app.note(line),
  });
}

export const autoBackup: AutoBackup | null = isNativeApp() ? createBackup() : null;
export const expiryWatch: ExpiryWatch | null = isNativeApp() ? createExpiry() : null;

function install(): void {
  if (!autoBackup || !expiryWatch) return;
  const backup = autoBackup;
  const expiry = expiryWatch;
  const check = () => backup.maybeRun(app.state, workout.state.phase);
  void backup.load().then(check);
  void expiry.refresh();
  let wasLinked = false;
  app.subscribe((s) => {
    check();
    const linked = s.conn === 'connected' || s.conn === 'syncing';
    if (linked && !wasLinked && !s.demo) void expiry.onConnected();
    wasLinked = linked;
  });
  workout.subscribe(() => check());
  void App.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return;
    check();
    void expiry.refresh();
  });
}

install();
