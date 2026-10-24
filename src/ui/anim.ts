// Kleine Animationshelfer (rAF, ohne Abhängigkeiten). Respektieren „Bewegung reduzieren“.
import { useEffect, useRef, useState } from 'preact/hooks';

export function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
export const easeOutQuart = (x: number) => 1 - (1 - x) ** 4;
export const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/**
 * Fortschritt 0 → 1 (mit Easing), neu gestartet bei jeder Änderung von `key`.
 * Ring-Füllung und hochzählende Zahl nutzen denselben Wert und laufen dadurch synchron.
 */
export function useTween(key: unknown, duration = 1500, delay = 0, enabled = true, ease = easeOutQuart): number {
  const [t, setT] = useState(() => (reducedMotion() || !enabled ? 1 : 0));
  useEffect(() => {
    if (!enabled) return;
    if (reducedMotion()) {
      setT(1);
      return;
    }
    setT(0);
    let raf = 0;
    const start = performance.now() + delay;
    const step = (now: number) => {
      const x = Math.min(1, Math.max(0, (now - start) / duration));
      setT(ease(x));
      if (x < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [key, enabled]);
  return t;
}

/** Folgt einem Zielwert weich (für laufend steigende Zähler wie Datensätze oder Live-Strain). */
export function useSmoothNumber(target: number, rate = 0.12): number {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    if (reducedMotion()) {
      cur.current = target;
      setV(target);
      return;
    }
    let raf = 0;
    const step = () => {
      const d = target - cur.current;
      if (Math.abs(d) < 0.5) {
        cur.current = target;
        setV(target);
        return;
      }
      cur.current += d * rate;
      setV(cur.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

/** Sekundentakt (z. B. für Uhren und Workout-Zeit). */
export function useTick(ms = 1000, on = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms, on]);
  return n;
}

let uid = 0;
/** Eindeutige ID für SVG-Gradienten/Filter pro Komponenteninstanz. */
export function useUid(prefix = 'u'): string {
  const ref = useRef<string>('');
  if (!ref.current) ref.current = `${prefix}${++uid}`;
  return ref.current;
}
