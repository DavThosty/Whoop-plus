// Oberfläche für die nativen Zusatzfunktionen (automatische Sicherung, Ablauf der App).
// Im Browser rendern alle Komponenten nichts.
import { useState } from 'preact/hooks';
import { localDateString } from '../analytics/time';
import { autoBackup, expiryWatch } from '../native';
import type { AutoBackup } from '../native/backup';
import { formatExpiry, REMINDER_BODY, shouldShowBanner, type ExpiryWatch } from '../native/expiry';
import { GlassCard, Icon, Sheet } from './components';
import { app } from './controller';
import { useSelect } from './hooks';
import { workout } from './workout';

/** „heute 07:12“, „gestern 07:12“ oder „Mi., 22.10., 07:12“ */
export function whenLabel(ms: number, nowMs = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const day = localDateString(ms / 1000);
  if (day === localDateString(nowMs / 1000)) return `heute ${time}`;
  if (day === localDateString(nowMs / 1000 - 86_400)) return `gestern ${time}`;
  return `${d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}, ${time}`;
}

/** Mehr → Daten: Stand der automatischen Sicherung, Fundort und „Neueste einspielen“. */
export function AutoBackupInfo() {
  return autoBackup ? <AutoBackupInfoInner backup={autoBackup} /> : null;
}

function AutoBackupInfoInner(props: { backup: AutoBackup }) {
  const b = useSelect(props.backup, (x) => x);
  const [busy, setBusy] = useState(false);
  const latest = b.files[0];
  const restore = async () => {
    if (!latest) return;
    const label = latest.date.split('-').reverse().join('.');
    if (!confirm(`Sicherung vom ${label} einspielen? Vorhandene Daten werden ergänzt bzw. überschrieben.`)) return;
    setBusy(true);
    try {
      await app.importData(await props.backup.readFile(latest.name));
      workout.bumpVersion();
    } catch (e) {
      app.note(`Sicherung einspielen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 16 }}>
      <div class="small muted" style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Automatische Sicherung</div>
      <div class="small">
        {b.running ? 'Sicherung läuft …' : b.lastAt ? `Letzte automatische Sicherung: ${whenLabel(b.lastAt)}` : 'Noch keine automatische Sicherung.'}
      </div>
      <div class="small faint" style={{ marginTop: 4 }}>
        Die App sichert sich jeden Tag selbst. Zu finden in der Dateien-App unter <i>Auf meinem iPhone → Whoop Plus → Sicherungen</i> (die letzten 7 Tage).
      </div>
      {b.error && <div class="small faint" style={{ marginTop: 4, color: 'var(--yellow)' }}>{b.error}</div>}
      {latest && (
        <button class="btn small" style={{ marginTop: 10 }} disabled={busy} onClick={restore}>
          {busy ? 'Spiele ein …' : `Neueste Sicherung einspielen (${latest.date.split('-').reverse().slice(0, 2).join('.')}.)`}
        </button>
      )}
    </div>
  );
}

/** Mehr: „App gültig bis …“. */
export function AppValidity() {
  return expiryWatch ? <AppValidityInner watch={expiryWatch} /> : null;
}

function AppValidityInner(props: { watch: ExpiryWatch }) {
  const exp = useSelect(props.watch, (x) => x.expiresAt);
  if (exp == null) return null;
  const soon = exp - Date.now() < 48 * 3600_000;
  return (
    <GlassCard>
      <div class="row" style={{ gap: 12 }}>
        <span class="ico" style={{ color: soon ? 'var(--yellow)' : 'var(--text-2)' }}><Icon name="alarm" /></span>
        <div class="grow">
          <div style={{ fontWeight: 600 }}>App gültig bis {formatExpiry(exp)}</div>
          <div class="small faint">Verlängern in SideStore („Aktualisieren“). Die App erinnert dich rechtzeitig.</div>
        </div>
      </div>
    </GlassCard>
  );
}

/** Heute: dezenter Hinweis, wenn die App in weniger als 48 h abläuft (für den Tag ausblendbar). */
export function ExpiryBanner() {
  return expiryWatch ? <ExpiryBannerInner watch={expiryWatch} /> : null;
}

function ExpiryBannerInner(props: { watch: ExpiryWatch }) {
  const s = useSelect(props.watch, (x) => ({ exp: x.expiresAt, dismissed: x.bannerDismissed }));
  const now = Date.now();
  if (!shouldShowBanner(s.exp, now, s.dismissed, localDateString(now / 1000))) return null;
  return (
    <div class="glass card tight" role="status" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 14 }}>
      <span style={{ color: 'var(--yellow)', flex: 'none', marginTop: 2 }}><Icon name="alarm" /></span>
      <div class="grow small">
        <b style={{ color: 'var(--text)' }}>Whoop Plus läuft bald ab</b> ({formatExpiry(s.exp!)}).<br />
        {REMINDER_BODY}
      </div>
      <button class="btn ghost small" aria-label="Für heute ausblenden" style={{ minHeight: 32, padding: '0 6px' }} onClick={() => props.watch.dismissBanner()}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/** Erklärung vor der iOS-Mitteilungsabfrage (nach dem ersten erfolgreichen Verbinden). */
export function NotifPermissionSheet() {
  return expiryWatch ? <NotifPermissionSheetInner watch={expiryWatch} /> : null;
}

function NotifPermissionSheetInner(props: { watch: ExpiryWatch }) {
  const ask = useSelect(props.watch, (x) => x.askPermission);
  if (!ask) return null;
  return (
    <Sheet title="Erinnerung ans Verlängern" onClose={() => props.watch.declinePermission()}>
      <p>Whoop Plus muss alle 7 Tage in SideStore verlängert werden – darf die App dich einen Tag vorher daran erinnern?</p>
      <div class="btns">
        <button class="btn primary" onClick={() => void props.watch.acceptPermission()}><Icon name="check" /> Ja, erinnern</button>
      </div>
    </Sheet>
  );
}
