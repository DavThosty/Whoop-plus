// Regeln, wann die Vollbild-Erlebnisse automatisch erscheinen (rein, testbar).

/** Vor dieser Uhrzeit (lokal) gibt es keine Morgen-Zeremonie und keine Story – sonst würde ein nächtlicher Auto-Sync sie verbrauchen. */
export const MORNING_FROM_HOUR = 4;
/** Story nur bis zu dieser Uhrzeit. */
export const STORY_UNTIL_HOUR = 14;
/** Zeremonie nur, wenn der letzte erfolgreiche Sync mindestens so lange her ist … */
export const CEREMONY_MIN_GAP_SEC = 3 * 3600;
/** … und die Story erst, wenn das Aufwachen so lange zurückliegt (sonst ist der Schlaf evtl. noch nicht vorbei). */
export const STORY_MIN_AWAKE_SEC = 10 * 60;

/**
 * Soll dieser Sync die Morgen-Zeremonie bekommen?
 * Einmal pro Kalendertag, erst ab 04:00 und nur, wenn seit dem letzten erfolgreichen Sync
 * mindestens 3 Stunden vergangen sind (dann sind neue Nachtdaten zu erwarten).
 */
export function ceremonyDue(p: { now: Date; today: string; lastCeremonyDate: string | null | undefined; lastSyncSec: number | null | undefined }): boolean {
  if (p.lastCeremonyDate === p.today) return false;
  if (p.now.getHours() < MORNING_FROM_HOUR) return false;
  if (p.lastSyncSec != null && p.now.getTime() / 1000 - p.lastSyncSec < CEREMONY_MIN_GAP_SEC) return false;
  return true;
}

/** Soll die Morgen-Story jetzt automatisch erscheinen? */
export function storyDue(p: { now: Date; today: string; storyShownDate: string | null | undefined; sleepEndSec: number | null | undefined }): boolean {
  if (p.storyShownDate === p.today) return false;
  const h = p.now.getHours();
  if (h < MORNING_FROM_HOUR || h >= STORY_UNTIL_HOUR) return false;
  if (p.sleepEndSec == null) return false;
  return p.now.getTime() / 1000 - p.sleepEndSec >= STORY_MIN_AWAKE_SEC;
}

/**
 * „Was ist neu“ nach einem Update: einmal pro Version.
 * - `show`: Hinweis zeigen (beim Schließen wird die Version gemerkt),
 * - `mark`: nur die Version merken (erste Installation – es gibt noch nichts „Neues“ – oder kein Text vorhanden),
 * - `none`: nichts tun (schon gesehen oder Entwicklungs-Build).
 * Ohne gemerkte Version, aber mit vorhandenen Daten war schon eine ältere Version installiert (vor dieser Funktion) → zeigen.
 */
export function whatsNewAction(p: { version: string; lastSeen: string | null | undefined; hasData: boolean; changelog: string }): 'show' | 'mark' | 'none' {
  if (!p.version || p.version === 'dev') return 'none';
  if (p.lastSeen === p.version) return 'none';
  if (p.lastSeen == null && !p.hasData) return 'mark';
  if (!p.changelog.trim()) return 'mark';
  return 'show';
}
