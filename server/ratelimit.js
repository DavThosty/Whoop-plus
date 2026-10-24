// @ts-check

/**
 * Simple fixed-window in-memory rate limiter.
 */
export class RateLimiter {
  /**
   * @param {{ limit: number, windowMs: number, now?: () => number }} opts
   */
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.hits = new Map();
  }

  /**
   * Count one hit for `key`.
   * @param {string} key
   * @returns {{ allowed: boolean, remaining: number, retryAfterSec: number }}
   */
  hit(key) {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (this.hits.size > 10_000) this.sweep();
    return {
      allowed: entry.count <= this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterSec: Math.ceil((entry.resetAt - t) / 1000),
    };
  }

  /**
   * Is `key` currently blocked (without counting a hit)?
   * @param {string} key
   */
  blocked(key) {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= this.now()) return null;
    return entry.count >= this.limit ? Math.ceil((entry.resetAt - this.now()) / 1000) : null;
  }

  sweep() {
    const t = this.now();
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
