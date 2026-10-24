import { useMemo, useRef, useState } from 'preact/hooks';
import type { Recommendation } from '../../analytics';
import { useTween } from '../anim';
import type { Tab } from '../App';
import { Delta, GlassCard, Icon, LineChart, RangeBar, Ring } from '../components';
import { app } from '../controller';
import { flow, type DetailKind } from '../flow';
import { addDays, clockMin, COLORS, durationShort, num, recoveryHex, recoveryState, today } from '../format';
import { useApp, useDay, useLive, usePrevious, useSelect } from '../hooks';
import { buildRecommendation, vitals } from '../insights';

export function Today(props: { date: string; setDate: (d: string) => void; goTo: (tab: Tab) => void }) {
  const s = useSelect(app, (a) => ({ dataVersion: a.dataVersion, profile: a.profile, conn: a.conn, statsCount: a.stats?.count ?? null }));
  const day = useDay(props.date, s.dataVersion);
  const prev = usePrevious(props.date, s.dataVersion);
  const isToday = props.date === today();
  const [dir, setDir] = useState<'l' | 'r' | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const go = (delta: number) => {
    const next = addDays(props.date, delta);
    if (next > today()) return;
    setDir(delta > 0 ? 'l' : 'r');
    props.setDate(next);
  };

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touch.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) go(dx < 0 ? 1 : -1);
  };

  const animKey = `${props.date}|${day === undefined ? '…' : day ? `${day.recovery}|${day.strain > 0}` : 'none'}`;
  const t = useTween(animKey, 1600, 120, day !== undefined);
  const tCards = useTween(animKey, 1400, 380, day !== undefined);

  const reco = useMemo(() => (isToday ? buildRecommendation(day, prev, s.profile) : null), [isToday, day, prev, s.profile]);
  const v = useMemo(() => vitals(day, prev), [day, prev]);
  const open = (kind: DetailKind) => (rect: DOMRect) => flow.openDetail(kind, props.date, rect);
  const noData = s.statsCount === 0 && s.conn === 'disconnected';

  if (noData && !day) return <Welcome goTo={props.goTo} />;

  const rec = day?.recovery ?? null;
  const recColor = recoveryHex(rec);

  return (
    <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {!s.profile && (
        <button class="note warn" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 14, cursor: 'pointer' }} onClick={() => props.goTo('mehr')}>
          Bitte zuerst dein <b style={{ color: 'var(--text)' }}>Profil</b> ausfüllen – ohne Alter, Gewicht und Maximalpuls lassen sich Strain und Kalorien nicht berechnen. ›
        </button>
      )}

      <div key={props.date} class={dir === 'l' ? 'slide-l' : dir === 'r' ? 'slide-r' : ''}>
        <section class="hero">
          <button class="day-arrow l" aria-label="Vorheriger Tag" onClick={() => go(-1)}><Icon name="chevL" /></button>
          <button class="day-arrow r" aria-label="Nächster Tag" disabled={isToday} onClick={() => go(1)}><Icon name="chevR" /></button>
          <div class="hero-ring" role="button" tabIndex={0} aria-label={`Recovery ${rec ?? '–'} %`}
            onClick={(e) => flow.openDetail('recovery', props.date, (e.currentTarget as HTMLElement).getBoundingClientRect())}>
            <Ring size={248} stroke={17} fraction={rec == null ? null : rec / 100} color={recColor} t={t}>
              <div class="eyebrow">Recovery</div>
              <div class="hero-value">
                {rec == null ? '–' : Math.round(rec * t)}
                {rec != null && <small>%</small>}
              </div>
            </Ring>
          </div>
          <div class="hero-state" style={{ color: rec == null ? 'var(--text)' : recColor }}>
            {day === undefined ? ' ' : recoveryState(day)}
          </div>
          <div class="hero-sub">
            {day?.sleep
              ? `HRV ${num(day.sleep.hrvRmssd)} ms · Ruhepuls ${num(day.sleep.restingHr)} bpm`
              : day === null
                ? isToday ? 'Für heute gibt es noch keine Auswertung.' : 'Für diesen Tag gibt es keine Auswertung.'
                : ' '}
          </div>
          {isToday && day?.sleep && (
            <button class="chip" onClick={() => flow.openStory(props.date)}>
              <Icon name="story" /> Story ansehen
            </button>
          )}
        </section>

        {reco && <RecoCard reco={reco} strain={day?.strain ?? null} t={tCards} onOpen={open('strain')} />}

        {isToday && s.conn !== 'disconnected' && <LiveCard />}

        {day && (
          <div class="grid2">
            <GlassCard title="Strain" dot={COLORS.blue} class="metric tight" onOpen={open('strain')}>
              <div class="metric-body">
                <Ring size={56} stroke={7} fraction={day.strain / 21} color={COLORS.blue} t={tCards} />
                <div>
                  <div class="val">{num(day.strain * tCards, 1)}</div>
                  <div class="sub">von 21</div>
                </div>
              </div>
              <RangeBar value={day.strain} range={reco?.strainRange ?? null} t={tCards} legend={false} />
            </GlassCard>

            <GlassCard title="Schlaf" dot={COLORS.sleep} class="metric tight" onOpen={open('sleep')}>
              <div class="metric-body">
                <Ring size={56} stroke={7} fraction={day.sleepPerformance == null ? null : day.sleepPerformance / 100} color={COLORS.sleep} t={tCards}>
                  <span class="mini">{day.sleepPerformance == null ? '–' : Math.round(day.sleepPerformance * tCards)}</span>
                </Ring>
                <div>
                  <div class="val">{day.sleep ? durationShort(day.sleep.asleepMin) : '–'}<span class="unit">h</span></div>
                  <div class="sub">Leistung {day.sleepPerformance == null ? '–' : `${Math.round(day.sleepPerformance)} %`}</div>
                </div>
              </div>
            </GlassCard>

            <GlassCard title="HRV" dot={COLORS.green} class="metric tight" onOpen={open('hrv')}>
              <div class="val">{num(v.hrv)}<span class="unit">ms</span></div>
              <div class="sub">{v.hrvTypical ? `Normal ${num(v.hrvTypical)} ms` : 'Baseline entsteht'}</div>
              <div><Delta value={v.hrvDeltaPct} text={`${num(Math.abs(v.hrvDeltaPct ?? 0))} %`} goodWhenUp flatBelow={2} /></div>
            </GlassCard>

            <GlassCard title="Ruhepuls" dot={COLORS.hr} class="metric tight" onOpen={open('rhr')}>
              <div class="val">{num(v.rhr)}<span class="unit">bpm</span></div>
              <div class="sub">{v.rhrMean ? `Normal ${num(v.rhrMean)} bpm` : 'Baseline entsteht'}</div>
              <div><Delta value={v.rhrDelta} text={`${num(Math.abs(v.rhrDelta ?? 0))} bpm`} goodWhenUp={false} flatBelow={0.5} /></div>
            </GlassCard>

            <GlassCard title="Energie" dot="#ff9f0a" class="span2 tight" onOpen={open('strain')}>
              <div class="row between" style={{ alignItems: 'flex-end' }}>
                <div>
                  <div class="big">{num(Math.round(day.kcal * tCards))}<span class="unit">kcal</span></div>
                  <div class="sub muted small" style={{ marginTop: 6 }}>{isToday ? 'Bisher heute verbraucht' : 'Verbrauch des Tages'}</div>
                </div>
                <div class="row" style={{ gap: 18 }}>
                  <div class="center"><div class="mid" style={{ fontSize: 22 }}>{num(day.avgHr)}</div><div class="tiny faint">Ø PULS</div></div>
                  <div class="center"><div class="mid" style={{ fontSize: 22 }}>{num(day.maxHr)}</div><div class="tiny faint">MAX</div></div>
                </div>
              </div>
            </GlassCard>
          </div>
        )}
      </div>
    </div>
  );
}

function RecoCard(props: { reco: Recommendation; strain: number | null; t: number; onOpen: (r: DOMRect) => void }) {
  const r = props.reco;
  const accent = r.level === 'high' ? COLORS.green : r.level === 'moderate' ? COLORS.yellow : r.level === 'low' ? COLORS.red : COLORS.sleep;
  return (
    <GlassCard title="Tagesempfehlung" dot={accent} onOpen={props.onOpen}>
      <p class="reco-title">{r.title}</p>
      <p class="reco-text">{r.text}</p>
      {r.note && <p class="reco-text faint small" style={{ marginTop: 8 }}>{r.note}</p>}
      <div class="reco-stats">
        <div class="reco-stat">
          <div class="k"><Icon name="bolt" /> Ziel-Strain</div>
          <div class="v">{r.strainRange[0]}–{r.strainRange[1]}</div>
        </div>
        <div class="reco-stat">
          <div class="k"><Icon name="moon" /> Ins Bett</div>
          <div class="v">{clockMin(r.bedtime.minutesOfDay)}</div>
        </div>
      </div>
      <RangeBar value={props.strain} range={r.strainRange} t={props.t} />
    </GlassCard>
  );
}

function LiveCard() {
  const s = useLive();
  const hr = s.live && s.live.hr > 0 ? s.live.hr : null;
  const busy = s.conn !== 'connected' && s.conn !== 'syncing';
  const beat = hr ? `${(60 / hr).toFixed(2)}s` : '1s';
  return (
    <GlassCard title="Live" dot={COLORS.hr} right={s.liveOn ? <span class="tiny faint">LETZTE 10 MIN</span> : undefined}>
      <div class="live-row">
        <div class="live-hr">
          <span class={`heart ${hr ? 'beat' : ''}`} style={{ animationDuration: beat }}><Icon name="heart" /></span>
          {hr != null ? (
            <>
              <span class="val">{hr}</span>
              <span class="muted small">bpm</span>
            </>
          ) : (
            <span class="muted" style={{ fontSize: 15, fontWeight: 600 }}>{s.liveOn ? 'Warte auf Puls …' : 'Live-Puls ist aus'}</span>
          )}
        </div>
        <button class="btn small" disabled={busy} onClick={() => app.setLive(!s.liveOn)}>
          {s.liveOn ? 'Live aus' : 'Live an'}
        </button>
      </div>
      {s.live && !s.live.wearing && <div class="note warn" style={{ marginTop: 12 }}>Das Band wird gerade nicht getragen.</div>}
      {s.liveOn && s.liveSeries.length > 1 && (
        <div style={{ marginTop: 12 }}>
          <LineChart height={90} gap={10} lastDot series={[{ points: s.liveSeries.map((p) => ({ x: p.ts, y: p.hr })), color: COLORS.hr, fill: true }]} />
        </div>
      )}
      <button class="btn primary" style={{ marginTop: 14 }} disabled={busy} onClick={() => void flow.startWorkout()}>
        <Icon name="bolt" /> Workout starten
      </button>
    </GlassCard>
  );
}

const FIRST_STEPS = [
  'Offizielle Whoop-App löschen oder zumindest beenden – das Band lässt nur eine Verbindung zu.',
  'iOS-Einstellungen → Bluetooth → bei „WHOOP …“ auf ⓘ → „Dieses Gerät ignorieren“.',
  'Band aufladen und anlegen, dann „Band verbinden“ tippen und das Band auswählen.',
  'Beim ersten Mal fragt iOS nach der Kopplung – bestätigen. Ohne Kopplung ignoriert das Band alle Befehle.',
  'Die App beim Synchronisieren geöffnet lassen; im Hintergrund kann Bluefy keine Verbindung halten.',
];

export function FirstSteps() {
  return (
    <ol class="steps">
      {FIRST_STEPS.map((x) => <li key={x}>{x}</li>)}
    </ol>
  );
}

function Welcome(props: { goTo: (tab: Tab) => void }) {
  const s = useApp();
  const t = useTween('welcome', 2200, 200);
  return (
    <div class="rise">
      <section class="glass card center" style={{ paddingTop: 28 }}>
        <Ring size={120} stroke={12} fraction={0.72} color={COLORS.green} t={t} class="welcome-ring" />
        <h2 style={{ fontSize: 26, letterSpacing: '-0.035em', margin: '0 0 8px', textWrap: 'balance' } as never}>Willkommen bei Whoop Plus</h2>
        <p class="muted" style={{ margin: '0 0 20px', fontSize: 15 }}>
          Dein WHOOP 4.0 – ohne Abo. Schlaf, HRV, Recovery und Strain werden direkt auf diesem iPhone berechnet.
        </p>
        <div class="btns">
          {!s.profile && <button class="btn" onClick={() => props.goTo('mehr')}><Icon name="user" /> 1. Profil ausfüllen</button>}
          {s.supported ? (
            <button class="btn primary" onClick={() => app.connect()}><Icon name="band" /> {s.profile ? 'Band verbinden' : '2. Band verbinden'}</button>
          ) : (
            <>
              <div class="note warn" style={{ textAlign: 'left' }}>
                Dieser Browser kann kein Bluetooth. Öffne die App auf dem iPhone in <b>Bluefy</b> (kostenlos im App Store). Safari unterstützt Web Bluetooth nicht.
              </div>
              <button class="btn primary" onClick={() => app.startDemo()}><Icon name="play" /> Demo starten</button>
            </>
          )}
        </div>
      </section>
      <div class="section-label">Vor dem ersten Verbinden</div>
      <section class="glass card">
        <FirstSteps />
      </section>
    </div>
  );
}
