// Native Zusatzfunktionen (nur in der iOS-App): tägliche Sicherung und Ablauf-Erinnerung.
// Per Side-Effect-Import in src/main.tsx eingebunden; im Browser sind beide `null`.
import { BleClient } from '@capacitor-community/bluetooth-le';
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import { localDateString } from '../analytics/time';
import { isNativeApp } from '../ble/platform';
import { exportBackupParts, getKv, setKv } from '../store/db';
import { app } from '../ui/controller';
import { workout } from '../ui/workout';
import { AutoBackup, BACKUP_DIR, type BackupMeta } from './backup';

const WRITE_CHUNK_CHARS = 2_000_000;
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
  const path = (name: string) => `${BACKUP_DIR}/${name}`;
  return new AutoBackup({
    now: () => Date.now(),
    context: () => ({ app: app.state, workoutPhase: workout.state.phase }),
    getMeta: () => getKv<BackupMeta>('autoBackup'),
    setMeta: (m) => setKv('autoBackup', m),
    exportParts: () => exportBackupParts(),
    // Gestreamt: Teile sammeln, in ~2-MB-Stücken anhängen – die ganze Sicherung liegt nie im Speicher.
    writeParts: async (name, parts) => {
      let first = true;
      let buf = '';
      const flush = async () => {
        if (first) await Filesystem.writeFile({ path: path(name), data: buf, directory: dir, encoding: Encoding.UTF8, recursive: true });
        else if (buf) await Filesystem.appendFile({ path: path(name), data: buf, directory: dir, encoding: Encoding.UTF8 });
        first = false;
        buf = '';
      };
      for await (const p of parts) {
        buf += p;
        if (buf.length >= WRITE_CHUNK_CHARS) await flush();
      }
      await flush();
      return (await Filesystem.stat({ path: path(name), directory: dir })).size;
    },
    list: async () =>
      (await Filesystem.readdir({ path: BACKUP_DIR, directory: dir })).files
        .filter((f) => f.type === 'file')
        .map((f) => ({ name: f.name, size: f.size })),
    rename: (from, to) => Filesystem.rename({ from: path(from), to: path(to), directory: dir, toDirectory: dir }),
    remove: (name) => Filesystem.deleteFile({ path: path(name), directory: dir }),
    // Über den Datei-Server des WebViews laden statt als einen riesigen String über die Bridge.
    open: async (name) => {
      const { uri } = await Filesystem.getUri({ path: path(name), directory: dir });
      const res = await fetch(Capacitor.convertFileSrc(uri));
      if (!res.ok) throw new Error(`Sicherung nicht lesbar (${res.status})`);
      return new File([await res.blob()], name, { type: 'application/json' });
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
    openSettings: () => BleClient.openAppSettings(),
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
  void backup.load();
  void expiry.refresh();
  let wasLinked = false;
  app.subscribe((s) => {
    // Startet erst nach 60 s ununterbrochener Ruhe (z. B. nach Sync + Auswertung).
    backup.poke();
    const linked = s.conn === 'connected' || s.conn === 'syncing';
    if (linked && !wasLinked && !s.demo) void expiry.onConnected();
    wasLinked = linked;
  });
  workout.subscribe(() => backup.poke());
  void App.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return;
    // Gleich startet evtl. Verbinden + Sync – Ruhezeit neu beginnen, damit die Sicherung nicht dazwischenfunkt.
    backup.restartIdle();
    void expiry.refresh();
  });
}

install();
