(globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import { ceremonyDue, storyDue, whatsNewAction } from './rules';

const at = (hhmm: string, date = '2026-03-10') => new Date(`${date}T${hhmm}:00`);
const sec = (d: Date) => d.getTime() / 1000;

describe('Morgen-Zeremonie', () => {
  const base = { today: '2026-03-10', lastCeremonyDate: '2026-03-09' };
  it('erscheint morgens nach längerer Pause', () => {
    const now = at('07:30');
    expect(ceremonyDue({ ...base, now, lastSyncSec: sec(at('23:00', '2026-03-09')) })).toBe(true);
    expect(ceremonyDue({ ...base, now, lastSyncSec: null })).toBe(true);
  });
  it('nicht direkt nach Mitternacht (Auto-Sync würde sie verbrauchen)', () => {
    expect(ceremonyDue({ ...base, now: at('00:10'), lastSyncSec: sec(at('20:00', '2026-03-09')) })).toBe(false);
    expect(ceremonyDue({ ...base, now: at('03:59'), lastSyncSec: null })).toBe(false);
    expect(ceremonyDue({ ...base, now: at('04:00'), lastSyncSec: null })).toBe(true);
  });
  it('nicht, wenn gerade erst synchronisiert wurde', () => {
    expect(ceremonyDue({ ...base, now: at('07:30'), lastSyncSec: sec(at('07:15')) })).toBe(false);
    expect(ceremonyDue({ ...base, now: at('07:30'), lastSyncSec: sec(at('04:29')) })).toBe(true);
  });
  it('nur einmal am Tag', () => {
    expect(ceremonyDue({ now: at('09:00'), today: '2026-03-10', lastCeremonyDate: '2026-03-10', lastSyncSec: null })).toBe(false);
  });
});

describe('Morgen-Story', () => {
  const base = { today: '2026-03-10', storyShownDate: null };
  it('nach dem Aufwachen bis 14 Uhr', () => {
    expect(storyDue({ ...base, now: at('07:30'), sleepEndSec: sec(at('07:00')) })).toBe(true);
    expect(storyDue({ ...base, now: at('13:59'), sleepEndSec: sec(at('07:00')) })).toBe(true);
    expect(storyDue({ ...base, now: at('14:00'), sleepEndSec: sec(at('07:00')) })).toBe(false);
  });
  it('nicht mitten in der Nacht oder solange der Schlaf noch läuft', () => {
    expect(storyDue({ ...base, now: at('03:00'), sleepEndSec: sec(at('02:30')) })).toBe(false);
    expect(storyDue({ ...base, now: at('06:05'), sleepEndSec: sec(at('06:00')) })).toBe(false);
  });
  it('ohne Schlaf oder schon gesehen: nein', () => {
    expect(storyDue({ ...base, now: at('08:00'), sleepEndSec: null })).toBe(false);
    expect(storyDue({ now: at('08:00'), today: '2026-03-10', storyShownDate: '2026-03-10', sleepEndSec: sec(at('07:00')) })).toBe(false);
  });
});

describe('„Was ist neu“ nach einem Update', () => {
  const base = { version: '0.1.12', changelog: 'Neu: Wecker' };
  it('nach einem Update einmal zeigen', () => {
    expect(whatsNewAction({ ...base, lastSeen: '0.1.11', hasData: true })).toBe('show');
    expect(whatsNewAction({ ...base, lastSeen: '0.1.11', hasData: false })).toBe('show');
  });
  it('dieselbe Version nicht noch einmal', () => {
    expect(whatsNewAction({ ...base, lastSeen: '0.1.12', hasData: true })).toBe('none');
  });
  it('Erstinstallation: nichts zeigen, nur Version merken', () => {
    expect(whatsNewAction({ ...base, lastSeen: undefined, hasData: false })).toBe('mark');
    expect(whatsNewAction({ ...base, lastSeen: null, hasData: false })).toBe('mark');
  });
  it('Update von einer Version ohne diese Funktion (Daten vorhanden, nichts gemerkt): zeigen', () => {
    expect(whatsNewAction({ ...base, lastSeen: undefined, hasData: true })).toBe('show');
  });
  it('ohne Text nur merken, Entwicklungs-Build nie', () => {
    expect(whatsNewAction({ ...base, changelog: '  ', lastSeen: '0.1.11', hasData: true })).toBe('mark');
    expect(whatsNewAction({ version: 'dev', changelog: 'x', lastSeen: '0.1.11', hasData: true })).toBe('none');
    expect(whatsNewAction({ version: '', changelog: 'x', lastSeen: undefined, hasData: true })).toBe('none');
  });
});
