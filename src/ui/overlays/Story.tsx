import { useEffect, useRef, useState } from 'preact/hooks';
import { reducedMotion, useTween } from '../anim';
import { Hypnogram, Icon, Ring } from '../components';
import { flow } from '../flow';
import { clock, clockMin, COLORS, num, recoveryHex, recoveryState } from '../format';
import { useApp, useDay, usePrevious } from '../hooks';
import { buildRecommendation } from '../insights';
import { hourTicks } from '../pages/Sleep';

const SLIDE_MS = [7000, 9000];

/** Morgen-Story: Schlaf-Rückblick und Tagesempfehlung im Vollbild. */
export function Story(props: { date: string }) {
  const s = useApp();
  const day = useDay(props.date, s.dataVersion);
  const prev = usePrevious(props.date, s.dataVersion);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [drag, setDrag] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const elapsed = useRef(0);
  const pointer = useRef<{ x: number; y: number; t: number; dragging: boolean } | null>(null);
  const count = 2;

  const close = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => flow.closeStory(), reducedMotion() ? 0 : 380);
  };
  const next = () => (idx < count - 1 ? setIdx(idx + 1) : close());
  const back = () => idx > 0 && setIdx(idx - 1);

  useEffect(() => {
    elapsed.current = 0;
  }, [idx]);

  // Automatisch weiter (nur von Folie 1 zu 2; die letzte Folie bleibt stehen).
  useEffect(() => {
    if (paused || leaving || idx >= count - 1) return;
    const start = Date.now();
    const id = setTimeout(() => setIdx((i) => Math.min(count - 1, i + 1)), Math.max(0, SLIDE_MS[idx] - elapsed.current));
    return () => {
      clearTimeout(id);
      elapsed.current += Date.now() - start;
    };
  }, [idx, paused, leaving]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onDown = (e: PointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY, t: Date.now(), dragging: false };
    setPaused(true);
  };
  const onMove = (e: PointerEvent) => {
    const p = pointer.current;
    if (!p) return;
    const dy = e.clientY - p.y;
    if (!p.dragging && dy > 12 && Math.abs(dy) > Math.abs(e.clientX - p.x)) p.dragging = true;
    if (p.dragging) setDrag(Math.max(0, dy));
  };
  const onUp = (e: PointerEvent) => {
    const p = pointer.current;
    pointer.current = null;
    setPaused(false);
    if (!p) return;
    if (p.dragging) {
      if (e.clientY - p.y > 110) close();
      setDrag(0);
      return;
    }
    if (Date.now() - p.t > 350) return; // Gedrückt halten = Pause, kein Tipp
    const w = (e.currentTarget as HTMLElement).clientWidth || window.innerWidth;
    if (e.clientX < w / 3) back();
    else next();
  };

  const rec = day?.recovery ?? null;
  const recColor = recoveryHex(rec);
  const bg0 = `radial-gradient(120% 70% at 50% -5%, rgba(92,140,190,0.55), rgba(26,40,64,0.35) 45%, transparent 75%), linear-gradient(180deg, #0a1220, #05070a 70%)`;
  const bg1 = `radial-gradient(120% 70% at 50% -5%, ${recColor}66, ${recColor}1f 45%, transparent 75%), linear-gradient(180deg, #0b0f14, #05070a 70%)`;
  const style = drag ? { transform: `translateY(${drag}px) scale(${1 - Math.min(0.12, drag / 2500)})`, borderRadius: 28, transition: 'none' } : undefined;

  return (
    <div class={`overlay story ${leaving ? 'overlay-exit' : 'overlay-enter'} ${paused ? 'paused' : ''}`} style={style} role="dialog" aria-label="Morgen-Story">
      <div class="story-bg" style={{ background: bg0, opacity: idx === 0 ? 1 : 0, transition: 'opacity 0.9s' }} />
      <div class="story-bg" style={{ background: bg1, opacity: idx === 1 ? 1 : 0, transition: 'opacity 0.9s' }} />
      <div class="tap-zones" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { pointer.current = null; setPaused(false); setDrag(0); }} />
      <div class="content" style={{ pointerEvents: 'none' }}>
        <div class="bars">
          {Array.from({ length: count }, (_, i) => (
            <div key={`${i}-${i === idx ? idx : 'x'}`} class={i < idx ? 'done' : i === idx ? 'run' : ''} style={{ '--dur': `${SLIDE_MS[i]}ms` } as never}><i /></div>
          ))}
        </div>
        <div class="top">
          <div class="brand"><Ring size={26} stroke={4} fraction={rec == null ? 0.6 : rec / 100} color={recColor} glow={false} /> <span><b>Whoop Plus</b> · {idx === 0 ? 'Schlaf' : 'Heute'}</span></div>
          <button class="circle-btn" style={{ pointerEvents: 'auto' }} aria-label="Schließen" onClick={close}><Icon name="close" /></button>
        </div>

        {day === undefined ? <div class="slide" /> : idx === 0 ? <SleepSlide key="s0" day={day} /> : <RecoSlide key="s1" day={day} prev={prev} onDone={close} />}
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 11) return 'Guten Morgen';
  if (h < 17) return 'Hallo';
  return 'Guten Abend';
}

function SleepSlide(props: { day: import('../../types').DailySummary | null }) {
  const s = useApp();
  const sleep = props.day?.sleep ?? null;
  const t = useTween('sleep-slide', 1800, 350);
  const perf = props.day?.sleepPerformance ?? null;
  if (!sleep) {
    return (
      <div class="slide">
        <div class="greet">{greeting()}</div>
        <h2 class="headline">Kein Schlaf erkannt</h2>
        <p class="muted">Für diese Nacht liegen keine ausreichenden Daten vor.</p>
      </div>
    );
  }
  const mins = Math.round(sleep.asleepMin * t);
  const need = (s.profile?.sleepNeedH ?? 8) * 60;
  return (
    <div class="slide">
      <div class="greet" style={{ animationDelay: '0.05s' }}>{greeting()}</div>
      <h2 class="headline" style={{ animationDelay: '0.12s' }}>Dein Schlaf-Rückblick</h2>
      <div style={{ marginTop: 26, animationDelay: '0.2s' }}>
        <div class="s-big">{Math.floor(mins / 60)}<small>h</small>{String(mins % 60).padStart(2, '0')}<small>min</small></div>
        <div class="times">
          <Icon name="moon" /> {clock(sleep.start)}
          <span class="faint">→</span>
          <Icon name="sun" /> {clock(sleep.end)}
          <span class="faint">· Bedarf {Math.floor(need / 60)} h{need % 60 ? ` ${need % 60} min` : ''}</span>
        </div>
      </div>
      <div style={{ marginTop: 22, animationDelay: '0.3s' }}>
        <Hypnogram epochs={sleep.epochs} start={sleep.start} end={sleep.end} animate height={96} labels={hourTicks(sleep.start, sleep.end)} />
      </div>
      <div class="row" style={{ marginTop: 22, gap: 18, animationDelay: '0.45s' }}>
        <Ring size={104} stroke={10} fraction={perf == null ? null : perf / 100} color={COLORS.sleep} t={t}>
          <div class="mid" style={{ fontSize: 26 }}>{perf == null ? '–' : Math.round(perf * t)}<span class="unit" style={{ fontSize: 13 }}>%</span></div>
          <div class="tiny faint" style={{ fontWeight: 700, letterSpacing: '0.1em' }}>LEISTUNG</div>
        </Ring>
        <div class="grow" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <MiniStat v={`${Math.round(sleep.efficiency * 100)} %`} k="Effizienz" />
          <MiniStat v={`${sleep.wakeEpisodes}×`} k="Wachphasen" />
          <MiniStat v={`${num(sleep.restingHr)}`} k="Ruhepuls" />
          <MiniStat v={`${num(sleep.hrvRmssd)} ms`} k="HRV" />
        </div>
      </div>
    </div>
  );
}

function MiniStat(props: { v: string; k: string }) {
  return (
    <div class="stat" style={{ padding: '9px 11px', background: 'rgba(255,255,255,0.06)' }}>
      <div class="v" style={{ fontSize: 18 }}>{props.v}</div>
      <div class="k">{props.k}</div>
    </div>
  );
}

function RecoSlide(props: { day: import('../../types').DailySummary | null; prev: import('../../types').DailySummary[]; onDone: () => void }) {
  const s = useApp();
  const t = useTween('reco-slide', 2000, 450);
  const reco = buildRecommendation(props.day, props.prev, s.profile);
  const rec = props.day?.recovery ?? null;
  const color = recoveryHex(rec);
  return (
    <div class="slide">
      <div class="greet">Deine Tagesempfehlung</div>
      <div class="center" style={{ margin: '20px 0 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', animationDelay: '0.1s' }}>
        <Ring size={196} stroke={15} fraction={rec == null ? null : rec / 100} color={color} t={t}>
          <div class="eyebrow">Recovery</div>
          <div class="hero-value" style={{ fontSize: 60 }}>{rec == null ? '–' : Math.round(rec * t)}{rec != null && <small>%</small>}</div>
        </Ring>
        <div class="hero-state" style={{ color: rec == null ? 'var(--text)' : color, marginTop: 12 }}>{recoveryState(props.day)}</div>
      </div>
      {reco && (
        <>
          <p class="reco-title" style={{ marginTop: 14, fontSize: 19, animationDelay: '0.3s' }}>{reco.title}</p>
          <p class="reco-text" style={{ animationDelay: '0.35s' }}>{reco.text}</p>
          <div class="reco-stats" style={{ animationDelay: '0.45s' }}>
            <div class="reco-stat" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div class="k"><Icon name="bolt" /> Ziel-Strain</div>
              <div class="v">{reco.strainRange[0]}–{reco.strainRange[1]}</div>
            </div>
            <div class="reco-stat" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div class="k"><Icon name="moon" /> Heute ins Bett</div>
              <div class="v">{clockMin(reco.bedtime.minutesOfDay)}</div>
            </div>
          </div>
        </>
      )}
      <button class="btn primary story-cta" style={{ marginTop: 22, pointerEvents: 'auto', animationDelay: '0.6s' }} onClick={props.onDone}>
        Los geht's
      </button>
    </div>
  );
}
