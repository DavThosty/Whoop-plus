// Zeit-Hilfsfunktionen. Alle Tagesgrenzen beziehen sich auf die lokale Zeitzone
// der JS-Laufzeit (Date). Durch die Verwendung des Date-Konstruktors mit lokalen
// Feldern sind die Grenzen sommerzeit-sicher: ein Tag kann 23, 24 oder 25 Stunden haben.

/** Ein Zeitintervall in Unix-Sekunden, halboffen: [start, end). */
export interface TimeRange {
  start: number;
  end: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Zerlegt 'YYYY-MM-DD' in [Jahr, Monat (1–12), Tag]. Wirft bei ungültigem Format. */
export function parseDate(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Ungültiges Datum: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Unix-Sekunden eines lokalen Zeitpunkts (Tag-Überlauf wird von Date normalisiert). */
export function localUnix(y: number, month: number, day: number, hour = 0, minute = 0): number {
  return Math.floor(new Date(y, month - 1, day, hour, minute, 0, 0).getTime() / 1000);
}

/** Lokales Datum 'YYYY-MM-DD' eines Unix-Zeitstempels (Sekunden). */
export function localDateString(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Datum um n Tage verschieben ('YYYY-MM-DD'). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = parseDate(date);
  const dt = new Date(y, m - 1, d + n, 12, 0, 0, 0); // Mittag: weit weg von DST-Umstellungen
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** Lokale Mitternacht bis nächste lokale Mitternacht (DST-sicher). */
export function dayBounds(date: string): TimeRange {
  const [y, m, d] = parseDate(date);
  return { start: localUnix(y, m, d), end: localUnix(y, m, d + 1) };
}

/** Beginn des Suchfensters: Vortag 18:00 Uhr lokal. */
export const SLEEP_WINDOW_START_HOUR = 18;
/** Ende des Suchfensters: am Tag selbst 14:00 Uhr lokal. */
export const SLEEP_WINDOW_END_HOUR = 14;

/**
 * Fenster, in dem der Hauptschlaf gesucht wird, der an `date` endet:
 * Vortag 18:00 lokal bis `date` 14:00 lokal.
 */
export function sleepWindow(date: string): TimeRange {
  const [y, m, d] = parseDate(date);
  return {
    start: localUnix(y, m, d - 1, SLEEP_WINDOW_START_HOUR),
    end: localUnix(y, m, d, SLEEP_WINDOW_END_HOUR),
  };
}
