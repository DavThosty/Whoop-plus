// Navigationsleiste „Zonen-Halo“: zwei Glasinseln mit Mini-Ringen und Sparkline, dazwischen ein
// adaptiver Halo-Knopf (Workout starten / Live-Puls mit Zone / laufendes Workout öffnen).
import { useEffect, useState } from 'preact/hooks';
import { resolveRhr } from '../analytics';
import { workoutZone } from '../analytics/workout';
import type { LiveHr } from '../types';
import { Icon } from './components';
import { app } from './controller';
import { flow } from './flow';
import { addDays, COLORS, recoveryHex, today, ZONE_COLORS, zoneColor } from './format';
import { useDays, useSelect } from './hooks';
import { workout } from './workout';

export type NavTab = 'heute' | 'schlaf' | 'trends' | 'mehr';

/** Live-Puls, höchstens einmal pro Sekunde aktualisiert; ohne frische Messung (6 s) null. */
function useThrottledHr(enabled: boolean): number | null {
  const [hr, setHr] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) {
      setHr(null);
      return;
    }
    let last = 0;
    let pending: number | null = null;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let stale: ReturnType<typeof setTimeout> | null = null;
    const push = (v: number | null) => {
      last = Date.now();
      setHr(v);
    };
    const onLive = (l: LiveHr) => {
      const v = l.hr > 0 && l.wearing ? Math.round(l.hr) : null;
      if (stale) clearTimeout(stale);
      stale = setTimeout(() => push(null), 6000);
      const wait = 1000 - (Date.now() - last);
      if (wait <= 0) push(v);
      else {
        pending = v;
        if (!trailing) trailing = setTimeout(() => { trailing = null; push(pending); }, wait);
      }
    };
    const off = app.subscribeLive(onLive);
    return () => {
      off();
      if (trailing) clearTimeout(trailing);
      if (stale) clearTimeout(stale);
    };
  }, [enabled]);
  return enabled ? hr : null;
}

const R = 14.5;
const C = 2 * Math.PI * R;

function MiniRing(props: { value: number | null; color: string; active: boolean }) {
  const f = props.value == null ? 0 : Math.max(0, Math.min(1, props.value / 100));
  return (
    <div class="nring">
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r={R} stroke="rgba(255,255,255,0.1)" stroke-width="4" fill="none" />
        <circle
          class="arc" cx="18" cy="18" r={R} stroke={props.color} stroke-width="4" fill="none" stroke-linecap="round"
          stroke-dasharray={`${(C * f).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 18 18)"
          style={{ opacity: f > 0 ? 1 : 0, filter: props.active && f > 0 ? `drop-shadow(0 0 5px ${props.color})` : undefined }}
        />
      </svg>
      <span>{props.value == null ? '–' : Math.round(props.value)}</span>
    </div>
  );
}

function Spark(props: { values: (number | null)[]; active: boolean }) {
  return (
    <div class={`nspark ${props.active ? 'on' : ''}`} aria-hidden="true">
      {props.values.map((v, i) => (
        <i key={i} style={v == null
          ? { height: 3, background: 'rgba(255,255,255,0.14)' }
          : { height: Math.max(4, Math.round((v / 100) * 20)), background: recoveryHex(v), boxShadow: props.active ? `0 0 5px ${recoveryHex(v)}` : undefined }} />
      ))}
    </div>
  );
}

function Tab(props: { id: NavTab; tab: NavTab; setTab: (t: NavTab) => void; label: string; aria: string; children: preact.ComponentChildren }) {
  const on = props.tab === props.id;
  return (
    <button class={`ntab ${on ? 'on' : ''}`} onClick={() => props.setTab(props.id)} aria-current={on ? 'page' : undefined} aria-label={props.aria}>
      {props.children}
      <span class="nlbl">{props.label}</span>
    </button>
  );
}

export function NavBar(props: { tab: NavTab; setTab: (t: NavTab) => void; hidden?: boolean }) {
  const s = useSelect(app, (a) => ({ conn: a.conn, liveOn: a.liveOn, dataVersion: a.dataVersion, maxHr: a.profile?.maxHr ?? 190 }));
  const wPhase = useSelect(workout, (w) => w.phase);
  const t = today();
  const days = useDays(addDays(t, -6), t, s.dataVersion);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const todayDay = byDate.get(t) ?? null;
  const spark = Array.from({ length: 7 }, (_, i) => byDate.get(addDays(t, i - 6))?.recovery ?? null);
  const rhr = resolveRhr(todayDay?.sleep?.restingHr, ...[...days].reverse().map((d) => d.sleep?.restingHr));

  const linked = s.conn === 'connected' || s.conn === 'syncing';
  const running = wPhase !== 'idle';
  const hr = useThrottledHr(linked && s.liveOn);
  const zone = workoutZone(hr, rhr, s.maxHr);
  const showHr = linked && hr != null;

  const rec = todayDay?.recovery ?? null;
  const perf = todayDay?.sleepPerformance ?? null;

  const centerLabel = running
    ? `Workout öffnen${showHr ? `, Puls ${hr}, ${zone ? `Zone ${zone}` : 'Ruhe'}` : ''}`
    : `Workout starten${showHr ? `, Puls ${hr}, ${zone ? `Zone ${zone}` : 'Ruhe'}` : ''}`;
  const onCenter = () => {
    if (running) workout.restore();
    else void flow.startWorkout();
  };

  // Halo: 5 Zonensegmente; die aktuelle Zone hervorgehoben.
  const HR_R = 40;
  const HC = 2 * Math.PI * HR_R;
  const seg = HC / 5;
  const gap = 6;
  const beat = showHr ? `${(60 / hr!).toFixed(3)}s` : undefined;

  return (
    <nav class="navbar" aria-label="Navigation" style={props.hidden ? { visibility: 'hidden' } : undefined}>
      <div class="isl">
        <Tab id="heute" tab={props.tab} setTab={props.setTab} label="Heute" aria={`Heute, Recovery ${rec == null ? 'unbekannt' : `${rec} Prozent`}`}>
          <MiniRing value={rec} color={rec == null ? COLORS.neutral : recoveryHex(rec)} active={props.tab === 'heute'} />
        </Tab>
        <Tab id="schlaf" tab={props.tab} setTab={props.setTab} label="Schlaf" aria={`Schlaf, Leistung ${perf == null ? 'unbekannt' : `${Math.round(perf)} Prozent`}`}>
          <MiniRing value={perf} color={COLORS.sleep} active={props.tab === 'schlaf'} />
        </Tab>
      </div>

      <button class={`halo ${linked ? 'linked' : ''} ${running ? 'running' : ''}`} onClick={onCenter} aria-label={centerLabel}>
        <svg viewBox="0 0 90 90" aria-hidden="true">
          {ZONE_COLORS.map((c, i) => {
            const on = showHr && zone === i + 1;
            return (
              <circle
                key={c} cx="45" cy="45" r={HR_R} fill="none" stroke={linked ? c : 'rgba(255,255,255,0.22)'}
                stroke-width={on ? 7 : 4} stroke-linecap="round"
                stroke-dasharray={`${(seg - gap).toFixed(2)} ${HC.toFixed(2)}`}
                transform={`rotate(${(-180 + 72 * i + (gap / HC) * 180).toFixed(2)} 45 45)`}
                opacity={on ? 1 : linked ? 0.38 : 0.6}
                style={on ? { filter: `drop-shadow(0 0 6px ${c})` } : undefined}
                class="hseg"
              />
            );
          })}
        </svg>
        <div class={`disc ${showHr ? 'beat' : ''}`} style={beat ? ({ '--beat': beat } as never) : undefined}>
          {showHr ? (
            <>
              <b>{hr}</b>
              <span style={{ color: zone ? zoneColor(zone) : 'var(--text-3)' }}>{zone ? `ZONE ${zone}` : 'RUHE'}</span>
            </>
          ) : (
            <>
              <Icon name="bolt" size={24} />
              <span>{running ? 'LÄUFT' : 'WORKOUT'}</span>
            </>
          )}
        </div>
      </button>

      <div class="isl">
        <Tab id="trends" tab={props.tab} setTab={props.setTab} label="Trends" aria="Trends, Recovery der letzten 7 Tage">
          <div class="nicon"><Spark values={spark} active={props.tab === 'trends'} /></div>
        </Tab>
        <Tab id="mehr" tab={props.tab} setTab={props.setTab} label="Mehr" aria="Mehr: Band, Profil und Daten">
          <div class="nicon"><Icon name="dots" size={24} /></div>
        </Tab>
      </div>
    </nav>
  );
}
