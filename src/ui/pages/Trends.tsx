import { useState } from 'preact/hooks';
import type { WorkoutRecord } from '../../analytics/workout';
import { deleteWorkout } from '../../store/db';
import type { DailySummary } from '../../types';
import { BarChart, GlassCard, Icon, LineChart, Stat } from '../components';
import { Expand } from '../details';
import { flow } from '../flow';
import { addDays, COLORS, dateTime, hms, num, recoveryHex, shortDay, today, weekday } from '../format';
import { useApp, useDays, useSelect, useWorkouts } from '../hooks';
import { WorkoutSummaryView } from '../overlays/Workout';
import { workout } from '../workout';

export function Trends() {
  const s = useApp();
  const wVersion = useSelect(workout, (x) => x.version);
  const [range, setRange] = useState(7);
  const to = today();
  const from = addDays(to, -(range - 1));
  const days = useDays(from, to, s.dataVersion);
  const workouts = useWorkouts(wVersion);

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

  const line = (vals: (number | null)[]) => vals.flatMap((v, i) => (v == null ? [] : [{ x: i, y: v }]));
  const xLabels = dates
    .map((d, i) => ({ x: i, label: label(d) }))
    .filter((_, i) => range <= 7 || i % Math.ceil(range / 6) === 0);
  const avgRec = avg(recovery);

  return (
    <div>
      <div class="seg" style={{ marginBottom: 16 }}>
        {[7, 30, 90].map((r) => (
          <button key={r} class={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r} Tage</button>
        ))}
      </div>

      <GlassCard title="Durchschnitt">
        <div class="stats">
          <div class="stat"><div class="v" style={{ color: avgRec == null ? undefined : recoveryHex(avgRec) }}>{num(avgRec)}<small>%</small></div><div class="k">Recovery</div></div>
          <Stat value={num(avg(strain), 1)} label="Strain" />
          <Stat value={num(avg(sleepH), 1)} unit="h" label="Schlaf" />
        </div>
      </GlassCard>

      <GlassCard title="Recovery" dot={COLORS.green}>
        <BarChart max={100} bars={dates.map((d, i) => ({ label: label(d), value: recovery[i], color: recoveryHex(recovery[i]) }))} />
      </GlassCard>

      <GlassCard title="Strain" dot={COLORS.blue}>
        <BarChart max={21} format={(v) => num(v, 1)} bars={dates.map((d, i) => ({ label: label(d), value: strain[i], color: COLORS.blue }))} />
      </GlassCard>

      <GlassCard title="Schlafdauer" dot={COLORS.sleep}>
        <BarChart max={Math.max(10, ...sleepH.map((v) => v ?? 0))} format={(v) => num(v, 1)} bars={dates.map((d, i) => ({ label: label(d), value: sleepH[i], color: COLORS.sleep }))} />
      </GlassCard>

      <GlassCard title="HRV & Ruhepuls">
        <div class="small muted" style={{ marginBottom: 4 }}>HRV (ms)</div>
        <LineChart height={110} gap={1.5} lastDot series={[{ points: line(hrv), color: COLORS.green, fill: true }]} xLabels={xLabels} />
        <div class="small muted" style={{ margin: '12px 0 4px' }}>Ruhepuls (bpm)</div>
        <LineChart height={110} gap={1.5} lastDot series={[{ points: line(rhr), color: COLORS.hr, fill: true }]} xLabels={xLabels} />
      </GlassCard>

      <div class="section-label" id="workouts">Workouts{workouts && workouts.length > 0 ? ` · ${workouts.length}` : ''}</div>
      {workouts && workouts.length > 0 ? (
        <WorkoutList list={workouts} />
      ) : (
        <section class="glass card center">
          <div class="muted" style={{ marginBottom: 14 }}>Noch keine Workouts aufgezeichnet.</div>
          <button class="btn primary" onClick={() => void flow.startWorkout()}><Icon name="bolt" /> Workout starten</button>
        </section>
      )}
    </div>
  );
}

/** Liste gespeicherter Workouts; Antippen öffnet die Detailansicht. */
export function WorkoutList(props: { list: WorkoutRecord[] }) {
  const [open, setOpen] = useState<{ w: WorkoutRecord; rect: DOMRect } | null>(null);
  return (
    <>
      <section class="glass" style={{ marginBottom: 12, overflow: 'hidden' }}>
        {props.list.map((w) => (
          <div
            key={w.id} class="wo-row tap" role="button" tabIndex={0}
            onClick={(e) => setOpen({ w, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
          >
            <div class="wo-badge" style={{ background: 'rgba(0,147,231,0.16)', color: '#5cc4ff', boxShadow: 'inset 0 0 0 1px rgba(0,147,231,0.35)' }}>
              {num(w.strain, 1)}
            </div>
            <div class="grow">
              <div style={{ fontWeight: 650 }}>{dateTime(w.start)}</div>
              <div class="small muted">{hms(w.durationS)} · {num(w.kcal)} kcal · Ø {num(w.avgHr)} bpm</div>
            </div>
            <Icon name="chevR" class="chev" size={16} />
          </div>
        ))}
      </section>
      {open && <WorkoutDetail w={open.w} rect={open.rect} onClose={() => setOpen(null)} />}
    </>
  );
}

function WorkoutDetail(props: { w: WorkoutRecord; rect: DOMRect; onClose: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Expand rect={props.rect} title="Workout" onClose={props.onClose}>
      <WorkoutSummaryView w={props.w} />
      {confirm ? (
        <div class="btns two" style={{ marginTop: 12 }}>
          <button class="btn" onClick={() => setConfirm(false)}>Behalten</button>
          <button class="btn danger" onClick={async () => {
            await deleteWorkout(props.w.id);
            workout.bumpVersion();
            props.onClose();
          }}>Endgültig löschen</button>
        </div>
      ) : (
        <button class="btn danger" style={{ marginTop: 12 }} onClick={() => setConfirm(true)}><Icon name="trash" /> Workout löschen</button>
      )}
    </Expand>
  );
}

function avg(vals: (number | null)[]): number | null {
  const v = vals.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
