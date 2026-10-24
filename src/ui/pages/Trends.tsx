import { useState } from 'preact/hooks';
import type { DailySummary } from '../../types';
import { BarChart, Card, LineChart, Stat } from '../components';
import { addDays, num, recoveryColor, shortDay, today, weekday } from '../format';
import { useApp, useDays } from '../hooks';

export function Trends() {
  const s = useApp();
  const [range, setRange] = useState(7);
  const to = today();
  const from = addDays(to, -(range - 1));
  const days = useDays(from, to, s.dataVersion);

  // Lückenlose Tagesliste, damit fehlende Tage als Lücke sichtbar bleiben.
  const byDate = new Map(days.map((d) => [d.date, d]));
  const dates = Array.from({ length: range }, (_, i) => addDays(from, i));
  const label = (d: string) => (range <= 7 ? weekday(d) : shortDay(d));
  const pick = (fn: (d: DailySummary) => number | null | undefined) =>
    dates.map((d) => {
      const day = byDate.get(d);
      const v = day ? fn(day) : null;
      return v == null || !Number.isFinite(v) ? null : v;
    });

  const recovery = pick((d) => d.recovery);
  const strain = pick((d) => d.strain);
  const sleepH = pick((d) => (d.sleep ? d.sleep.asleepMin / 60 : null));
  const hrv = pick((d) => d.sleep?.hrvRmssd);
  const rhr = pick((d) => d.sleep?.restingHr);

  const line = (vals: (number | null)[]) =>
    vals.flatMap((v, i) => (v == null ? [] : [{ x: i, y: v }]));
  const xLabels = dates
    .map((d, i) => ({ x: i, label: label(d) }))
    .filter((_, i) => range <= 7 || i % Math.ceil(range / 8) === 0);

  return (
    <div>
      <div class="seg" style={{ marginBottom: 12 }}>
        {[7, 30, 90].map((r) => (
          <button key={r} class={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r} Tage</button>
        ))}
      </div>

      <Card title="Durchschnitt">
        <div class="stats">
          <Stat value={num(avg(recovery))} unit="%" label="Recovery" />
          <Stat value={num(avg(strain), 1)} label="Strain" />
          <Stat value={num(avg(sleepH), 1)} unit="h" label="Schlaf" />
        </div>
      </Card>

      <Card title="Recovery">
        <BarChart max={100} bars={dates.map((d, i) => ({ label: label(d), value: recovery[i], color: recoveryColor(recovery[i]) }))} />
      </Card>

      <Card title="Strain">
        <BarChart max={21} format={(v) => num(v, 1)} bars={dates.map((d, i) => ({ label: label(d), value: strain[i], color: 'var(--blue)' }))} />
      </Card>

      <Card title="Schlafdauer">
        <BarChart max={Math.max(10, ...sleepH.map((v) => v ?? 0))} format={(v) => num(v, 1)} bars={dates.map((d, i) => ({ label: label(d), value: sleepH[i], color: 'var(--sleep)' }))} />
      </Card>

      <Card title="HRV & Ruhepuls">
        <div class="small muted">HRV (ms)</div>
        <LineChart height={110} gap={1.5} series={[{ points: line(hrv), color: 'var(--green)' }]} xLabels={xLabels} />
        <div class="small muted" style={{ marginTop: 8 }}>Ruhepuls (bpm)</div>
        <LineChart height={110} gap={1.5} series={[{ points: line(rhr), color: 'var(--hr)' }]} xLabels={xLabels} />
      </Card>
    </div>
  );
}

function avg(vals: (number | null)[]): number | null {
  const v = vals.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
