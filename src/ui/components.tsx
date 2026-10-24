import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';

/** Fortschrittsring wie in der Whoop-App. `fraction` 0–1. */
export function Ring(props: {
  fraction: number | null;
  color: string;
  value: string;
  sub?: string;
  label: string;
  onClick?: () => void;
}) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const f = props.fraction == null ? 0 : Math.max(0, Math.min(1, props.fraction));
  return (
    <button class="ring" onClick={props.onClick} aria-label={`${props.label}: ${props.value}`}>
      <svg viewBox="0 0 110 110">
        <circle cx="55" cy="55" r={r} fill="none" stroke="#22262d" stroke-width="9" />
        <circle
          cx="55" cy="55" r={r} fill="none" stroke={props.color} stroke-width="9" stroke-linecap="round"
          stroke-dasharray={`${c * f} ${c}`} transform="rotate(-90 55 55)"
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
        <text x="55" y={props.sub ? 56 : 62} text-anchor="middle" class="ring-value" font-size="24">{props.value}</text>
        {props.sub && <text x="55" y="74" text-anchor="middle" class="ring-sub" font-size="11">{props.sub}</text>}
      </svg>
      <span class="ring-label">{props.label}</span>
    </button>
  );
}

export function Card(props: { title?: string; help?: () => void; children: ComponentChildren }) {
  return (
    <section class="card">
      {props.title && (
        <h2>
          {props.title}
          {props.help && (
            <button class="help muted small" style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }} onClick={props.help}>
              ⓘ Wie berechnet?
            </button>
          )}
        </h2>
      )}
      {props.children}
    </section>
  );
}

export function Stat(props: { value: string; unit?: string; label: string }) {
  return (
    <div class="stat">
      <div class="v">{props.value}{props.unit && <small>{props.unit}</small>}</div>
      <div class="k">{props.label}</div>
    </div>
  );
}

export function Sheet(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  return (
    <div class="sheet-backdrop" onClick={props.onClose}>
      <div class="sheet" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <h3>{props.title}</h3>
        {props.children}
        <div style={{ marginTop: 16 }}>
          <button class="btn" onClick={props.onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}

export interface Point { x: number; y: number }

/** Einfaches Liniendiagramm als SVG. x-Werte sind beliebig (z. B. Unix-Sekunden). */
export function LineChart(props: {
  series: { points: Point[]; color: string; fill?: boolean }[];
  height?: number;
  xLabels?: { x: number; label: string }[];
  yMin?: number;
  yMax?: number;
  yTicks?: number[];
  /** Lücken > gap (in x-Einheiten) unterbrechen die Linie. */
  gap?: number;
}) {
  const W = 340;
  const H = props.height ?? 140;
  const padL = 28, padR = 6, padT = 8, padB = 18;
  const all = props.series.flatMap((s) => s.points);
  if (all.length < 2) return <div class="muted small center" style={{ padding: '24px 0' }}>Noch keine Daten</div>;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = props.yMin ?? Math.floor(Math.min(...ys) * 0.95);
  let y1 = props.yMax ?? Math.ceil(Math.max(...ys) * 1.05);
  if (y1 - y0 < 1) { y0 -= 1; y1 += 1; }
  const sx = (x: number) => padL + ((x - x0) / (x1 - x0 || 1)) * (W - padL - padR);
  const sy = (y: number) => padT + (1 - (y - y0) / (y1 - y0)) * (H - padT - padB);
  const ticks = props.yTicks ?? niceTicks(y0, y1, 3);

  const pathFor = (pts: Point[]) => {
    let d = '';
    let prev: Point | null = null;
    for (const p of pts) {
      const brk = !prev || (props.gap != null && p.x - prev.x > props.gap);
      d += `${brk ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
      prev = p;
    }
    return d;
  };

  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }}>
      {ticks.map((t) => (
        <g key={t}>
          <line class="grid" x1={padL} x2={W - padR} y1={sy(t)} y2={sy(t)} />
          <text x={padL - 4} y={sy(t) + 3} text-anchor="end">{t}</text>
        </g>
      ))}
      {props.series.map((s, i) => (
        <g key={i}>
          {s.fill && s.points.length > 1 && (
            <path
              d={`${pathFor(s.points)}L${sx(s.points[s.points.length - 1].x)},${sy(y0)}L${sx(s.points[0].x)},${sy(y0)}Z`}
              fill={s.color} opacity="0.12"
            />
          )}
          <path d={pathFor(s.points)} fill="none" stroke={s.color} stroke-width="1.8" stroke-linejoin="round" />
        </g>
      ))}
      {props.xLabels?.map((l, i) => (
        <text key={i} x={sx(l.x)} y={H - 4} text-anchor="middle">{l.label}</text>
      ))}
    </svg>
  );
}

/** Balkendiagramm; `null`-Werte werden als leere Stelle gezeigt. */
export function BarChart(props: {
  bars: { label: string; value: number | null; color: string }[];
  max: number;
  height?: number;
  format?: (v: number) => string;
}) {
  const W = 340;
  const H = props.height ?? 130;
  const padB = 16, padT = 14;
  const n = props.bars.length;
  const slot = W / Math.max(n, 1);
  const bw = Math.min(28, slot * 0.62);
  const showValues = n <= 14;
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} style={{ height: H }}>
      <line class="grid" x1="0" x2={W} y1={H - padB} y2={H - padB} />
      {props.bars.map((b, i) => {
        const cx = slot * i + slot / 2;
        const h = b.value == null ? 0 : Math.max(2, (b.value / props.max) * (H - padB - padT));
        return (
          <g key={i}>
            {b.value != null && (
              <rect x={cx - bw / 2} y={H - padB - h} width={bw} height={h} rx="4" fill={b.color} />
            )}
            {b.value != null && showValues && (
              <text x={cx} y={H - padB - h - 3} text-anchor="middle" style={{ fill: 'var(--text)' }}>
                {props.format ? props.format(b.value) : Math.round(b.value)}
              </text>
            )}
            {(n <= 14 || i % Math.ceil(n / 10) === 0) && (
              <text x={cx} y={H - 3} text-anchor="middle">{b.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Schlafverlauf: Minuten-Epochen als farbige Streifen (Schlaf / wach). */
export function Hypnogram(props: { epochs: { t: number; asleep: 0 | 1 }[]; start: number; end: number }) {
  const W = 340, H = 64;
  const span = props.end - props.start || 1;
  const sx = (t: number) => ((t - props.start) / span) * W;
  const w = Math.max(0.6, (60 / span) * W);
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }}>
      <rect x="0" y="0" width={W} height={H - 16} rx="6" fill="var(--card-2)" />
      {props.epochs.map((e) => (
        <rect
          key={e.t} x={sx(e.t)} width={w + 0.4}
          y={e.asleep ? 18 : 2} height={e.asleep ? H - 34 : 12}
          fill={e.asleep ? 'var(--sleep)' : 'var(--yellow)'}
        />
      ))}
    </svg>
  );
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
