// Formatierungs- und Datumshilfen für die Oberfläche (deutsch).

/** Lokales Datum (YYYY-MM-DD) um n Tage verschieben; rechnet über 12 Uhr mittags, damit Zeitumstellungen nicht stören. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n, 12);
  return toDateString(dt);
}

export function toDateString(dt: Date): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export function today(): string {
  return toDateString(new Date());
}

export function dateLabel(date: string): string {
  const t = today();
  if (date === t) return 'Heute';
  if (date === addDays(t, -1)) return 'Gestern';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function shortDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
}

export function weekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('de-DE', { weekday: 'narrow' });
}

export function clock(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString('de-DE', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

export function durationShort(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function relative(unixSec: number): string {
  const diff = Math.round(Date.now() / 1000 - unixSec);
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `vor ${Math.round(diff / 3600)} h`;
  return dateTime(unixSec);
}

export function num(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '–';
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Ampelfarbe der Recovery wie bei Whoop: ≥ 67 grün, ≥ 34 gelb, sonst rot. */
export function recoveryColor(v: number | null | undefined): string {
  if (v == null) return 'var(--muted)';
  if (v >= 67) return 'var(--green)';
  if (v >= 34) return 'var(--yellow)';
  return 'var(--red)';
}

export const ZONE_COLORS = ['#7ba1bb', '#0093e7', '#16ec06', '#ffde00', '#ff0026'];
