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

/** Farben als Hex (für SVG-Verläufe und Glow). */
export const COLORS = {
  green: '#16ec06',
  yellow: '#ffde00',
  red: '#ff0026',
  blue: '#0093e7',
  sleep: '#8db4d2',
  hr: '#ff4d6d',
  neutral: '#6d8299',
} as const;

export function recoveryHex(v: number | null | undefined): string {
  if (v == null) return COLORS.neutral;
  if (v >= 67) return COLORS.green;
  if (v >= 34) return COLORS.yellow;
  return COLORS.red;
}

/** Zustandstext der Recovery wie „Gut erholt“ oder „Kalibrierung 2/4“. */
export function recoveryState(
  day: { recovery: number | null; baselineNights: number; sleep: unknown } | null | undefined,
): string {
  if (!day) return 'Noch keine Daten';
  const v = day.recovery;
  if (v == null) {
    if (day.baselineNights < 4) return `Kalibrierung ${Math.min(day.baselineNights, 4)}/4`;
    return day.sleep ? 'Keine HRV-Messung' : 'Kein Schlaf erkannt';
  }
  if (v >= 67) return 'Gut erholt';
  if (v >= 34) return 'Mittlere Erholung';
  return 'Niedrige Erholung';
}

/** Farbe für „unter Zone 1“. */
export const ZONE0_COLOR = '#4f6377';
export const ZONE_NAMES = ['Locker', 'Zone 1 · Aufwärmen', 'Zone 2 · Grundlage', 'Zone 3 · Aerob', 'Zone 4 · Schwelle', 'Zone 5 · Maximal'];

export function zoneColor(z: number): string {
  return z >= 1 && z <= 5 ? ZONE_COLORS[z - 1]! : ZONE0_COLOR;
}

/** Minuten seit Mitternacht als „22:45“. */
export function clockMin(minutesOfDay: number): string {
  const m = ((Math.round(minutesOfDay) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Sekunden als „1:02:03“ bzw. „12:03“. */
export function hms(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Hex-Farbe mit Weiß mischen (amount 0–1). */
export function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Hex-Farbe abdunkeln (amount 0–1). */
export function darken(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c * (1 - amount));
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}
