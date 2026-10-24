// Erklärtexte für die UI ("Wie wird das berechnet?"). Die Zahlen werden aus den
// Konstanten der Berechnungsmodule eingesetzt, damit Text und Code übereinstimmen.

import { ACTIVE_HRR_FRACTION, BMR_KCAL_PER_KG_DAY, BMR_SEX_FACTOR } from './calories';
import { STILL_ANGLE_DEG, STILL_RUN_MIN, ANGLE_BLOCK_SEC } from './epochs';
import { HRV_MIN_DIFFS_PER_WINDOW, HRV_MIN_WINDOWS, HRV_WINDOW_SEC, MALIK_RESET_AFTER, MALIK_THRESHOLD } from './hrv';
import {
  BASELINE_MAX_NIGHTS,
  BASELINE_MIN_NIGHTS,
  LN_HRV_SD_FLOOR,
  LOGISTIC_OFFSET,
  LOGISTIC_SLOPE,
  RHR_SD_FLOOR,
  SLEEP_REF,
  SLEEP_SCALE,
  W_HRV,
  W_RHR,
  W_SLEEP,
} from './recovery';
import {
  HR_ONLY_FRACTION,
  HR_ONLY_MIN_MARGIN_BPM,
  HR_ONLY_STABILITY_BPM,
  MERGE_GAP_MIN,
  MIN_SLEEP_MIN,
  MIN_WAKE_EPISODE_MIN,
  RESTING_HR_MIN_COVERED,
  RESTING_HR_WINDOW_MIN,
  THRESHOLD_P10_MARGIN_BPM,
} from './sleep';
import { DEFAULT_RHR, STRAIN_MAX, STRAIN_TRIMP_REF } from './strain';
import { SLEEP_WINDOW_END_HOUR, SLEEP_WINDOW_START_HOUR } from './time';

export type ExplainTopic = 'recovery' | 'strain' | 'sleep' | 'hrv' | 'restingHr' | 'calories';

export interface Explanation {
  title: string;
  /** Kurze Absätze in Klartext. */
  paragraphs: string[];
  /** Formeln, eine pro Zeile (Klartext, Unicode). */
  formulas: string[];
  /** Grenzen und Hinweise. */
  limitations: string[];
}

const de = (x: number, digits = 2) =>
  x.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const pct = (x: number) => `${de(x * 100, 0)} %`;

export const EXPLANATIONS: Record<ExplainTopic, Explanation> = {
  recovery: {
    title: 'Recovery',
    paragraphs: [
      `Die Recovery vergleicht die letzte Nacht mit deinem persönlichen Normalwert. Als Normalwert (Baseline) dienen bis zu ${BASELINE_MAX_NIGHTS} vorherige Nächte, in denen HRV und Ruhepuls gemessen wurden. Solange weniger als ${BASELINE_MIN_NIGHTS} solche Nächte vorliegen, wird keine Recovery angezeigt (Kalibrierung).`,
      'Für HRV, Ruhepuls und Schlafleistung wird ein z-Wert berechnet: wie viele Standardabweichungen der heutige Wert vom Normalwert abweicht. Eine höhere HRV und ein niedrigerer Ruhepuls als üblich wirken positiv. Die HRV wird logarithmiert, weil sie stark schwankt und rechtsschief verteilt ist.',
      `Die gewichtete Summe wird mit einer logistischen Kurve auf 1–99 % abgebildet. Sind alle Werte genau normal, ergibt sich etwa ${Math.round(100 / (1 + Math.exp(-LOGISTIC_OFFSET)))} %.`,
    ],
    formulas: [
      `zHRV = (ln HRV − Mittel(ln HRV)) / SD(ln HRV), SD mindestens ${de(LN_HRV_SD_FLOOR)}`,
      `zRuhepuls = −(Ruhepuls − Mittel) / SD, SD mindestens ${de(RHR_SD_FLOOR)} bpm`,
      `zSchlaf = (Schlafleistung − ${pct(SLEEP_REF)}) / ${pct(SLEEP_SCALE)}`,
      `c = ${de(W_HRV)} · zHRV + ${de(W_RHR)} · zRuhepuls + ${de(W_SLEEP)} · zSchlaf`,
      `Recovery = 100 / (1 + e^−(${de(LOGISTIC_SLOPE)} · c + ${de(LOGISTIC_OFFSET)})), begrenzt auf 1–99 %`,
    ],
    limitations: [
      'Die Gewichte sind eine nachvollziehbare Festlegung, keine Kopie des WHOOP-Algorithmus; die Werte sind daher nicht direkt mit der WHOOP-App vergleichbar.',
      'Krankheit, Alkohol oder eine späte Mahlzeit senken die HRV – die Recovery zeigt das, kennt aber die Ursache nicht.',
    ],
  },
  strain: {
    title: 'Strain (Belastung)',
    paragraphs: [
      'Strain misst die Herz-Kreislauf-Belastung des Tages nach der TRIMP-Methode von Edwards. Jede Minute wird anhand des Minutenpulses einer Zone der Herzfrequenzreserve (HRR) zugeordnet; höhere Zonen zählen mehr Punkte.',
      `Minuten des Hauptschlafs werden nicht mitgezählt. Als Ruhepuls dient der Wert der letzten Nacht (ersatzweise ${DEFAULT_RHR} bpm), als Maximalpuls der Wert aus deinem Profil. Minuten mit nur teilweise vorhandenen Pulsdaten zählen anteilig.`,
      `Die Punkte werden logarithmisch auf 0–${STRAIN_MAX} skaliert: Der Anfang ist leicht, jeder weitere Punkt erfordert deutlich mehr Belastung.`,
    ],
    formulas: [
      '%HRR = (Puls − Ruhepuls) / (Maximalpuls − Ruhepuls)',
      'Zone 1: 50–60 %, Zone 2: 60–70 %, Zone 3: 70–80 %, Zone 4: 80–90 %, Zone 5: ≥ 90 % HRR',
      'TRIMP = Σ Minuten in Zone × Zonennummer (1–5)',
      `Strain = ${STRAIN_MAX} · ln(TRIMP + 1) / ln(${STRAIN_TRIMP_REF + 1}), begrenzt auf 0–${STRAIN_MAX}`,
    ],
    limitations: [
      'Krafttraining mit kurzen Pulsspitzen wird unterschätzt, weil nur der Puls und nicht die Muskelarbeit eingeht.',
      'Ein zu niedrig eingestellter Maximalpuls lässt den Strain zu hoch ausfallen.',
    ],
  },
  sleep: {
    title: 'Schlaf',
    paragraphs: [
      `Gesucht wird der Hauptschlaf zwischen ${SLEEP_WINDOW_START_HOUR}:00 Uhr am Vorabend und ${SLEEP_WINDOW_END_HOUR}:00 Uhr am Tag selbst. Grundlage ist der Armwinkel aus dem Schwerkraftsensor (Methode nach van Hees): Der Winkel wird über ${ANGLE_BLOCK_SEC} Sekunden gemittelt. Ändert er sich mindestens ${STILL_RUN_MIN} Minuten lang nie um ${STILL_ANGLE_DEG}° oder mehr, gilt der Arm als ruhig.`,
      `Eine Minute zählt als Ruhe, wenn der Arm ruhig ist und der Puls unter einer Schwelle liegt. Die Schwelle ist das Maximum aus dem Median-Puls des Suchfensters und dem 10. Perzentil + ${THRESHOLD_P10_MARGIN_BPM} bpm. Ohne Puls (Band abgelegt) gibt es keinen Schlaf.`,
      `Fehlen Bewegungsdaten (z. B. bei Live-Daten), wird nur der Puls verwendet: unter einer strengeren Schwelle (10. Perzentil + ${pct(HR_ONLY_FRACTION)} des Abstands zum Median, mindestens + ${HR_ONLY_MIN_MARGIN_BPM} bpm) und stabil (Schwankung der Minutenwerte innerhalb von 5 Minuten höchstens ${HR_ONLY_STABILITY_BPM} bpm).`,
      `Ruheblöcke, zwischen denen höchstens ${MERGE_GAP_MIN} Minuten liegen, werden verbunden; die Lücke zählt als wach, auch wenn dort keine Daten vorliegen. Der längste Block ist der Hauptschlaf, sofern er mindestens ${MIN_SLEEP_MIN / 60} Stunden dauert. Wachphasen sind mindestens ${MIN_WAKE_EPISODE_MIN} Minuten am Stück wach.`,
    ],
    formulas: [
      'z-Winkel = atan(gz / √(gx² + gy²))',
      'Schlafeffizienz = Schlafminuten / (Ende − Beginn)',
      'Schlafleistung = min(100 %, Schlafminuten / Schlafbedarf)',
    ],
    limitations: [
      'Ruhiges Liegen im Bett (Lesen, Handy) mit niedrigem Puls kann als Schlaf erkannt werden – das ist eine bekannte Grenze aller Bewegungsmessungen.',
      'Es werden keine Schlafphasen (Tief-/REM-Schlaf) bestimmt; dafür reicht diese Methode nicht aus.',
      'Nickerchen außerhalb des Suchfensters und zweite Schlafblöcke werden nicht gezählt.',
    ],
  },
  hrv: {
    title: 'Herzratenvariabilität (HRV)',
    paragraphs: [
      'Die HRV ist die Schwankung der Abstände zwischen Herzschlägen (RR-Intervalle). Angegeben wird die RMSSD in Millisekunden, gemessen nur in den Schlafminuten der Hauptschlafphase.',
      'Es werden nur sicher aufeinanderfolgende Schläge verglichen: Jede Sekunde ohne RR-Wert, jede Datenlücke und jede Sekunde ohne Puls beendet eine Schlagfolge.',
      `Artefakte und Extraschläge werden nach Malik entfernt: Ein Intervall, das um mehr als ${pct(MALIK_THRESHOLD)} vom zuletzt akzeptierten abweicht, wird verworfen, ebenso die Differenzen, die es berühren. Nach ${MALIK_RESET_AFTER} Verwerfungen in Folge wird der neue Rhythmus übernommen.`,
      `Die Nacht wird in ${HRV_WINDOW_SEC / 60}-Minuten-Fenster geteilt. Ein Fenster zählt mit mindestens ${HRV_MIN_DIFFS_PER_WINDOW} sauberen Differenzen; der Nachtwert ist der Median aller Fenster (mindestens ${HRV_MIN_WINDOWS} Fenster nötig).`,
    ],
    formulas: [
      'RMSSD = √( Mittelwert( (RRᵢ − RRᵢ₋₁)² ) )',
      `Malik: verwerfen, wenn |RRᵢ − RR_ref| > ${de(MALIK_THRESHOLD)} · RR_ref`,
      'HRV der Nacht = Median der Fenster-RMSSDs',
    ],
    limitations: [
      'Optisch gemessene RR-Intervalle sind ungenauer als ein EKG-Brustgurt; einzelne Nächte können daher ausreißen.',
      'Der Wert ist der Median über die ganze Schlafzeit und daher nicht identisch mit der WHOOP-HRV (dort aus der letzten Tiefschlafphase).',
    ],
  },
  restingHr: {
    title: 'Ruhepuls',
    paragraphs: [
      `Der Ruhepuls ist der niedrigste gleitende ${RESTING_HR_WINDOW_MIN}-Minuten-Mittelwert des Pulses während des Hauptschlafs. Ein Fenster zählt nur, wenn mindestens ${RESTING_HR_MIN_COVERED} seiner Minuten Pulsdaten haben.`,
      `Er geht in die Recovery ein und dient als Untergrenze der Herzfrequenzreserve für Strain und Kalorien. Ohne gemessene Nacht wird der letzte bekannte Wert verwendet, sonst ${DEFAULT_RHR} bpm.`,
    ],
    formulas: [`Ruhepuls = min über alle ${RESTING_HR_WINDOW_MIN}-Minuten-Fenster im Schlaf von Mittel(Puls)`],
    limitations: ['Ein unruhiger Schlaf oder eine Erkältung erhöhen den Wert.'],
  },
  calories: {
    title: 'Kalorien',
    paragraphs: [
      `Der Grundumsatz wird vereinfacht aus dem Körpergewicht geschätzt (${BMR_KCAL_PER_KG_DAY} kcal je kg und Tag, Frauen × ${de(BMR_SEX_FACTOR.w)}), weil die Körpergröße für genauere Formeln (z. B. Mifflin-St Jeor) nicht erfasst wird. Er zählt für jede Minute des Tages – auch im Schlaf und wenn das Band nicht getragen wurde.`,
      `In aktiven Minuten (Puls über Ruhepuls + ${pct(ACTIVE_HRR_FRACTION)} der Herzfrequenzreserve) wird stattdessen der Verbrauch nach Keytel et al. (2005) aus Puls, Gewicht, Alter und Geschlecht berechnet, mindestens aber der Grundumsatz.`,
    ],
    formulas: [
      `Grundumsatz/Tag = ${BMR_KCAL_PER_KG_DAY} · Gewicht(kg) · (Mann ${de(BMR_SEX_FACTOR.m)} / Frau ${de(BMR_SEX_FACTOR.w)}); pro Minute ÷ 1440`,
      'Männer: kJ/min = −55,0969 + 0,6309 · Puls + 0,1988 · Gewicht + 0,2017 · Alter',
      'Frauen: kJ/min = −20,4022 + 0,4472 · Puls − 0,1263 · Gewicht + 0,074 · Alter',
      'kcal = kJ / 4,184',
      `aktiv, wenn Puls > Ruhepuls + ${de(ACTIVE_HRR_FRACTION)} · (Maximalpuls − Ruhepuls)`,
    ],
    limitations: [
      'Pulsbasierte Kalorienschätzungen haben typischerweise ±15–25 % Fehler; der vereinfachte Grundumsatz zusätzlich etwa ±10–15 %.',
      'Stress oder Hitze erhöhen den Puls ohne entsprechenden Energieverbrauch.',
    ],
  },
};

export function explain(topic: ExplainTopic): Explanation {
  return EXPLANATIONS[topic];
}
