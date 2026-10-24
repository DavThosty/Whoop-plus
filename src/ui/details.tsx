import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ExplainKey } from '../analytics';
import { dayBounds } from '../analytics';
import { reducedMotion, useTween } from './anim';
import { BarChart, GlassCard, Icon, LineChart, RangeBar, Ring, Stat } from './components';
import { ExplainSheet } from './explain';
import { flow, type DetailKind } from './flow';
import {
  addDays, clock, COLORS, dateLabel, duration, num, recoveryHex, recoveryState, shortDay, today, weekday, ZONE_COLORS,
} from './format';
import { useApp, useDay, useDays, useMinuteHr, usePrevious, useSelect, useWorkouts } from './hooks';
import { buildRecommendation, recoveryBreakdown, vitals } from './insights';
import { SleepContent } from './pages/Sleep';
import { WorkoutList } from './pages/Trends';
import { workout } from './workout';

const EASE = 'cubic-bezier(0.22, 0.9, 0.24, 1)';

/**
 * Vollbildansicht, die sich aus dem Rechteck der angetippten Karte öffnet (clip-path)
 * und beim Schließen dorthin zurückfährt.
 */
export function Expand(props: { rect: DOMRect | null; title: string; onClose: () => void; children: ComponentChildren; right?: ComponentChildren; glow?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);

  const clipFrom = () => {
    const r = props.rect;
    if (!r) return null;
    const vw = window.innerWidth, vh = window.innerHeight;
    return `inset(${Math.max(0, r.top)}px ${Math.max(0, vw - r.right)}px ${Math.max(0, vh - r.bottom)}px ${Math.max(0, r.left)}px round 24px)`;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== 'function') return;
    const from = clipFrom();
    if (from) {
      el.animate([{ clipPath: from, opacity: 0.6 }, { clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }], { duration: 560, easing: EASE });
    } else {
      el.animate([{ transform: 'translateY(40px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 450, easing: EASE });
    }
    inner.current?.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay: 120, easing: EASE, fill: 'backwards' });
  }, []);

  const close = () => {
    if (closing) return;
    setClosing(true);
    flow.beginExit();
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== 'function') {
      props.onClose();
      return;
    }
    const from = clipFrom();
    const a = from && el.scrollTop < 40
      ? el.animate([{ clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }, { clipPath: from, opacity: 0 }], { duration: 420, easing: EASE, fill: 'forwards' })
      : el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(30px)' }], { duration: 320, easing: EASE, fill: 'forwards' });
    a.onfinish = () => props.onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class="detail" ref={ref} role="dialog" aria-label={props.title}>
      <div class="bg-glow" aria-hidden="true" style={props.glow ? ({ '--glow': props.glow } as never) : undefined}><div class="grain" /></div>
      <div class="detail-inner" ref={inner}>
        <div class="detail-head">
          <button class="circle-btn" aria-label="Zurück" onClick={close}><Icon name="chevL" /></button>
          <h2>{props.title}</h2>
          {props.right}
        </div>
        {props.children}
      </div>
    </div>
  );
}

const TITLES: Record<DetailKind, string> = {
  recovery: 'Recovery',
  strain: 'Belastung',
  sleep: 'Schlaf',
  hrv: 'HRV',
  rhr: 'Ruhepuls',
};

const GLOWS: Partial<Record<DetailKind, string>> = { strain: COLORS.blue, sleep: COLORS.sleep, hrv: COLORS.green, rhr: COLORS.hr };

export function DetailView(props: { kind: DetailKind; date: string; rect: DOMRect | null }) {
  const label = dateLabel(props.date);
  return (
    <Expand rect={props.rect} title={`${TITLES[props.kind]}`} glow={GLOWS[props.kind]} onClose={() => flow.closeDetail()} right={<span class="pill" style={{ cursor: 'default' }}>{label}</span>}>
      {props.kind === 'recovery' && <RecoveryDetail date={props.date} />}
      {props.kind === 'strain' && <StrainDetail date={props.date} />}
      {props.kind === 'sleep' && <SleepContent date={props.date} />}
      {(props.kind === 'hrv' || props.kind === 'rhr') && <VitalsDetail date={props.date} focus={props.kind} />}
    </Expand>
  );
}

// ---------------------------------------------------------------------------

function RecoveryDetail(props: { date: string }) {
  const s = useApp();
  const day = useDay(props.date, s.dataVersion);
  const prev = usePrevious(props.date, s.dataVersion);
  const [topic, setTopic] = useState<ExplainKey | null>(null);
  const t = useTween(`${props.date}|${day?.recovery}`, 1600, 150, day !== undefined);
  const rec = day?.recovery ?? null;
  const color = recoveryHex(rec);
  const br = useMemo(() => recoveryBreakdown(day, prev), [day, prev]);
  const v = useMemo(() => vitals(day, prev), [day, prev]);
  const c = br?.components;
  const last14 = [...prev.slice(-13), ...(day ? [day] : [])];

  return (
    <>
      <section class="detail-hero">
        <Ring size={220} stroke={16} fraction={rec == null ? null : rec / 100} color={color} t={t}>
          <div class="eyebrow">Recovery</div>
          <div class="hero-value" style={{ fontSize: 66 }}>{rec == null ? '–' : Math.round(rec * t)}{rec != null && <small>%</small>}</div>
        </Ring>
        <div class="hero-state" style={{ color: rec == null ? 'var(--text)' : color }}>{recoveryState(day)}</div>
      </section>

      {rec == null && day && (
        <div class="note warn" style={{ marginBottom: 12 }}>
          {day.baselineNights < 4
            ? `Die Recovery braucht mindestens 4 Nächte mit HRV und Ruhepuls als Vergleichsbasis. Bisher: ${day.baselineNights}.`
            : 'Für diese Nacht fehlen HRV oder Ruhepuls – deshalb keine Recovery.'}
        </div>
      )}

      {c && (
        <GlassCard title="Was die Recovery bestimmt" help={() => setTopic('recovery')}>
          {(() => {
            const scale = Math.max(0.3, Math.abs(c.contributions.hrv), Math.abs(c.contributions.rhr), Math.abs(c.contributions.sleep)) * 1.1;
            return (
              <>
                <Contribution label="HRV" weight="60 %" value={c.contributions.hrv} scale={scale} />
                <Contribution label="Ruhepuls" weight="25 %" value={c.contributions.rhr} scale={scale} />
                <Contribution label="Schlaf" weight="15 %" value={c.contributions.sleep} scale={scale} />
              </>
            );
          })()}
          <div class="small faint" style={{ marginTop: 12 }}>
            Balken nach rechts heben die Recovery, nach links senken sie. Gewichteter Beitrag der Abweichung vom persönlichen Normalwert (z-Wert × Gewicht).
          </div>
        </GlassCard>
      )}

      {day && (
        <GlassCard title="Heute vs. Normalwert">
          <div class="stats">
            <Stat value={num(v.hrv)} unit="ms" label="HRV" sub={`Normal ${num(v.hrvTypical)}`} />
            <Stat value={num(v.rhr)} unit="bpm" label="Ruhepuls" sub={`Normal ${num(v.rhrMean)}`} />
            <Stat value={day.sleepPerformance == null ? '–' : `${Math.round(day.sleepPerformance)}`} unit="%" label="Schlaf" sub="Referenz 85" />
          </div>
          <div class="small faint" style={{ marginTop: 10 }}>Baseline aus {br?.baselineNights ?? day.baselineNights} Nächten.</div>
        </GlassCard>
      )}

      <GlassCard title="Letzte 14 Tage">
        <BarChart
          max={100} height={130}
          bars={last14.map((d) => ({ label: weekday(d.date), value: d.recovery, color: recoveryHex(d.recovery) }))}
        />
      </GlassCard>

      <button class="btn" onClick={() => setTopic('recovery')}><Icon name="info" /> Wie wird die Recovery berechnet?</button>
      {topic && <ExplainSheet topic={topic} onClose={() => setTopic(null)} />}
    </>
  );
}

function Contribution(props: { label: string; weight: string; value: number; scale: number }) {
  const max = props.scale;
  const w = Math.min(50, (Math.abs(props.value) / max) * 50);
  const pos = props.value >= 0;
  const color = pos ? COLORS.green : COLORS.red;
  return (
    <div class="contrib">
      <div><div style={{ fontWeight: 650 }}>{props.label}</div><div class="tiny faint">Gewicht {props.weight}</div></div>
      <div class="track">
        <span style={{
          left: pos ? '50%' : `${50 - w}%`, width: `${Math.max(1.5, w)}%`, background: color, boxShadow: `0 0 10px ${color}`,
          transformOrigin: pos ? 'left' : 'right',
        }} />
      </div>
      <div class="cv" style={{ color }}>{pos ? '+' : '−'}{num(Math.abs(props.value), 2)}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StrainDetail(props: { date: string }) {
  const s = useApp();
  const wVersion = useSelect(workout, (x) => x.version);
  const day = useDay(props.date, s.dataVersion);
  const prev = usePrevious(props.date, s.dataVersion);
  const [topic, setTopic] = useState<ExplainKey | null>(null);
  const b = dayBounds(props.date);
  const isToday = props.date === today();
  // Fester Bereich (ganzer Tag): neu geladen wird nur, wenn sich die Daten ändern (dataVersion).
  const hr = useMinuteHr(b.start, b.end, s.dataVersion);
  const t = useTween(`${props.date}|${day ? 1 : 0}`, 1600, 150, day !== undefined);
  const reco = useMemo(() => (isToday ? buildRecommendation(day, prev, s.profile) : null), [isToday, day, prev, s.profile]);
  const zoneMax = Math.max(1, ...(day?.zoneMinutes ?? [0]));
  const workouts = (useWorkouts(wVersion) ?? []).filter((x) => x.start >= b.start && x.start < b.end);
  const labels = [0, 6, 12, 18].map((h) => ({ x: b.start + h * 3600, label: `${String(h).padStart(2, '0')}` }));
  const strain = day?.strain ?? null;

  return (
    <>
      <section class="detail-hero">
        <Ring size={220} stroke={16} fraction={strain == null ? null : strain / 21} color={COLORS.blue} t={t}>
          <div class="eyebrow">Strain</div>
          <div class="hero-value" style={{ fontSize: 66 }}>{strain == null ? '–' : num(strain * t, 1)}</div>
        </Ring>
        <div class="hero-state">{reco ? `Ziel heute ${reco.strainRange[0]}–${reco.strainRange[1]}` : isToday ? 'Belastung bisher' : 'Belastung des Tages'}</div>
        <div style={{ width: '100%', maxWidth: 320, marginTop: 6 }}>
          <RangeBar value={strain} range={reco?.strainRange ?? null} t={t} legend={!!reco} />
        </div>
      </section>

      {day && (
        <GlassCard title="Herzfrequenzzonen" help={() => setTopic('strain')}>
          <div class="zones">
            {day.zoneMinutes.map((m, i) => (
              <div class="zone" key={i}>
                <span class="zl">Zone {i + 1}</span>
                <div class="bar"><span style={{ width: `${(m / zoneMax) * 100}%`, background: ZONE_COLORS[i], boxShadow: `0 0 8px ${ZONE_COLORS[i]}` }} /></div>
                <span class="zv">{duration(m)}</span>
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      <GlassCard title="Puls über den Tag" dot={COLORS.hr}>
        <LineChart height={150} gap={300} animate series={[{ points: hr.map((p) => ({ x: p.ts, y: p.hr })), color: COLORS.hr, fill: true }]} xLabels={labels} />
      </GlassCard>

      {day && (
        <GlassCard title="Energie & Puls" help={() => setTopic('calories')}>
          <div class="stats">
            <Stat value={num(day.kcal)} unit="kcal" label="Energie" />
            <Stat value={num(day.avgHr)} unit="bpm" label="Ø Puls wach" />
            <Stat value={num(day.maxHr)} unit="bpm" label="Max. Puls" />
          </div>
          <div class="small faint" style={{ marginTop: 10 }}>
            Datenabdeckung {duration(day.coveredMin)} · berechnet {clock(day.computedAt / 1000)}
          </div>
        </GlassCard>
      )}

      {workouts.length > 0 && (
        <>
          <div class="section-label">Workouts</div>
          <WorkoutList list={workouts} />
        </>
      )}

      {topic && <ExplainSheet topic={topic} onClose={() => setTopic(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------

function VitalsDetail(props: { date: string; focus: 'hrv' | 'rhr' }) {
  const s = useApp();
  const day = useDay(props.date, s.dataVersion);
  const prev = usePrevious(props.date, s.dataVersion);
  const days = useDays(addDays(props.date, -29), props.date, s.dataVersion);
  const [topic, setTopic] = useState<ExplainKey | null>(null);
  const v = useMemo(() => vitals(day, prev), [day, prev]);
  const idx = (d: string) => Math.round((Date.parse(`${d}T12:00:00`) - Date.parse(`${props.date}T12:00:00`)) / 86400000);
  const hrvPts = days.filter((d) => d.sleep?.hrvRmssd).map((d) => ({ x: idx(d.date), y: d.sleep!.hrvRmssd! }));
  const rhrPts = days.filter((d) => d.sleep?.restingHr).map((d) => ({ x: idx(d.date), y: d.sleep!.restingHr! }));
  const labels = [-28, -21, -14, -7, 0].map((x) => ({ x, label: x === 0 ? dateLabel(props.date) : shortDay(addDays(props.date, x)) }));

  const hrvCard = (
    <GlassCard key="hrv" title="HRV · 30 Tage" dot={COLORS.green} help={() => setTopic('hrv')}>
      <div class="row between" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
        <div class="big">{num(v.hrv)}<span class="unit">ms</span></div>
        <div class="small muted" style={{ textAlign: 'right' }}>Normal {num(v.hrvTypical)} ms<br />{v.hrvDeltaPct != null ? `${v.hrvDeltaPct >= 0 ? '+' : '−'}${num(Math.abs(v.hrvDeltaPct))} %` : ''}</div>
      </div>
      <LineChart height={150} gap={1.5} lastDot animate band={v.hrvBand ? { ...v.hrvBand, color: COLORS.green } : undefined}
        series={[{ points: hrvPts, color: COLORS.green, fill: true }]} xLabels={labels} />
      <div class="legend"><span><i style={{ background: 'rgba(22,236,6,0.3)' }} />Normalbereich (± 1 SD)</span></div>
    </GlassCard>
  );
  const rhrCard = (
    <GlassCard key="rhr" title="Ruhepuls · 30 Tage" dot={COLORS.hr} help={() => setTopic('restingHr')}>
      <div class="row between" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
        <div class="big">{num(v.rhr)}<span class="unit">bpm</span></div>
        <div class="small muted" style={{ textAlign: 'right' }}>Normal {num(v.rhrMean)} bpm<br />{v.rhrDelta != null ? `${v.rhrDelta >= 0 ? '+' : '−'}${num(Math.abs(v.rhrDelta))} bpm` : ''}</div>
      </div>
      <LineChart height={150} gap={1.5} lastDot animate band={v.rhrBand ? { ...v.rhrBand, color: COLORS.hr } : undefined}
        series={[{ points: rhrPts, color: COLORS.hr, fill: true }]} xLabels={labels} />
      <div class="legend"><span><i style={{ background: 'rgba(255,77,109,0.3)' }} />Normalbereich (± 1 SD)</span></div>
    </GlassCard>
  );
  return (
    <>
      <div class="note small" style={{ marginBottom: 12 }}>
        {props.focus === 'hrv'
          ? 'Eine höhere HRV als üblich spricht für gute Erholung. Entscheidend ist dein persönlicher Trend, nicht der absolute Wert.'
          : 'Ein niedrigerer Ruhepuls als üblich spricht für gute Erholung. Ein erhöhter Wert kann auf Stress, Alkohol oder eine beginnende Erkältung hinweisen.'}
      </div>
      {props.focus === 'hrv' ? [hrvCard, rhrCard] : [rhrCard, hrvCard]}
      {topic && <ExplainSheet topic={topic} onClose={() => setTopic(null)} />}
    </>
  );
}
