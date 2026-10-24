import { useState } from 'preact/hooks';
import type { ExplainKey } from '../../analytics';
import { useTween } from '../anim';
import { GlassCard, Hypnogram, Icon, LineChart, Ring, Stat } from '../components';
import { ExplainSheet } from '../explain';
import { clock, COLORS, duration, durationShort, num } from '../format';
import { useApp, useDay, useMinuteHr } from '../hooks';
import { DayNav } from './DayNav';

export function Sleep(props: { date: string; setDate: (d: string) => void }) {
  return (
    <div>
      <DayNav date={props.date} setDate={props.setDate} />
      <SleepContent key={props.date} date={props.date} />
    </div>
  );
}

/** Schlafauswertung einer Nacht (Seite „Schlaf“ und Detailansicht). */
export function SleepContent(props: { date: string }) {
  const s = useApp();
  const day = useDay(props.date, s.dataVersion);
  const sleep = day?.sleep ?? null;
  const hr = useMinuteHr(sleep?.start ?? null, sleep?.end ?? null, s.dataVersion);
  const [topic, setTopic] = useState<ExplainKey | null>(null);
  const t = useTween(`${props.date}|${sleep ? sleep.start : 'x'}`, 1600, 100, day !== undefined);

  const need = (s.profile?.sleepNeedH ?? 8) * 60;
  const total = sleep ? Math.round((sleep.end - sleep.start) / 60) : 0;
  const perf = day?.sleepPerformance ?? null;

  if (!sleep) {
    return (
      <div class="note">
        {day === undefined ? 'Lade …' : 'Für diese Nacht wurde kein Schlaf erkannt. Es braucht mindestens 3 Stunden zusammenhängende Ruhe mit getragenem Band.'}
      </div>
    );
  }

  return (
    <>
      <section class="detail-hero">
        <Ring size={210} stroke={15} fraction={perf == null ? null : perf / 100} color={COLORS.sleep} t={t}>
          <div class="eyebrow">Schlafleistung</div>
          <div class="hero-value" style={{ fontSize: 62 }}>{perf == null ? '–' : Math.round(perf * t)}<small>%</small></div>
        </Ring>
        <div class="hero-state">{duration(sleep.asleepMin * t)} geschlafen</div>
        <div class="hero-sub">Bedarf {duration(need)} · {clock(sleep.start)} – {clock(sleep.end)}</div>
      </section>

      <GlassCard title="Verlauf" dot={COLORS.sleep} help={() => setTopic('sleep')}>
        <div class="row between small muted" style={{ marginBottom: 10 }}>
          <span class="row" style={{ gap: 6 }}><Icon name="moon" size={15} /> {clock(sleep.start)}</span>
          <span class="row" style={{ gap: 6 }}>{clock(sleep.end)} <Icon name="sun" size={15} /></span>
        </div>
        <Hypnogram epochs={sleep.epochs} start={sleep.start} end={sleep.end} animate labels={hourTicks(sleep.start, sleep.end)} />
        <div class="legend">
          <span><i style={{ background: COLORS.sleep }} />Schlaf</span>
          <span><i style={{ background: COLORS.yellow }} />Wach</span>
        </div>
        <div class="stats" style={{ marginTop: 14 }}>
          <Stat value={durationShort(total)} unit="h" label="Im Bett" />
          <Stat value={`${Math.round(sleep.efficiency * 100)}`} unit="%" label="Effizienz" />
          <Stat value={`${sleep.wakeEpisodes}`} unit="×" label="Wachphasen" sub={`${duration(sleep.awakeMin)} wach`} />
        </div>
      </GlassCard>

      <GlassCard title="Puls in der Nacht" dot={COLORS.hr} help={() => setTopic('restingHr')}>
        <LineChart
          height={140} gap={300} animate
          series={[{ points: hr.map((p) => ({ x: p.ts, y: p.hr })), color: COLORS.hr, fill: true }]}
          xLabels={hourTicks(sleep.start, sleep.end)}
        />
        <div class="stats" style={{ marginTop: 12 }}>
          <Stat value={num(sleep.restingHr)} unit="bpm" label="Ruhepuls" />
          <Stat value={num(sleep.hrvRmssd)} unit="ms" label="HRV (RMSSD)" />
          <Stat value={hr.length ? num(Math.max(...hr.map((p) => p.hr))) : '–'} unit="bpm" label="Max. Puls" />
        </div>
        <button class="linkbtn" style={{ marginTop: 12 }} onClick={() => setTopic('hrv')}><Icon name="info" /> Was bedeutet HRV?</button>
      </GlassCard>

      <div class="note small">
        Schlafphasen (Leicht/Tief/REM) zeigt die App bewusst nicht an: Aus Puls und Bewegung am Handgelenk lassen sie sich nur unzuverlässig schätzen.
      </div>

      {topic && <ExplainSheet topic={topic} onClose={() => setTopic(null)} />}
    </>
  );
}

export function hourTicks(start: number, end: number): { x: number; label: string }[] {
  const out: { x: number; label: string }[] = [];
  const span = end - start;
  const step = span > 8 * 3600 ? 2 * 3600 : 3600;
  const first = Math.ceil(start / 3600) * 3600;
  for (let t = first; t < end; t += step) out.push({ x: t, label: clock(t).slice(0, 2) });
  return out;
}
