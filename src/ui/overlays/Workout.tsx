import { useState } from 'preact/hooks';
import type { WorkoutRecord } from '../../analytics/workout';
import { useSmoothNumber, useTween } from '../anim';
import { GlassCard, Icon, LineChart, Ring, Stat } from '../components';
import { COLORS, dateTime, duration, hms, num, ZONE_COLORS, ZONE_NAMES, zoneColor } from '../format';
import { useApp, useStore } from '../hooks';
import { workout } from '../workout';

export function WorkoutScreen() {
  const w = useStore(workout);
  if (w.phase === 'summary' && w.summary) return <SummaryScreen w={w.summary} error={w.error} />;
  return <LiveScreen />;
}

function LiveScreen() {
  const w = useStore(workout);
  const s = useApp();
  const [confirm, setConfirm] = useState(false);
  const zc = zoneColor(w.zone);
  const strain = useSmoothNumber((w.stats?.strain ?? 0) * 10, 0.08) / 10;
  const kcal = useSmoothNumber(w.stats?.kcal ?? 0, 0.1);
  const paused = w.phase === 'paused';
  const beat = w.hr ? `${(60 / w.hr).toFixed(3)}s` : '1s';
  const pts = w.points.slice(-120).map((p) => ({ x: p.ts, y: p.hr }));

  return (
    <div class={`overlay workout overlay-enter ${paused ? 'paused' : ''}`} style={{ '--zc': zc } as never} role="dialog" aria-label="Workout">
      <div class="zone-bg" />
      <div class="zone-bg2" />
      <div class="content">
        <div class="w-top">
          <div>
            <div class="eyebrow" style={{ color: 'rgba(255,255,255,0.7)' }}>{paused ? 'Pausiert' : w.phase === 'starting' ? 'Startet …' : 'Workout'}</div>
            <div class="w-time">{hms(w.elapsedS)}</div>
          </div>
          <span class="pill" style={{ cursor: 'default', background: 'rgba(0,0,0,0.3)' }}>
            <span class={`dot ${w.linkLost ? 'err' : 'on'}`} />
            {w.linkLost ? 'Verbindung weg' : s.demo ? 'Demo' : 'Live'}
          </span>
        </div>

        <div class="w-center">
          <div class={`w-heart ${w.hr && !paused ? 'beat' : ''}`} style={{ '--beat': beat } as never}><Icon name="heart" size={54} /></div>
          <div class="w-hr">{w.hr ?? '–'}</div>
          <div class="small" style={{ color: 'rgba(255,255,255,0.7)', marginTop: 4, fontWeight: 600 }}>bpm</div>
          <div class="w-zone">{w.hr ? ZONE_NAMES[w.zone] : 'Warte auf Puls …'}</div>
          <div class="zone-scale" aria-hidden="true">
            {ZONE_COLORS.map((c, i) => <i key={c} class={w.zone === i + 1 ? 'on' : ''} style={{ background: c, color: c }} />)}
          </div>
        </div>

        {w.linkLost && <div class="banner">Verbindung zum Band verloren – es wird automatisch neu verbunden.</div>}

        <div class="w-stats">
          <div class="w-stat"><div class="v">{num(strain, 1)}</div><div class="k">Strain</div></div>
          <div class="w-stat"><div class="v">{num(Math.round(kcal))}</div><div class="k">kcal</div></div>
          <div class="w-stat"><div class="v">{num(w.stats?.avgHr)}</div><div class="k">Ø Puls</div></div>
          <div class="w-stat"><div class="v">{num(w.stats?.maxHr)}</div><div class="k">Max</div></div>
        </div>

        <div class="w-chart">
          <LineChart height={86} gap={20} lastDot series={[{ points: pts, color: '#ffffff', fill: true }]} empty="Puls-Verlauf erscheint gleich" />
        </div>

        <div class="w-ctrl">
          {paused ? (
            <button class="btn white" onClick={() => workout.resume()}><Icon name="play" /> Weiter</button>
          ) : (
            <button class="btn" disabled={w.phase !== 'active'} onClick={() => workout.pause()}><Icon name="pause" /> Pause</button>
          )}
          <button class="btn stop" disabled={w.phase === 'starting'} onClick={() => setConfirm(true)}><Icon name="stop" /> Beenden</button>
        </div>
      </div>

      {confirm && (
        <div class="confirm" onClick={() => setConfirm(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 6px', fontSize: 22, letterSpacing: '-0.03em' }}>Workout beenden?</h3>
            <p class="muted" style={{ margin: '0 0 18px', fontSize: 15 }}>{hms(w.elapsedS)} · Strain {num(w.stats?.strain, 1)} · {num(w.stats?.kcal)} kcal. Das Workout wird gespeichert.</p>
            <div class="btns two">
              <button class="btn" onClick={() => setConfirm(false)}>Weitermachen</button>
              <button class="btn" style={{ background: 'var(--red)', color: '#fff', borderColor: 'transparent' }} onClick={() => { setConfirm(false); void workout.stop(); }}>Beenden</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryScreen(props: { w: WorkoutRecord; error: string | null }) {
  return (
    <div class="overlay overlay-enter" role="dialog" aria-label="Workout-Zusammenfassung" style={{ overflowY: 'auto' }}>
      <div class="bg-glow" aria-hidden="true" style={{ ['--glow' as never]: COLORS.blue }}><div class="grain" /></div>
      <div class="detail-inner">
        <div class="eyebrow" style={{ marginTop: 8 }}>Workout beendet</div>
        <h2 style={{ fontSize: 32, letterSpacing: '-0.04em', margin: '2px 0 18px', fontWeight: 800 }}>Starke Leistung.</h2>
        {props.error && <div class="note err" style={{ marginBottom: 12 }}>{props.error}</div>}
        <WorkoutSummaryView w={props.w} />
        <button class="btn primary" style={{ marginTop: 6 }} onClick={() => workout.dismiss()}><Icon name="check" /> Fertig</button>
      </div>
    </div>
  );
}

/** Zusammenfassung eines Workouts (nach dem Beenden und in der Workout-Liste). */
export function WorkoutSummaryView(props: { w: WorkoutRecord }) {
  const w = props.w;
  const t = useTween(w.id, 1600, 150);
  const total = Math.max(1, w.zoneSeconds.reduce((a, b) => a + b, 0));
  const zoneMax = Math.max(1, ...w.zoneSeconds);
  const pts = w.hr.map((p) => ({ x: p.ts, y: p.hr }));
  const span = w.end - w.start;
  const step = span > 3 * 3600 ? 3600 : span > 3600 ? 1800 : span > 1200 ? 600 : 300;
  const labels: { x: number; label: string }[] = [];
  for (let x = w.start; x <= w.end; x += step) labels.push({ x, label: `${Math.round((x - w.start) / 60)}′` });
  return (
    <>
      <section class="glass card">
        <div class="row" style={{ gap: 18 }}>
          <Ring size={112} stroke={11} fraction={w.strain / 21} color={COLORS.blue} t={t}>
            <div class="mid" style={{ fontSize: 30 }}>{num(w.strain * t, 1)}</div>
            <div class="tiny faint" style={{ letterSpacing: '0.12em', fontWeight: 700 }}>STRAIN</div>
          </Ring>
          <div class="grow">
            <div class="small muted">{dateTime(w.start)}</div>
            <div class="big" style={{ marginTop: 4 }}>{hms(w.durationS)}</div>
            <div class="small muted" style={{ marginTop: 4 }}>{num(Math.round(w.kcal * t))} kcal</div>
          </div>
        </div>
        <div class="stats" style={{ marginTop: 16 }}>
          <Stat value={num(w.avgHr)} unit="bpm" label="Ø Puls" />
          <Stat value={num(w.maxHr)} unit="bpm" label="Max. Puls" />
          <Stat value={num(w.trimp, 0)} label="TRIMP" />
        </div>
      </section>

      <GlassCard title="Zonen">
        <div class="zones">
          {w.zoneSeconds.map((sec, i) => (
            <div class="zone" key={i}>
              <span class="zl">Zone {i + 1}</span>
              <div class="bar"><span style={{ width: `${(sec / zoneMax) * 100}%`, background: ZONE_COLORS[i], boxShadow: `0 0 8px ${ZONE_COLORS[i]}` }} /></div>
              <span class="zv">{sec >= 60 ? duration(sec / 60) : `${sec} s`}<span class="faint tiny"> {Math.round((sec / total) * 100)}%</span></span>
            </div>
          ))}
        </div>
      </GlassCard>

      <GlassCard title="Puls" dot={COLORS.hr}>
        <LineChart height={140} gap={20} animate series={[{ points: pts, color: COLORS.hr, fill: true }]} xLabels={labels} />
      </GlassCard>
    </>
  );
}
