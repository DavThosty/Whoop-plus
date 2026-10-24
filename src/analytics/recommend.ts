// Tagesempfehlung: Ziel-Strain für heute und empfohlene Schlafenszeit.
//
// Stufen nach Recovery (wie die Ampel):
//   ≥ 67 %  → Ziel-Strain 14–18 (intensiv)
//   34–66 % → 10–14 (moderat)
//   < 34 %  → 0–10 (Regeneration)
//   keine Recovery (Kalibrierung) → neutral 8–12
// War die Schlafleistung der letzten Nacht unter 70 %, wird eine Stufe tiefer empfohlen.
//
// Schlafenszeit heute Abend:
//   typische Aufwachzeit (Median der letzten 7 Nächte, sonst 07:00)
//   − Schlafbedarf − typische Wachminuten im Bett (Median), auf 5 Minuten gerundet.

export type RecommendLevel = 'high' | 'moderate' | 'low' | 'calibration';

export const REC_HIGH = 67;
export const REC_MODERATE = 34;
export const SLEEP_PENALTY_BELOW = 70;
export const DEFAULT_WAKE_MIN = 7 * 60;
export const RECENT_NIGHTS = 7;

export const STRAIN_TARGETS: Record<RecommendLevel, readonly [number, number]> = {
  high: [14, 18],
  moderate: [10, 14],
  low: [0, 10],
  calibration: [8, 12],
};

/** Ziel des Herunterstufens bei schlechtem Schlaf. */
const DOWN: Record<RecommendLevel, RecommendLevel | 'calibration-low'> = {
  high: 'moderate',
  moderate: 'low',
  low: 'low',
  calibration: 'calibration-low',
};
const CALIBRATION_LOW: readonly [number, number] = [4, 8];

export interface RecentNight {
  /** Aufwachzeitpunkt (Unix-Sekunden). */
  end: number;
  /** Wachminuten innerhalb der Schlafperiode. */
  awakeMin: number;
}

export interface RecommendInput {
  recovery: number | null;
  /** Schlafleistung der letzten Nacht 0–100 (null = kein Schlaf erkannt). */
  sleepPerformance: number | null;
  sleepNeedH: number;
  /** Bis zu 7 letzte Nächte (beliebige Reihenfolge); weitere werden ignoriert (neueste zählen). */
  recentNights: readonly RecentNight[];
  /** Kalibrierungsfortschritt (Nächte mit Baseline), nur für den Text. */
  baselineNights?: number;
}

export interface Recommendation {
  level: RecommendLevel;
  /** Stufe nach Recovery, bevor der Schlaf berücksichtigt wurde. */
  baseLevel: RecommendLevel;
  strainRange: readonly [number, number];
  /** Wurde wegen schlechten Schlafs heruntergestuft? */
  sleepAdjusted: boolean;
  title: string;
  text: string;
  /** Kurzer Hinweis für die Kalibrierungsphase (sonst null). */
  note: string | null;
  bedtime: {
    /** Minuten seit Mitternacht (lokal), 0–1435, auf 5 min gerundet. */
    minutesOfDay: number;
    hour: number;
    minute: number;
    /** Zugrunde gelegte Aufwachzeit (Minuten seit Mitternacht). */
    wakeMinutesOfDay: number;
    /** Ob die Aufwachzeit aus echten Nächten stammt oder der Standard 07:00 ist. */
    wakeFromHistory: boolean;
    sleepNeedMin: number;
    awakeMin: number;
  };
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Lokale Minuten seit Mitternacht eines Unix-Zeitstempels. */
export function localMinutesOfDay(unixSec: number): number {
  const d = new Date(unixSec * 1000);
  return d.getHours() * 60 + d.getMinutes();
}

export function levelForRecovery(recovery: number | null): RecommendLevel {
  if (recovery == null || !Number.isFinite(recovery)) return 'calibration';
  if (recovery >= REC_HIGH) return 'high';
  if (recovery >= REC_MODERATE) return 'moderate';
  return 'low';
}

const TEXTS: Record<RecommendLevel, { title: string; text: string }> = {
  high: {
    title: 'Gut erholt – heute darf es intensiv werden.',
    text: 'Dein Körper ist bereit für eine harte Einheit: Intervalle, ein langer Lauf oder schweres Krafttraining.',
  },
  moderate: {
    title: 'Mittlere Erholung – moderat belasten.',
    text: 'Ein lockeres bis mittleres Training passt gut. Achte auf deinen Körper und plane Pausen ein.',
  },
  low: {
    title: 'Niedrige Erholung – heute regenerieren.',
    text: 'Gönn dir einen ruhigen Tag: Spazierengehen, Mobility oder Yoga. Viel trinken und früh ins Bett.',
  },
  calibration: {
    title: 'Kalibrierung läuft – heute ausgewogen belasten.',
    text: 'Solange deine persönliche Baseline entsteht, empfiehlt sich eine mittlere Belastung.',
  },
};

/** Tagesempfehlung aus Recovery, Schlaf und den letzten Nächten. */
export function recommendDay(input: RecommendInput): Recommendation {
  const baseLevel = levelForRecovery(input.recovery);
  const poorSleep = input.sleepPerformance != null && input.sleepPerformance < SLEEP_PENALTY_BELOW;
  let level = baseLevel;
  let strainRange = STRAIN_TARGETS[baseLevel];
  let sleepAdjusted = false;
  if (poorSleep) {
    const down = DOWN[baseLevel];
    if (down === 'calibration-low') {
      strainRange = CALIBRATION_LOW;
      sleepAdjusted = true;
    } else if (down !== baseLevel) {
      level = down;
      strainRange = STRAIN_TARGETS[down];
      sleepAdjusted = true;
    }
  }

  let { title, text } = TEXTS[level];
  if (baseLevel === 'calibration') {
    title = TEXTS.calibration.title;
    text = TEXTS.calibration.text;
    if (input.sleepPerformance != null) {
      text += poorSleep
        ? ` Die letzte Nacht war mit ${Math.round(input.sleepPerformance)} % Schlafleistung kurz – heute eher locker.`
        : ` Mit ${Math.round(input.sleepPerformance)} % Schlafleistung bist du gut in den Tag gestartet.`;
    }
  } else if (sleepAdjusted) {
    text = `Wegen kurzer Nacht (${Math.round(input.sleepPerformance!)} % Schlafleistung) eine Stufe ruhiger: ${text}`;
  }
  const note =
    baseLevel === 'calibration'
      ? `Die Recovery braucht 4 Nächte als Vergleichsbasis${
          input.baselineNights != null ? ` – bisher ${Math.min(4, input.baselineNights)}/4` : ''
        }.`
      : null;

  // Schlafenszeit
  const nights = [...input.recentNights]
    .filter((n) => Number.isFinite(n.end))
    .sort((a, b) => b.end - a.end)
    .slice(0, RECENT_NIGHTS);
  const wakeMed = median(nights.map((n) => localMinutesOfDay(n.end)));
  const awakeMed = median(nights.map((n) => Math.max(0, n.awakeMin)));
  const wake = wakeMed == null ? DEFAULT_WAKE_MIN : Math.round(wakeMed);
  const sleepNeedMin = Math.round(input.sleepNeedH * 60);
  const awakeMin = awakeMed == null ? 0 : Math.round(awakeMed);
  const raw = wake - sleepNeedMin - awakeMin;
  const rounded = Math.round(raw / 5) * 5;
  const minutesOfDay = ((rounded % 1440) + 1440) % 1440;

  return {
    level,
    baseLevel,
    strainRange,
    sleepAdjusted,
    title,
    text,
    note,
    bedtime: {
      minutesOfDay,
      hour: Math.floor(minutesOfDay / 60),
      minute: minutesOfDay % 60,
      wakeMinutesOfDay: wake,
      wakeFromHistory: wakeMed != null,
      sleepNeedMin,
      awakeMin,
    },
  };
}
