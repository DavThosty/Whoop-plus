import { useEffect, useRef, useState } from 'preact/hooks';
import { getDay } from '../../store/db';
import type { DailySummary } from '../../types';
import { reducedMotion, useSmoothNumber, useTween } from '../anim';
import { Ring } from '../components';
import { app } from '../controller';
import { flow } from '../flow';
import { dateTime, recoveryHex, recoveryState, today } from '../format';
import { useApp } from '../hooks';

type Phase = 'connect' | 'sync' | 'compute' | 'reveal' | 'error';

const MIN_SHOW_MS = 2500;
const REVEAL_MS = 3600;

/** Erster Sync des Tages: Partikel strömen ins Band, danach wird die Recovery enthüllt. */
export function Ceremony() {
  const s = useApp();
  const [phase, setPhase] = useState<Phase>('connect');
  const [day, setDay] = useState<DailySummary | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const startedAt = useRef(Date.now());
  const sawActive = useRef(false);
  const finished = useRef(false);
  const coreRef = useRef<HTMLDivElement>(null);

  const records = s.sync?.records ?? 0;
  const smooth = useSmoothNumber(records, 0.08);

  const finish = (ok: boolean, skipped = false) => {
    if (finished.current) return;
    finished.current = true;
    setLeaving(true);
    setTimeout(() => void flow.endCeremony(ok, skipped), reducedMotion() ? 0 : 480);
  };

  // Phasen aus dem App-Zustand ableiten.
  useEffect(() => {
    if (phase === 'reveal' || phase === 'error') return;
    const sync = s.sync;
    if (sync && !sync.done) sawActive.current = true;
    if (sawActive.current && sync?.done) {
      if (sync.ok === false) {
        setErr(sync.error ?? 'Die Synchronisierung wurde unterbrochen.');
        setPhase('error');
        return;
      }
      if (s.postSync || s.computing) {
        setPhase('compute');
        return;
      }
      // Sync und Berechnung fertig → Recovery enthüllen (nach einer Mindestanzeigedauer).
      const wait = Math.max(0, MIN_SHOW_MS - (Date.now() - startedAt.current));
      const id = setTimeout(async () => {
        if (app.state.postSync || app.state.computing) return;
        const d = await getDay(today()).catch(() => undefined);
        setDay(d ?? null);
        setPhase('reveal');
      }, wait);
      return () => clearTimeout(id);
    }
    if (s.conn === 'disconnected') {
      setErr(s.error ?? 'Die Verbindung zum Band wurde getrennt.');
      setPhase('error');
      return;
    }
    setPhase(sawActive.current && records > 0 ? 'sync' : 'connect');
  }, [s.sync, s.conn, s.postSync, s.computing, records]);

  useEffect(() => {
    if (phase === 'reveal') {
      const id = setTimeout(() => finish(true), REVEAL_MS);
      return () => clearTimeout(id);
    }
    if (phase === 'error') {
      const id = setTimeout(() => finish(false), 6000);
      return () => clearTimeout(id);
    }
  }, [phase]);

  const rec = day?.recovery ?? null;
  const color = phase === 'reveal' ? recoveryHex(rec) : phase === 'error' ? '#ff0026' : '#0093e7';
  const t = useTween(phase === 'reveal' ? 'reveal' : 'idle', 1800, 150, phase === 'reveal');

  const lines: Record<Phase, [string, string]> = {
    connect: ['Verbinde mit Band …', 'Verlauf wird angefragt'],
    sync: ['Lade Verlauf …', s.sync?.newestTs ? `bis ${dateTime(s.sync.newestTs)}` : 'Daten werden übertragen'],
    compute: ['Berechne Schlaf & Recovery …', 'Nacht, HRV und Ruhepuls werden ausgewertet'],
    reveal: [day ? recoveryState(day) : 'Fertig', day?.sleep ? 'Deine Werte für heute sind bereit' : 'Alle Daten sind aktuell'],
    error: ['Sync unterbrochen', err ?? ''],
  };

  return (
    <div class={`overlay ceremony ${leaving ? 'overlay-exit' : 'overlay-enter'}`} style={{ '--cg': color } as never} role="dialog" aria-label="Synchronisierung">
      <div class="glowball" />
      <Particles
        rate={phase === 'sync' ? 70 : phase === 'connect' ? 18 : phase === 'compute' ? 40 : 0}
        burst={phase === 'reveal'}
        color={color}
        target={coreRef}
      />
      <div class="content">
        <div class="eyebrow center" style={{ marginTop: 8 }}>Whoop Plus · Morgen-Sync</div>
        <div class="core">
          <div ref={coreRef} class={`core-ring ${phase === 'reveal' ? '' : 'pulse'}`}>
            {phase !== 'reveal' && <Loader color={color} spinning={phase !== 'error'} />}
            {phase === 'reveal' && (
              <Ring size={230} stroke={16} fraction={rec == null ? 0.0001 : rec / 100} color={color} t={t} style={{ position: 'absolute', inset: 0 }} />
            )}
            <div class="ring-center">
              {phase === 'reveal' ? (
                <>
                  <div class="eyebrow">Recovery</div>
                  <div class="hero-value" style={{ fontSize: 64 }}>{rec == null ? '–' : Math.round(rec * t)}{rec != null && <small>%</small>}</div>
                </>
              ) : phase === 'error' ? (
                <div class="count" style={{ fontSize: 40 }}>!</div>
              ) : (
                <>
                  <div class="count">{Math.round(smooth).toLocaleString('de-DE')}</div>
                  <div class="eyebrow" style={{ marginTop: 6 }}>Datensätze</div>
                </>
              )}
            </div>
          </div>
          <div class="status" key={phase}>
            <div class="line" style={phase === 'reveal' && rec != null ? { color } : undefined}>{lines[phase][0]}</div>
            <div class="sub">{lines[phase][1]}</div>
          </div>
        </div>
        {phase === 'error' ? (
          <button class="skip" onClick={() => finish(false)}>Schließen</button>
        ) : (
          <button class="skip" onClick={() => finish(phase === 'reveal', phase !== 'reveal')}>
            {phase === 'reveal' ? 'Weiter' : 'Überspringen'}
          </button>
        )}
      </div>
    </div>
  );
}

function Loader(props: { color: string; spinning: boolean }) {
  const size = 230, stroke = 3, r = (size - 16) / 2, c = 2 * Math.PI * r;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} aria-hidden="true">
      <defs>
        <linearGradient id="cer-arc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0.95" />
          <stop offset="1" stop-color={props.color} stop-opacity="0.1" />
        </linearGradient>
        <filter id="cer-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5" /></filter>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" stroke-width={16} />
      <circle cx={size / 2} cy={size / 2} r={r - 14} fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="2 6" />
      <g style={{ transformOrigin: '50% 50%', animation: props.spinning ? 'spin 2.4s linear infinite' : 'none' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={props.color} stroke-width={16} stroke-linecap="round" stroke-dasharray={`${c * 0.28} ${c}`} filter="url(#cer-blur)" opacity="0.7" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#cer-arc)" stroke-width={stroke + 9} stroke-linecap="round" stroke-dasharray={`${c * 0.28} ${c}`} />
      </g>
    </svg>
  );
}

interface P { a: number; d: number; v: number; life: number; size: number; out: boolean }

/** Partikel (Canvas 2D), die in den Ring strömen; bei `burst` explodieren sie nach außen. */
function Particles(props: { rate: number; burst: boolean; color: string; target: { current: HTMLElement | null } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || reducedMotion()) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let w = 0, h = 0, dpr = 1, cx = 0, cy = 0, ringR = 100;
    const ps: P[] = [];
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let burstDone = false;

    const resize = () => {
      dpr = Math.min(3, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const el = live.current.target.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const cr = canvas.getBoundingClientRect();
        cx = r.left - cr.left + r.width / 2;
        cy = r.top - cr.top + r.height / 2;
        ringR = r.width / 2 - 8;
      } else {
        cx = w / 2;
        cy = h * 0.42;
      }
    };

    const spawn = (out: boolean) => {
      const a = Math.random() * Math.PI * 2;
      const far = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) + 20;
      ps.push(out
        ? { a, d: ringR, v: 120 + Math.random() * 380, life: 1, size: 0.8 + Math.random() * 2.2, out: true }
        : { a, d: ringR + 40 + Math.random() * (far - ringR - 40), v: 30 + Math.random() * 60, life: 1, size: 0.6 + Math.random() * 1.8, out: false });
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = live.current;
      acc += p.rate * dt;
      while (acc >= 1 && ps.length < 600) {
        spawn(false);
        acc -= 1;
      }
      if (p.burst && !burstDone) {
        burstDone = true;
        for (let i = 0; i < 180; i++) spawn(true);
      }
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = ps.length - 1; i >= 0; i--) {
        const q = ps[i];
        const prevD = q.d;
        if (q.out) {
          q.d += q.v * dt;
          q.v *= 0.985;
          q.life -= dt * 0.7;
        } else {
          q.v += 140 * dt; // Beschleunigung zum Ring
          q.d -= q.v * dt;
          q.a += dt * 0.25; // leichte Spirale
          if (q.d <= ringR) q.life = 0;
        }
        if (q.life <= 0) {
          ps.splice(i, 1);
          continue;
        }
        const x = cx + Math.cos(q.a) * q.d, y = cy + Math.sin(q.a) * q.d;
        const px = cx + Math.cos(q.a) * prevD, py = cy + Math.sin(q.a) * prevD;
        const near = q.out ? q.life : Math.min(1, (q.d - ringR) / 60);
        const alpha = Math.max(0, Math.min(1, q.out ? q.life : 0.25 + 0.75 * (1 - Math.min(1, (q.d - ringR) / 400)))) * near;
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = alpha * 0.55;
        ctx.lineWidth = q.size;
        ctx.beginPath();
        ctx.moveTo(px - (x - px) * 3, py - (y - py) * 3);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, q.size * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVis = () => (document.hidden ? stop() : start());

    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVis);
    if (!document.hidden) start();
    return () => {
      stop();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" />;
}
