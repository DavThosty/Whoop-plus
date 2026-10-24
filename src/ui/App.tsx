import { useEffect, useState } from 'preact/hooks';
import { Icon, Sheet } from './components';
import { app } from './controller';
import { DetailView } from './details';
import { flow } from './flow';
import { dateLabel, longDate, recoveryHex, today } from './format';
import { useApp, useDay, useStore } from './hooks';
import { Ceremony } from './overlays/Ceremony';
import { Story } from './overlays/Story';
import { WorkoutScreen } from './overlays/Workout';
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
  const s = useApp();
  const f = useStore(flow);
  const w = useStore(workout);
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
    void app.init();
  }, []);

  useEffect(() => {
    history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`);
    window.scrollTo(0, 0);
  }, [tab]);

  // Morgen-Story, sobald im Hintergrund Ruhe ist (nach Start, Sync und Berechnung).
  useEffect(() => {
    if (s.stats) void flow.maybeAutoStory();
  }, [s.dataVersion, s.conn, s.postSync, s.computing, s.stats?.count]);

  // Glow-Farbe folgt der Recovery des angezeigten Tags (auf anderen Seiten: heute).
  const glowDay = useDay(tab === 'heute' || tab === 'schlaf' ? date : today(), s.dataVersion);
  const glow = recoveryHex(glowDay?.recovery ?? null);
  useEffect(() => {
    document.documentElement.style.setProperty('--glow', glow);
  }, [glow]);

  // Hintergrund nicht scrollen, solange ein Vollbild offen ist.
  const overlayOpen = !!(f.detail || f.story || f.ceremony || w.phase !== 'idle');
  useEffect(() => {
    document.body.style.overflow = overlayOpen ? 'hidden' : '';
  }, [overlayOpen]);

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
      <div class="bg-glow" aria-hidden="true"><div class="grain" /></div>
      {!f.ceremony && <TopLine />}
      <div class="app">
        <header class="topbar">
          <div style={{ minWidth: 0 }}>
            <div class="eyebrow">{titles[tab][1]}</div>
            <h1>{titles[tab][0]}</h1>
          </div>
          <button class="pill" onClick={() => setTab('mehr')} aria-label="Verbindungsstatus">
            <span class={`dot ${s.conn === 'connected' ? 'on' : s.conn === 'disconnected' ? (s.error ? 'err' : '') : 'busy'}`} />
            {statusText(s.conn, s.battery?.percent ?? null, busy, s.demo)}
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

      <nav class="tabbar" aria-label="Navigation">
        <TabBtn id="heute" tab={tab} setTab={setTab} icon="today" label="Heute" />
        <TabBtn id="schlaf" tab={tab} setTab={setTab} icon="moon" label="Schlaf" />
        <button class="tab-center" aria-label="Workout starten" onClick={() => void flow.startWorkout()}>
          <Icon name="bolt" />
        </button>
        <TabBtn id="trends" tab={tab} setTab={setTab} icon="trends" label="Trends" />
        <TabBtn id="mehr" tab={tab} setTab={setTab} icon="more" label="Mehr" />
      </nav>

      {f.detail && <DetailView key={`${f.detail.kind}-${f.detail.date}`} kind={f.detail.kind} date={f.detail.date} rect={f.detail.rect} />}
      {w.phase !== 'idle' && <WorkoutScreen />}
      {f.story && <Story date={f.story.date} />}
      {f.ceremony && <Ceremony />}
      {f.connectPrompt && <ConnectPrompt goTo={goTo} />}
    </>
  );
}

function TabBtn(props: { id: Tab; tab: Tab; setTab: (t: Tab) => void; icon: string; label: string }) {
  const on = props.tab === props.id;
  return (
    <button class={`tab ${on ? 'on' : ''}`} onClick={() => props.setTab(props.id)} aria-current={on ? 'page' : undefined}>
      <Icon name={props.icon} />
      {props.label}
    </button>
  );
}

function statusText(conn: string, battery: number | null, busy: boolean, demo: boolean): string {
  if (conn === 'connecting') return 'Verbinde …';
  if (conn === 'syncing') return 'Sync …';
  if (conn === 'connected') {
    if (busy) return 'Berechne …';
    return battery != null ? `${Math.round(battery)} %${demo ? ' · Demo' : ''}` : 'Verbunden';
  }
  return 'Getrennt';
}

/** Dünne Fortschrittslinie oben für unauffällige Syncs. */
function TopLine() {
  const s = useApp();
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
            <div class="note warn">Dieser Browser kann kein Bluetooth. Öffne die App auf dem iPhone in <b>Bluefy</b>.</div>
            <button class="btn primary" onClick={() => app.startDemo()}>Demo starten</button>
          </>
        )}
        <button class="btn ghost" onClick={() => { close(); props.goTo('mehr'); }}>Zu den Band-Einstellungen</button>
      </div>
    </Sheet>
  );
}
