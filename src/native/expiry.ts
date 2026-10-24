// Ablaufdatum der App (kostenlose Apple-ID: 7 Tage) und Erinnerungen vor dem Ablauf.
// Das Datum liest das app-eigene Plugin „AppExpiry“ (ios/App/App/AppExpiryPlugin.swift) aus
// embedded.mobileprovision – diese Datei gibt es erst nach dem Signieren durch SideStore.
// Lokale Mitteilungen 24 h und 3 h vor Ablauf; neu geplant, sobald sich das Datum ändert (nach dem Aktualisieren).

export const REMINDER_IDS = [7101, 7102] as const;
export const REMINDER_HOURS_BEFORE = [24, 3] as const;
export const BANNER_HOURS = 48;
export const REMINDER_TITLE = 'Whoop Plus läuft bald ab';
export const REMINDER_BODY = 'Öffne SideStore und tippe auf Aktualisieren – dauert 10 Sekunden.';

const KEY_SCHEDULED = 'whoop-plus.expiry-reminders';
const KEY_ASKED = 'whoop-plus.notif-asked';
const KEY_BANNER = 'whoop-plus.expiry-banner-dismissed';

export type NotifPermission = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';

export interface Reminder {
  id: number;
  at: Date;
  title: string;
  body: string;
}

/** Erinnerungen 24 h und 3 h vor Ablauf – nur solche, die noch in der Zukunft liegen. */
export function planReminders(expiresAt: number, nowMs: number): Reminder[] {
  const out: Reminder[] = [];
  REMINDER_HOURS_BEFORE.forEach((h, i) => {
    const at = expiresAt - h * 3600_000;
    if (at > nowMs + 60_000) out.push({ id: REMINDER_IDS[i], at: new Date(at), title: REMINDER_TITLE, body: REMINDER_BODY });
  });
  return out;
}

/** „Mi., 30. Okt., 21:14“ */
export function formatExpiry(ms: number): string {
  return new Date(ms).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Hinweis auf „Heute“: weniger als 48 h bis zum Ablauf und heute noch nicht weggeklickt. */
export function shouldShowBanner(expiresAt: number | null, nowMs: number, dismissedDay: string | null, today: string): boolean {
  return expiresAt != null && expiresAt - nowMs < BANNER_HOURS * 3600_000 && dismissedDay !== today;
}

export interface ExpiryDeps {
  now(): number;
  today(): string;
  /** ISO-Datum aus dem Provisioning-Profil, null ohne Profil (Simulator, unsigniert). */
  readExpiry(): Promise<string | null>;
  checkPermission(): Promise<NotifPermission>;
  requestPermission(): Promise<NotifPermission>;
  schedule(reminders: Reminder[]): Promise<void>;
  cancel(ids: number[]): Promise<void>;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  log(line: string): void;
}

export interface ExpiryState {
  expiresAt: number | null;
  /** Erklär-Sheet vor der iOS-Mitteilungsabfrage anzeigen. */
  askPermission: boolean;
  bannerDismissed: string | null;
}

type Listener = (s: ExpiryState) => void;

export class ExpiryWatch {
  state: ExpiryState;
  private listeners = new Set<Listener>();
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: ExpiryDeps) {
    this.state = { expiresAt: null, askPermission: false, bannerDismissed: this.get(KEY_BANNER) };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<ExpiryState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private get(k: string): string | null {
    try {
      return this.deps.storage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  }

  private put(k: string, v: string): void {
    try {
      this.deps.storage?.setItem(k, v);
    } catch {
      /* egal */
    }
  }

  get showBanner(): boolean {
    return shouldShowBanner(this.state.expiresAt, this.deps.now(), this.state.bannerDismissed, this.deps.today());
  }

  /** Beim Start und bei jeder Rückkehr in die App: Datum lesen und Erinnerungen abgleichen. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    let iso: string | null = null;
    try {
      iso = await this.deps.readExpiry();
    } catch (e) {
      this.deps.log(`Ablaufdatum nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ms = iso ? Date.parse(iso) : NaN;
    this.set({ expiresAt: Number.isFinite(ms) ? ms : null });
    await this.syncReminders();
  }

  /** Plant die Erinnerungen neu, wenn sich das Ablaufdatum geändert hat (oder `force`). */
  async syncReminders(force = false): Promise<void> {
    const exp = this.state.expiresAt;
    if (exp == null) return;
    const key = String(exp);
    if (!force && this.get(KEY_SCHEDULED) === key) return;
    try {
      if ((await this.deps.checkPermission()) !== 'granted') return;
      await this.deps.cancel([...REMINDER_IDS]);
      const list = planReminders(exp, this.deps.now());
      if (list.length) await this.deps.schedule(list);
      this.put(KEY_SCHEDULED, key);
      this.deps.log(`Erinnerungen ans Verlängern geplant: ${list.length ? list.map((r) => formatExpiry(r.at.getTime())).join(', ') : 'keine (zu knapp)'}`);
    } catch (e) {
      this.deps.log(`Erinnerungen planen: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Nach dem ersten erfolgreichen Verbinden: einmalig erklären, warum Mitteilungen sinnvoll sind. */
  async onConnected(): Promise<void> {
    if (this.state.askPermission || this.get(KEY_ASKED)) return;
    try {
      const p = await this.deps.checkPermission();
      if (p === 'prompt' || p === 'prompt-with-rationale') this.set({ askPermission: true });
      else this.put(KEY_ASKED, '1');
    } catch {
      /* ohne Plugin: nichts */
    }
  }

  /** „Erlauben“ im Erklär-Sheet → iOS-Abfrage. */
  async acceptPermission(): Promise<void> {
    this.set({ askPermission: false });
    this.put(KEY_ASKED, '1');
    try {
      const p = await this.deps.requestPermission();
      if (p === 'granted') await this.syncReminders(true);
    } catch (e) {
      this.deps.log(`Mitteilungen: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  declinePermission(): void {
    this.set({ askPermission: false });
    this.put(KEY_ASKED, '1');
  }

  dismissBanner(): void {
    const d = this.deps.today();
    this.put(KEY_BANNER, d);
    this.set({ bannerDismissed: d });
  }
}
