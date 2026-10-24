import { useState } from 'preact/hooks';
import type { ExplainKey } from '../../analytics';
import { Card, Hypnogram, LineChart, Stat } from '../components';
import { ExplainSheet } from '../explain';
import { clock, duration, num } from '../format';
import { useApp, useDay, useMinuteHr } from '../hooks';
import { DayNav } from './DayNav';

export function Sleep(props: { date: string; setDate: (d: string) => void }) {
  const s = useApp();
  const day = useDay(props.date, s.dataVersion);
  const sleep = day?.sleep ?? null;
  const hr = useMinuteHr(sleep?.start ?? null, sleep?.end ?? null, s.dataVersion);
  const [topic, setTopic] = useState<ExplainKey | null>(null);

  const need = (s.profile?.sleepNeedH ?? 8) * 60;
  const total = sleep ? Math.round((sleep.end - sleep.start) / 60) : 0;
  const hourLabels = sleep ? hourTicks(sleep.start, sleep.end) : [];

  return (
    <div>
      <DayNav date={props.date} setDate={props.setDate} />

      {!sleep && (
        <div class="note">
          {day === undefined ? 'Lade …' : 'Für diese Nacht wurde kein Schlaf erkannt. Es braucht mindestens 3 Stunden zusammenhängende Ruhe mit getragenem Band.'}
        </div>
      )}

      {sleep && (
        <>
          <Card title="Schlaf" help={() => setTopic('sleep')}>
            <div class="row between" style={{ alignItems: 'flex-end' }}>
              <div>
                <div class="big">{duration(sleep.asleepMin)}</div>
                <div class="muted small">geschlafen von {duration(need)} Bedarf</div>
              </div>
              <div class="center">
                <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--sleep)' }}>{Math.round(day?.sleepPerformance ?? 0)}%</div>
                <div class="muted small">Schlafleistung</div>
              </div>
            </div>
            <div class="zone" style={{ gridTemplateColumns: '1fr', marginTop: 12 }}>
              <div class="bar" style={{ height: 10 }}>
                <span style={{ width: `${Math.min(100, (sleep.asleepMin / need) * 100)}%`, background: 'var(--sleep)' }} />
              </div>
            </div>
          </Card>

          <Card title="Verlauf">
            <div class="row between small muted" style={{ marginBottom: 6 }}>
              <span>🌙 {clock(sleep.start)}</span>
              <span>☀️ {clock(sleep.end)}</span>
            </div>
            <Hypnogram epochs={sleep.epochs} start={sleep.start} end={sleep.end} />
            <div class="legend">
              <span><i style={{ background: 'var(--sleep)' }} />Schlaf</span>
              <span><i style={{ background: 'var(--yellow)' }} />Wach</span>
            </div>
            <div class="stats" style={{ marginTop: 12 }}>
              <Stat value={duration(total)} label="Im Bett" />
              <Stat value={`${Math.round(sleep.efficiency * 100)}`} unit="%" label="Effizienz" />
              <Stat value={`${sleep.wakeEpisodes}`} unit="×" label={`Wach (${duration(sleep.awakeMin)})`} />
            </div>
          </Card>

          <Card title="Puls in der Nacht" help={() => setTopic('restingHr')}>
            <LineChart
              height={130}
              gap={300}
              series={[{ points: hr.map((p) => ({ x: p.ts, y: p.hr })), color: 'var(--hr)', fill: true }]}
              xLabels={hourLabels}
            />
            <div class="stats" style={{ marginTop: 10 }}>
              <Stat value={num(sleep.restingHr)} unit="bpm" label="Ruhepuls" />
              <Stat value={num(sleep.hrvRmssd)} unit="ms" label="HRV (RMSSD)" />
              <Stat value={hr.length ? num(Math.max(...hr.map((p) => p.hr))) : '–'} unit="bpm" label="Max. Puls" />
            </div>
            <div class="small muted" style={{ marginTop: 8 }}>
              <button class="muted small" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setTopic('hrv')}>
                Was bedeutet HRV?
              </button>
            </div>
          </Card>

          <div class="note small">
            Schlafphasen (Leicht/Tief/REM) zeigt die App bewusst nicht an: Aus Puls und Bewegung am Handgelenk lassen sie sich nur unzuverlässig schätzen.
          </div>
        </>
      )}

      {topic && <ExplainSheet topic={topic} onClose={() => setTopic(null)} />}
    </div>
  );
}

function hourTicks(start: number, end: number): { x: number; label: string }[] {
  const out: { x: number; label: string }[] = [];
  const span = end - start;
  const step = span > 8 * 3600 ? 2 * 3600 : 3600;
  const first = Math.ceil(start / 3600) * 3600;
  for (let t = first; t < end; t += step) out.push({ x: t, label: clock(t).slice(0, 2) });
  return out;
}
