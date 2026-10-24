// Gemeinsame Datentypen, die Protokoll, Speicher, Analyse und UI verbinden.
// Alle Zeitstempel sind Unix-Sekunden (UTC), sofern nicht anders angegeben.

/** Ein Sekunden-Datensatz, wie er aus dem Verlauf des Bands (Typ 0x2F) oder live kommt. */
export interface SampleRecord {
  /** Unix-Sekunden, Primärschlüssel. */
  ts: number;
  /** Herzfrequenz in bpm; 0 = nicht am Handgelenk / kein Wert. */
  hr: number;
  /** R-R-Intervalle in ms (0–4 Stück), bereits auf 200–2500 ms gefiltert. */
  rr: number[];
  /** Schwerkraftvektor in g (x, y, z), falls im Datensatz vorhanden. */
  grav?: [number, number, number];
  /** Woher der Datensatz stammt. Verlaufsdaten überschreiben Live-Daten. */
  src: 'history' | 'live';
}

export interface Profile {
  /** Alter in Jahren. */
  age: number;
  /** Gewicht in kg. */
  weightKg: number;
  sex: 'm' | 'w';
  /** Maximalpuls in bpm (Vorschlag: 220 − Alter). */
  maxHr: number;
  /** Schlafbedarf in Stunden. */
  sleepNeedH: number;
}

export interface SleepPeriod {
  /** Einschlafzeitpunkt (Unix-Sekunden). */
  start: number;
  /** Aufwachzeitpunkt (Unix-Sekunden). */
  end: number;
  /** Tatsächlich geschlafene Minuten (ohne Wachphasen). */
  asleepMin: number;
  /** Wachminuten innerhalb der Schlafperiode. */
  awakeMin: number;
  /** Anzahl Wachphasen (≥ 2 Minuten am Stück). */
  wakeEpisodes: number;
  /** Schlafeffizienz 0–1 (asleepMin / Gesamtdauer). */
  efficiency: number;
  /** Ruhepuls: niedrigster gleitender 10-Minuten-Mittelwert im Schlaf, bpm. */
  restingHr: number | null;
  /** Nächtliche HRV als RMSSD in ms (Median der 5-Minuten-Fenster). */
  hrvRmssd: number | null;
  /** Minutengenaue Hypnogramm-Daten: 0 = wach, 1 = Schlaf. */
  epochs: { t: number; asleep: 0 | 1 }[];
}

/** Ergebnis der Tagesauswertung. Ein "Tag" ist der lokale Kalendertag; der Schlaf zählt zu dem Tag, an dem man aufwacht. */
export interface DailySummary {
  /** Lokales Datum im Format YYYY-MM-DD, Primärschlüssel. */
  date: string;
  sleep: SleepPeriod | null;
  /** Schlafleistung 0–100 % = geschlafene Zeit / Schlafbedarf (gedeckelt). */
  sleepPerformance: number | null;
  /** Recovery 0–100 %, null solange weniger als 4 Nächte Baseline. */
  recovery: number | null;
  /** Wie viele Nächte die Baseline umfasst. */
  baselineNights: number;
  /** Strain 0–21 (Edwards-TRIMP, logarithmisch skaliert). */
  strain: number;
  /** Edwards-TRIMP-Punkte des Tages. */
  trimp: number;
  /** Minuten in den Herzfrequenzzonen 1–5 (Index 0 = Zone 1). */
  zoneMinutes: [number, number, number, number, number];
  /** Geschätzter Energieverbrauch in kcal (Keytel-Formel für aktive Minuten + Grundumsatz). */
  kcal: number;
  /** Durchschnitts- und Maximalpuls im Wachzustand. */
  avgHr: number | null;
  maxHr: number | null;
  /** Abdeckung: Minuten mit gültigen Pulswerten. */
  coveredMin: number;
  /** Zeitstempel der Berechnung (ms). */
  computedAt: number;
}

/** Ereignisse und Zustände, die die BLE-Schicht an die UI meldet. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'syncing';

export interface DeviceInfo {
  name: string;
  serial?: string;
  firmware?: string;
}

export interface SyncProgress {
  /** Bisher in dieser Sitzung empfangene Verlaufsdatensätze. */
  records: number;
  /** Zeitstempel des neuesten empfangenen Datensatzes. */
  newestTs: number | null;
  done: boolean;
}

export interface LiveHr {
  ts: number;
  hr: number;
  rr: number[];
  wearing: boolean;
}
