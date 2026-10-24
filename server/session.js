// @ts-check
import crypto from 'node:crypto';

/**
 * @typedef {object} SessionPayload
 * @property {number} v     format version
 * @property {number} g     auth generation at issue time
 * @property {number} iat   issued at (ms since epoch)
 * @property {number} exp   expiry (ms since epoch)
 * @property {string} sid   random session id
 * @property {string} via   'passkey' | 'pair'
 */

/**
 * @param {Buffer} secret
 * @param {string} data
 */
function mac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

/**
 * Create an HMAC-signed session token: base64url(json).base64url(hmac)
 * @param {Buffer} secret
 * @param {{ generation: number, now: number, ttlMs: number, via: string }} opts
 * @returns {{ token: string, payload: SessionPayload }}
 */
export function signSession(secret, { generation, now, ttlMs, via }) {
  /** @type {SessionPayload} */
  const payload = {
    v: 1,
    g: generation,
    iat: now,
    exp: now + ttlMs,
    sid: crypto.randomBytes(12).toString('base64url'),
    via,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${mac(secret, body).toString('base64url')}`, payload };
}

/**
 * Verify a session token. Returns the payload or null.
 * @param {Buffer} secret
 * @param {string|undefined} token
 * @param {{ generation: number, now: number }} opts
 * @returns {SessionPayload|null}
 */
export function verifySession(secret, token, { generation, now }) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  let sig;
  try {
    sig = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const expected = mac(secret, body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  /** @type {SessionPayload} */
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (typeof payload.iat !== 'number' || payload.iat > now + 60_000) return null;
  if (payload.g !== generation) return null;
  return payload;
}

/**
 * Minimal cookie header parser.
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Serialize a Set-Cookie header value.
 * @param {string} name
 * @param {string} value
 * @param {{ maxAgeSec?: number, path?: string, secure?: boolean, sameSite?: 'Lax'|'Strict' }} opts
 */
export function serializeCookie(name, value, { maxAgeSec, path = '/', secure = true, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (secure) parts.push('Secure');
  if (maxAgeSec !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
    parts.push(`Expires=${new Date(Date.now() + Math.max(0, maxAgeSec) * 1000).toUTCString()}`);
  }
  return parts.join('; ');
}
