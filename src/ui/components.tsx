import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useUid } from './anim';
import { lighten } from './format';

// ---------------------------------------------------------------------------
// Icons (Linien, 24er Raster)

const ICONS: Record<string, JSX.Element> = {
  today: <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" stroke-width="2.6" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  trends: <path d="M4 19V11M10 19V5M16 19v-6M21 19H3" />,
  more: <><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><rect x="2.5" y="5" width="19" height="14" rx="7" /></>,
  bolt: <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z" fill="currentColor" stroke="none" />,
  heart: <path d="M12 20.5s-7.5-4.6-9.2-9.4C1.7 7.8 3.9 4.5 7.2 4.5c2 0 3.6 1.1 4.8 2.8 1.2-1.7 2.8-2.8 4.8-2.8 3.3 0 5.5 3.3 4.4 6.6-1.7 4.8-9.2 9.4-9.2 9.4Z" fill="currentColor" stroke="none" />,
  chevR: <path d="m9 5 7 7-7 7" />,
  chevL: <path d="m15 5-7 7 7 7" />,
  chevD: <path d="m5 9 7 7 7-7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  bed: <path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11.5a1.5 1.5 0 1 0 0-.01" />,
  flame: <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.1 0-3.4 2.4-5.4 3.6-8.4.4 1.9 1.5 3 2.6 3.5C11.5 7 13 4.6 15.4 3c-.5 3 .9 4.9 2 6.6.9 1.4 1.6 2.8 1.6 4.9C19 18.2 16 21 12 21Z" />,
  wave: <path d="M2.5 12h4l2-5 3.5 10 2.5-7 1.5 2h5.5" />,
  pulse: <path d="M2.5 12h4l2-5 3.5 10 2.5-7 1.5 2h5.5" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.6v.1" /></>,
  band: <><rect x="7" y="2.5" width="10" height="19" rx="3.5" /><path d="M7 9h10M7 15h10" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  db: <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  key: <><circle cx="8" cy="15" r="4.5" /><path d="m11.2 11.8 8.3-8.3M16.5 6.5l2.5 2.5M14.5 8.5l2 2" /></>,
  book: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15ZM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" />,
  terminal: <><rect x="2.5" y="4" width="19" height="16" rx="3" /><path d="m7 9 3 3-3 3M12.5 15H17" /></>,
  play: <path d="M7 4.5v15l12.5-7.5L7 4.5Z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" /></>,
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="3" fill="currentColor" stroke="none" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  minus: <path d="M5 12h14" />,
  sync: <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" />,
  vibrate: <><rect x="8" y="4" width="8" height="16" rx="2.5" /><path d="M4 8v8M20 8v8M1.5 10v4M22.5 10v4" /></>,
  alarm: <><circle cx="12" cy="13" r="7.5" /><path d="M12 9v4l2.5 2M4 4.5 6.5 2.5M20 4.5l-2.5-2" /></>,
  story: <><circle cx="12" cy="12" r="9" stroke-dasharray="4 2.2" /><path d="M10 8.5v7l5.5-3.5L10 8.5Z" fill="currentColor" stroke="none" /></>,
  battery: <><rect x="2.5" y="7" width="17" height="10" rx="2.5" /><path d="M22 10.5v3" /></>,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
};

export function Icon(props: { name: keyof typeof ICONS | string; size?: number; class?: string; stroke?: number }) {
  return (
    <svg
      viewBox="0 0 24 24" width={props.size} height={props.size} class={props.class}
      fill="none" stroke="currentColor" stroke-width={props.stroke ?? 2} stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true"
    >
      {ICONS[props.name] ?? null}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Ring mit Verlauf und Glow

export function Ring(props: {
  size: number;
  stroke: number;
  /** 0–1 oder null (leer). */
  fraction: number | null;
  color: string;
  /** Animationsfortschritt 0–1 (gemeinsam mit der Zahl in der Mitte). */
  t?: number;
  glow?: boolean;
  track?: string;
  children?: ComponentChildren;
  class?: string;
  style?: JSX.CSSProperties;
}) {
  const id = useUid('ring');
  const { size, stroke } = props;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = props.fraction == null ? 0 : Math.max(0, Math.min(1, props.fraction)) * (props.t ?? 1);
  const len = Math.max(0, c * f);
  const light = lighten(props.color, 0.45);
  const glow = props.glow !== false;
  return (
    <div class={`ring-wrap ${props.class ?? ''}`} style={{ width: size, height: size, ...props.style }}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id={`${id}g`} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0" stop-color={light} />
            <stop offset="0.55" stop-color={props.color} />
            <stop offset="1" stop-color={props.color} />
          </linearGradient>
          {glow && (
            <filter id={`${id}f`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation={Math.max(3, stroke * 0.55)} />
            </filter>
          )}
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={props.track ?? 'rgba(255,255,255,0.07)'} stroke-width={stroke} />
        {len > 0.5 && (
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {glow && (
              <circle
                cx={size / 2} cy={size / 2} r={r} fill="none" stroke={props.color} stroke-width={stroke}
                stroke-linecap="round" stroke-dasharray={`${len} ${c}`} filter={`url(#${id}f)`} opacity="0.75"
              />
            )}
            <circle
              cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id}g)`} stroke-width={stroke}
              stroke-linecap="round" stroke-dasharray={`${len} ${c}`}
            />
          </g>
        )}
      </svg>
      {props.children && <div class="ring-center">{props.children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Karten & Kennzahlen

export function GlassCard(props: {
  title?: ComponentChildren;
  dot?: string;
  /** Öffnet eine Detailansicht; bekommt das Rechteck der Karte für die Übergangsanimation. */
  onOpen?: (rect: DOMRect) => void;
  help?: () => void;
  right?: ComponentChildren;
  class?: string;
  style?: JSX.CSSProperties;
  children?: ComponentChildren;
}) {
  const ref = useRef<HTMLElement>(null);
  const open = props.onOpen;
  return (
    <section
      ref={ref}
      class={`glass card ${open ? 'tap' : ''} ${props.class ?? ''}`}
      style={props.style}
      onClick={open ? () => ref.current && open(ref.current.getBoundingClientRect()) : undefined}
      role={open ? 'button' : undefined}
      tabIndex={open ? 0 : undefined}
      onKeyDown={open ? (e) => (e.key === 'Enter' || e.key === ' ') && ref.current && open(ref.current.getBoundingClientRect()) : undefined}
    >
      {(props.title || props.right || open || props.help) && (
        <div class="card-head">
          <div class="card-title">
            {props.dot && <i style={{ background: props.dot, boxShadow: `0 0 8px ${props.dot}` }} />}
            {props.title}
          </div>
          {props.right}
          {props.help && !props.right && (
            <button class="helpbtn" onClick={(e) => { e.stopPropagation(); props.help!(); }} aria-label="Wie wird gerechnet?" title="Wie wird gerechnet?">
              <Icon name="info" />
            </button>
          )}
          {open && !props.right && !props.help && <Icon name="chevR" class="chev" />}
        </div>
      )}
      {props.children}
    </section>
  );
}

export function Stat(props: { value: string; unit?: string; label: string; sub?: string }) {
  return (
    <div class="stat">
      <div class="v">{props.value}{props.unit && props.value !== '–' && <small>{props.unit}</small>}</div>
      <div class="k">{props.label}</div>
      {props.sub && <div class="s">{props.sub}</div>}
    </div>
  );
}

/** Veränderung gegenüber dem persönlichen Normalwert. `goodWhenUp` legt die Farbe fest. */
export function Delta(props: { value: number | null; text: string; goodWhenUp: boolean; flatBelow?: number }) {
  if (props.value == null || !Number.isFinite(props.value)) return null;
  const flat = Math.abs(props.value) < (props.flatBelow ?? 0.5);
  const up = props.value > 0;
  const good = flat ? null : up === props.goodWhenUp;
  return (
    <span class={`delta ${flat ? 'flat' : good ? 'good' : 'bad'}`}>
      <Icon name={flat ? 'minus' : up ? 'arrowUp' : 'arrowDown'} stroke={2.6} />
      {props.text}
    </span>
  );
}

/** Strain-Skala 0–21 mit Zielbereich und aktuellem Wert. */
export function RangeBar(props: { value: number | null; range?: readonly [number, number] | null; max?: number; t?: number; legend?: boolean }) {
  const max = props.max ?? 21;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const v = props.value == null ? null : props.value * (props.t ?? 1);
  return (
    <>
      <div class="rangebar">
        {props.range && <div class="target" style={{ left: pct(props.range[0]), width: `calc(${pct(props.range[1])} - ${pct(props.range[0])})` }} />}
        {v != null && <div class="fill" style={{ width: pct(v) }} />}
        {v != null && <div class="mark" style={{ left: pct(v) }} />}
      </div>
      {props.legend !== false && props.range && (
        <div class="range-legend">
          <span>0</span>
          <span>Ziel {props.range[0]}–{props.range[1]}</span>
          <span>{max}</span>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bottom-Sheet

export function Sheet(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  return (
    <div class="sheet-backdrop" onClick={props.onClose}>
      <div class="sheet" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div class="grabber" />
        <h3>{props.title}</h3>
        {props.children}
        <div style={{ marginTop: 18 }}>
          <button class="btn" onClick={props.onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagramme (Breite wird gemessen, damit Text nicht verzerrt)

function useWidth(fallback = 340): [preact.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const nw = Math.round(el.getBoundingClientRect().width);
      if (nw > 0) setW(nw);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface Point { x: number; y: number }

/** Liniendiagramm mit Verlaufsfläche. x-Werte beliebig (z. B. Unix-Sekunden). */
export function LineChart(props: {
  series: { points: Point[]; color: string; fill?: boolean; width?: number; dashed?: boolean }[];
  height?: number;
  xLabels?: { x: number; label: string }[];
  yMin?: number;
  yMax?: number;
  yTicks?: number[];
  /** Lücken > gap (in x-Einheiten) unterbrechen die Linie. */
  gap?: number;
  /** Normalbereich als Band. */
  band?: { y0: number; y1: number; color: string };
  /** Letzten Punkt hervorheben. */
  lastDot?: boolean;
  animate?: boolean;
  empty?: string;
}) {
  const id = useUid('lc');
  const [ref, W] = useWidth();
  const H = props.height ?? 140;
  const padL = 30, padR = 8, padT = 10, padB = props.xLabels ? 20 : 8;
  const all = props.series.flatMap((s) => s.points);
  if (all.length < 2) {
    return <div ref={ref} class="faint small center" style={{ padding: '28px 0' }}>{props.empty ?? 'Noch keine Daten'}</div>;
  }
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  if (props.band) ys.push(props.band.y0, props.band.y1);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = props.yMin ?? Math.floor(Math.min(...ys) * 0.95);
  let y1 = props.yMax ?? Math.ceil(Math.max(...ys) * 1.05);
  if (y1 - y0 < 1) { y0 -= 1; y1 += 1; }
  const sx = (x: number) => padL + ((x - x0) / (x1 - x0 || 1)) * (W - padL - padR);
  const sy = (y: number) => padT + (1 - (y - y0) / (y1 - y0)) * (H - padT - padB);
  const ticks = props.yTicks ?? niceTicks(y0, y1, 3);

  const segments = (pts: Point[]) => {
    const segs: Point[][] = [];
    let cur: Point[] = [];
    let prev: Point | null = null;
    for (const p of pts) {
      if (prev && props.gap != null && p.x - prev.x > props.gap) {
        if (cur.length) segs.push(cur);
        cur = [];
      }
      cur.push(p);
      prev = p;
    }
    if (cur.length) segs.push(cur);
    return segs;
  };
  const line = (seg: Point[]) => seg.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');

  return (
    <div ref={ref}>
      <svg class={`chart ${props.animate ? 'draw-in' : ''}`} viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ height: H }}>
        <defs>
          {props.series.map((s, i) => (
            <linearGradient key={i} id={`${id}a${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color={s.color} stop-opacity="0.32" />
              <stop offset="1" stop-color={s.color} stop-opacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line class="grid" x1={padL} x2={W - padR} y1={sy(t)} y2={sy(t)} />
            <text x={padL - 6} y={sy(t) + 3} text-anchor="end">{t}</text>
          </g>
        ))}
        {props.band && (
          <rect
            x={padL} width={W - padL - padR}
            y={sy(Math.max(props.band.y0, props.band.y1))}
            height={Math.abs(sy(props.band.y0) - sy(props.band.y1))}
            fill={props.band.color} opacity="0.12" rx="4"
          />
        )}
        {props.series.map((s, i) =>
          segments(s.points).map((seg, j) => (
            <g key={`${i}-${j}`}>
              {s.fill && seg.length > 1 && (
                <path d={`${line(seg)}L${sx(seg[seg.length - 1].x).toFixed(1)},${sy(y0)}L${sx(seg[0].x).toFixed(1)},${sy(y0)}Z`} fill={`url(#${id}a${i})`} />
              )}
              <path
                d={line(seg)} fill="none" stroke={s.color} stroke-width={s.width ?? 2} stroke-linejoin="round" stroke-linecap="round"
                stroke-dasharray={s.dashed ? '4 4' : undefined}
              />
              {seg.length === 1 && <circle cx={sx(seg[0].x)} cy={sy(seg[0].y)} r="2.5" fill={s.color} />}
            </g>
          )),
        )}
        {props.lastDot && props.series[0]?.points.length > 0 && (() => {
          const s = props.series[0];
          const p = s.points[s.points.length - 1];
          return (
            <g>
              <circle cx={sx(p.x)} cy={sy(p.y)} r="7" fill={s.color} opacity="0.25" />
              <circle cx={sx(p.x)} cy={sy(p.y)} r="3.5" fill="#fff" stroke={s.color} stroke-width="2" />
            </g>
          );
        })()}
        {props.xLabels?.map((l, i) => {
          const x = sx(l.x);
          const anchor = x > W - padR - 18 ? 'end' : x < padL + 12 ? 'start' : 'middle';
          return <text key={i} x={anchor === 'end' ? W - padR : x} y={H - 5} text-anchor={anchor}>{l.label}</text>;
        })}
      </svg>
    </div>
  );
}

/** Balkendiagramm; `null`-Werte bleiben als Lücke sichtbar. */
export function BarChart(props: {
  bars: { label: string; value: number | null; color: string }[];
  max: number;
  height?: number;
  format?: (v: number) => string;
  highlightLast?: boolean;
}) {
  const id = useUid('bc');
  const [ref, W] = useWidth();
  const H = props.height ?? 140;
  const padB = 18, padT = 16;
  const n = props.bars.length;
  const slot = W / Math.max(n, 1);
  const bw = Math.min(26, slot * 0.6);
  const showValues = n <= 14;
  const colors = [...new Set(props.bars.map((b) => b.color))];
  return (
    <div ref={ref}>
      <svg class="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ height: H }}>
        <defs>
          {colors.map((c, i) => (
            <linearGradient key={c} id={`${id}${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color={c.startsWith('#') ? lighten(c, 0.25) : c} />
              <stop offset="1" stop-color={c} stop-opacity="0.55" />
            </linearGradient>
          ))}
        </defs>
        <line class="grid" x1="0" x2={W} y1={H - padB} y2={H - padB} />
        {props.bars.map((b, i) => {
          const cx = slot * i + slot / 2;
          const h = b.value == null ? 0 : Math.max(3, (b.value / props.max) * (H - padB - padT));
          const ci = colors.indexOf(b.color);
          return (
            <g key={i}>
              {b.value == null ? (
                <rect x={cx - bw / 2} y={H - padB - 3} width={bw} height="3" rx="1.5" fill="rgba(255,255,255,0.08)" />
              ) : (
                <rect
                  x={cx - bw / 2} y={H - padB - h} width={bw} height={h} rx={Math.min(7, bw / 2)} fill={`url(#${id}${ci})`}
                  style={{ transformOrigin: `${cx}px ${H - padB}px`, animation: `growY 0.9s ${i * 0.03}s var(--ease) both` }}
                />
              )}
              {b.value != null && showValues && (
                <text x={cx} y={H - padB - h - 5} text-anchor="middle" style={{ fill: 'var(--text-2)', fontWeight: 600 }}>
                  {props.format ? props.format(b.value) : Math.round(b.value)}
                </text>
              )}
              {(n <= 14 || i % Math.ceil(n / 10) === 0) && (
                <text x={cx} y={H - 4} text-anchor="middle">{b.label}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Schlafverlauf: Wach oben, Schlaf unten; zusammenhängende Abschnitte als abgerundete Balken. */
export function Hypnogram(props: {
  epochs: { t: number; asleep: 0 | 1 }[];
  start: number;
  end: number;
  height?: number;
  animate?: boolean;
  labels?: { x: number; label: string }[];
}) {
  const id = useUid('hy');
  const [ref, W] = useWidth();
  const H = props.height ?? 92;
  const labelH = props.labels ? 16 : 0;
  const span = props.end - props.start || 1;
  const sx = (t: number) => ((t - props.start) / span) * W;
  const runs: { a: number; b: number; s: 0 | 1 }[] = [];
  for (const e of props.epochs) {
    const last = runs[runs.length - 1];
    if (last && last.s === e.asleep && e.t - last.b <= 61) last.b = e.t + 60;
    else runs.push({ a: e.t, b: e.t + 60, s: e.asleep });
  }
  const laneH = H - labelH;
  const wakeY = 2, wakeH = laneH * 0.22;
  const sleepY = laneH * 0.36, sleepH = laneH - sleepY - 2;
  return (
    <div ref={ref}>
      <svg class={`chart ${props.animate ? 'draw-in' : ''}`} viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ height: H }}>
        <defs>
          <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#b9d6ec" />
            <stop offset="1" stop-color="#4f7da3" />
          </linearGradient>
          <linearGradient id={`${id}w`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#ffe866" />
            <stop offset="1" stop-color="#e0a800" />
          </linearGradient>
        </defs>
        <rect x="0" y={wakeY} width={W} height={wakeH} rx="5" fill="rgba(255,255,255,0.035)" />
        <rect x="0" y={sleepY} width={W} height={sleepH} rx="8" fill="rgba(255,255,255,0.035)" />
        {runs.map((r) => {
          const x = sx(r.a);
          const w = Math.max(1.5, sx(r.b) - x);
          return r.s ? (
            <rect key={r.a} x={x} y={sleepY} width={w} height={sleepH} rx={Math.min(7, w / 2)} fill={`url(#${id}s)`} />
          ) : (
            <rect key={r.a} x={x} y={wakeY} width={w} height={wakeH} rx={Math.min(4, w / 2)} fill={`url(#${id}w)`} />
          );
        })}
        {props.labels?.map((l, i) => (
          <text key={i} x={Math.min(W - 8, Math.max(8, sx(l.x)))} y={H - 3} text-anchor="middle">{l.label}</text>
        ))}
      </svg>
    </div>
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
