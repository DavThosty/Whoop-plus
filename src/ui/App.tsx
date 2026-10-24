import { useEffect, useRef, useState } from 'preact/hooks';
import { NotifPermissionSheet } from './native-ui';
import { Icon, Sheet, WhatsNewSheet } from './components';
import { app } from './controller';
import { DetailView } from './details';
import { flow } from './flow';
import { dateTime, dateLabel, hms, longDate, recoveryHex, today } from './format';
import { useApp, useDay, useSelect, useStore } from './hooks';
import { Ceremony } from './overlays/Ceremony';
import { Story } from './overlays/Story';
import { WorkoutScreen } from './overlays/Workout';
import { NavBar } from './NavBar';
import { More } from './pages/More';
import { Sleep } from './pages/Sleep';
import { Today } from './pages/Today';
import { Trends } from './pages/Trends';
import { workout } from './workout';

export type Tab = 'heute' | 'schlaf' | 'trends' | 'mehr';
const TAB_IDS: Tab[] = ['heute', 'schlaf', 'trends', 'mehr'];
/** Alte Lesezeichen (#band, #profil) landen in „Mehr“. */
const LEGACY: Record<string, Tab> = { band: 'mehr', profil: 'mehr' };

function tabFromHash(h: string): Tab | null {
  if ((TAB_IDS as string[]).includes(h)) return h as Tab;
  return LEGACY[h] ?? null;
}

export function App() {
  // Nur die Felder abonnieren, die der Rahmen braucht – Live-Puls und Workout-Takt rendern nur ihre eigenen Komponenten neu.
  const s = useSelect(app, (a) => ({
    conn: a.conn, battery: a.battery?.percent ?? null, error: a.error, demo: a.demo, dataVersion: a.dataVersion, outOfRange: a.outOfRange,
    postSync: a.postSync, computing: a.computing, statsLoaded: !!a.stats, statsCount: a.stats?.count ?? null,
  }));
  const f = useStore(flow);
  const w = useSelect(workout, (x) => ({ phase: x.phase, recovery: !!x.recovery, minimized: x.minimized }));
  const workoutOpen = w.phase !== 'idle' && !w.minimized;
  const [tab, setTab] = useState<Tab>(() => tabFromHash(location.hash.slice(1)) ?? 'heute');
  const [date, setDate] = useState(today());
  const [followToday, setFollowToday] = useState(true);
  const changeDate = (d: string) => {
    setDate(d);
    setFollowToday(d === today());
  };

  // Bleibt die App über Mitternacht offen, springt „Heute“ auf den neuen Tag.
  useEffect(() => {
    if (!followToday) return;
    const tick = () => setDate((d) => (d === today() ? d : today()));
    const id = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [followToday]);

  useEffect(() => {
    flow.start();
    void app.init().then(() => workout.checkRecovery());
  }, []);

  useEffect(() => {
    history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`);
    window.scrollTo(0, 0);
  }, [tab]);

  // Morgen-Story und danach „Was ist neu“, sobald im Hintergrund Ruhe ist (nach Start, Sync und Berechnung)
  // und kein anderes Vollbild offen ist. Beide prüfen selbst, ob sie dran sind.
  useEffect(() => {
    if (s.statsLoaded) void flow.maybeAutoStory().then(() => flow.maybeWhatsNew());
  }, [s.dataVersion, s.conn, s.postSync, s.computing, s.statsCount, s.statsLoaded, !!f.detail, w.phase, w.recovery, f.connectPrompt, !!f.story, f.ceremony, !!f.whatsNew]);

  // Glow-Farbe folgt der Recovery des angezeigten Tags (auf anderen Seiten: heute).
  const glowDay = useDay(tab === 'heute' || tab === 'schlaf' ? date : today(), s.dataVersion);
  const glow = recoveryHex(glowDay?.recovery ?? null);
  // Der Glow ist statisch; nur bei einem Farbwechsel „atmet“ er einmal.
  const [pulse, setPulse] = useState(false);
  const firstGlow = useRef(true);
  useEffect(() => {
    document.documentElement.style.setProperty('--glow', glow);
    if (firstGlow.current) {
      firstGlow.current = false;
      return;
    }
    setPulse(true);
    const id = setTimeout(() => setPulse(false), 3200);
    return () => clearTimeout(id);
  }, [glow]);

  // Solange ein Vollbild offen ist: Hintergrund nicht scrollen, Animationen pausieren und – sobald das
  // Vollbild die Seite ganz verdeckt – die Seite ausblenden (spart das Neuberechnen der Glas-Unschärfe).
  const overlayOpen = !!(f.detail || f.story || f.ceremony || workoutOpen);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    document.body.style.overflow = overlayOpen ? 'hidden' : '';
    document.body.classList.toggle('overlay-open', overlayOpen);
    if (!overlayOpen) {
      setSettled(false);
      return;
    }
    const id = setTimeout(() => setSettled(true), 700);
    return () => clearTimeout(id);
  }, [overlayOpen]);
  const covered = overlayOpen && settled && !f.exiting;

  const goTo = (t: Tab) => setTab(t);
  const titles: Record<Tab, [string, string]> = {
    heute: [dateLabel(date), longDate(date)],
    schlaf: ['Schlaf', longDate(date)],
    trends: ['Trends', 'Verlauf & Workouts'],
    mehr: ['Mehr', 'Band, Profil & Daten'],
  };
  const busy = s.conn === 'syncing' || s.postSync || s.computing;

  return (
    <>
      <div class={`bg-glow ${pulse ? 'pulse' : ''}`} aria-hidden="true" style={covered ? { visibility: 'hidden' } : undefined}><div class="grain" /></div>
      {!f.ceremony && <TopLine />}
      <div class="app" style={covered ? { visibility: 'hidden' } : undefined} aria-hidden={covered ? 'true' : undefined}>
        <header class="topbar">
          <div style={{ minWidth: 0 }}>
            <div class="eyebrow">{titles[tab][1]}</div>
            <h1>{titles[tab][0]}</h1>
          </div>
          <button class="pill" onClick={() => setTab('mehr')} aria-label="Verbindungsstatus">
            <span class={`dot ${s.conn === 'connected' ? 'on' : s.conn === 'disconnected' ? (s.error ? 'err' : '') : 'busy'}`} />
            {statusText(s.conn, s.battery, busy, s.demo, s.outOfRange)}
          </button>
        </header>

        {s.error && !overlayOpen && (
          <button class="note err" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 14, cursor: 'pointer' }} onClick={() => app.clearError()}>
            {s.error} <span class="faint small">· tippen zum Schließen</span>
          </button>
        )}

        <main class="page" key={tab}>
          {tab === 'heute' && <Today date={date} setDate={changeDate} goTo={goTo} />}
          {tab === 'schlaf' && <Sleep date={date} setDate={changeDate} />}
          {tab === 'trends' && <Trends />}
          {tab === 'mehr' && <More />}
        </main>
      </div>

      <NavBar tab={tab} setTab={setTab} hidden={covered} />

      {f.detail && <DetailView key={`${f.detail.kind}-${f.detail.date}`} kind={f.detail.kind} date={f.detail.date} rect={f.detail.rect} />}
      {workoutOpen && <WorkoutScreen />}
      {f.story && <Story date={f.story.date} />}
      {f.ceremony && <Ceremony />}
      {f.connectPrompt && <ConnectPrompt goTo={goTo} />}
      {/* Nur wenn sonst nichts im Vordergrund ist (Overlay-Regeln wie bei „Was ist neu“). */}
      {!overlayOpen && !f.connectPrompt && !f.whatsNew && w.phase === 'idle' && !w.recovery && <NotifPermissionSheet />}
      {f.whatsNew && !f.ceremony && <WhatsNewSheet version={f.whatsNew.version} text={f.whatsNew.text} onClose={() => void flow.closeWhatsNew()} />}
      {w.recovery && w.phase === 'idle' && !f.ceremony && <RecoveryPrompt />}
    </>
  );
}


function statusText(conn: string, battery: number | null, busy: boolean, demo: boolean, outOfRange: boolean): string {
  if (conn === 'connecting') return 'Verbinde …';
  if (conn === 'syncing') return 'Sync …';
  if (conn === 'connected') {
    if (busy) return 'Berechne …';
    return battery != null ? `${Math.round(battery)} %${demo ? ' · Demo' : ''}` : 'Verbunden';
  }
  return outOfRange ? 'Nicht in Reichweite' : 'Getrennt';
}

/** Dünne Fortschrittslinie oben für unauffällige Syncs. */
function TopLine() {
  const s = useSelect(app, (a) => ({ conn: a.conn, sync: a.sync, postSync: a.postSync, computing: a.computing }));
  const [first, setFirst] = useState<number | null>(null);
  const syncing = s.conn === 'syncing' && !!s.sync && !s.sync.done;
  const on = syncing || s.postSync || s.computing;
  useEffect(() => {
    if (!syncing) setFirst(null);
    else if (first == null && s.sync?.newestTs) setFirst(s.sync.newestTs);
  }, [syncing, s.sync?.newestTs]);
  let frac: number | null = null;
  if (syncing && first != null && s.sync?.newestTs) {
    const now = Date.now() / 1000;
    frac = Math.max(0.04, Math.min(0.98, (s.sync.newestTs - first) / Math.max(60, now - first)));
  }
  return (
    <div class={`topline ${on ? 'on' : ''} ${frac == null ? 'indet' : ''}`} aria-hidden="true">
      <i style={{ width: `${(frac ?? 0.35) * 100}%` }} />
    </div>
  );
}

function ConnectPrompt(props: { goTo: (t: Tab) => void }) {
  const s = useApp();
  const close = () => flow.closeConnectPrompt();
  useEffect(() => {
    // Sobald verbunden, direkt ins Workout.
    if (s.conn === 'connected' || s.conn === 'syncing') {
      flow.closeConnectPrompt();
      void flow.startWorkout();
    }
  }, [s.conn]);
  return (
    <Sheet title="Band verbinden" onClose={close}>
      <p>Für ein Workout braucht es den Live-Puls vom Band. Verbinde dein Whoop, dann geht es direkt los.</p>
      <div class="btns">
        {s.supported ? (
          s.conn === 'connecting' ? (
            <button class="btn primary" disabled>Verbinde …</button>
          ) : (
            <button class="btn primary" onClick={() => app.connect()}><Icon name="band" /> Band verbinden</button>
          )
        ) : (
          <>
            <div class="note warn">Hier ist kein Bluetooth verfügbar. Whoop Plus ist als iPhone-App gedacht; im Desktop-Browser klappt die Verbindung nur mit Web Bluetooth (z. B. Chrome).</div>
            <button class="btn primary" onClick={() => app.startDemo()}>Demo starten</button>
          </>
        )}
        <button class="btn ghost" onClick={() => { close(); props.goTo('mehr'); }}>Zu den Band-Einstellungen</button>
      </div>
    </Sheet>
  );
}

/** Beim Start gefundenes, unterbrochenes Workout (z. B. weil iOS die App beendet hat). */
function RecoveryPrompt() {
  const s = useApp();
  const cp = useSelect(workout, (x) => x.recovery);
  const err = useSelect(workout, (x) => x.error);
  const [busy, setBusy] = useState(false);
  if (!cp) return null;
  const end = cp.pausedAt ?? cp.savedAt;
  const pauses = cp.pauses.reduce((a, [x, y]) => a + Math.max(0, y - x), 0);
  const linked = s.conn === 'connected' || s.conn === 'syncing';
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Unterbrochenes Workout" onClose={() => workout.deferRecovery()}>
      <p>
        Ein Workout vom {dateTime(Math.floor(cp.startTs))} wurde nicht beendet (gespeichert bis {hms(end - cp.startTs - pauses)} aktive Zeit).
        Du kannst es fortsetzen oder mit den bis dahin aufgezeichneten Daten abschließen.
      </p>
      {err && <div class="note err" style={{ marginBottom: 12 }}>{err}</div>}
      <div class="btns">
        {linked ? (
          <button class="btn primary" disabled={busy} onClick={() => act(() => workout.resumeRecovered())}><Icon name="play" /> Workout fortsetzen</button>
        ) : (
          <button class="btn primary" disabled={busy || s.conn === 'connecting' || !s.supported} onClick={() => app.connect()}>
            <Icon name="band" /> {s.conn === 'connecting' ? 'Verbinde …' : 'Band verbinden zum Fortsetzen'}
          </button>
        )}
        <button class="btn" disabled={busy} onClick={() => act(() => workout.finishRecovered())}><Icon name="check" /> Beenden & speichern</button>
        <button class="btn danger" disabled={busy} onClick={() => act(() => workout.discardRecovered())}>Verwerfen</button>
      </div>
    </Sheet>
  );
}
