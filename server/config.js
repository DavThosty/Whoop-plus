// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {object} Config
 * @property {string} rpId          WebAuthn Relying Party ID (domain without scheme)
 * @property {string} origin        Expected origin, e.g. https://whoop.steiner-kn.de
 * @property {number} port
 * @property {string} host
 * @property {string} dataDir
 * @property {string} staticDir
 * @property {number} sessionDays
 * @property {string|undefined} setupCode   fixed setup code (otherwise random)
 * @property {boolean} resetAuth
 * @property {boolean|number|string} trustProxy
 * @property {string|undefined} sessionSecret
 * @property {boolean} cookieSecure
 */

/** @param {string|undefined} v */
export function isTruthy(v) {
  return typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim());
}

/**
 * Parse TRUST_PROXY the way Express understands it.
 * "1" -> 1 hop, "true"/"false" -> boolean, anything else -> list/subnet string.
 * @param {string|undefined} v
 * @returns {boolean|number|string}
 */
export function parseTrustProxy(v) {
  if (v === undefined || v.trim() === '') return 1;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  return s;
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  const origin = (env.ORIGIN || 'https://whoop.steiner-kn.de').replace(/\/+$/, '');
  const sessionDays = Number(env.SESSION_DAYS || 30);
  return {
    rpId: env.RP_ID || 'whoop.steiner-kn.de',
    origin,
    port: Number(env.PORT || 8080),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || '/data'),
    staticDir: path.resolve(env.STATIC_DIR || path.join(SERVER_DIR, '..', 'dist')),
    sessionDays: Number.isFinite(sessionDays) && sessionDays > 0 ? sessionDays : 30,
    setupCode: env.SETUP_CODE && env.SETUP_CODE.trim() ? env.SETUP_CODE.trim() : undefined,
    resetAuth: isTruthy(env.RESET_AUTH),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionSecret: env.SESSION_SECRET && env.SESSION_SECRET.length >= 32 ? env.SESSION_SECRET : undefined,
    // Only for local development over plain http. Never disable in production.
    cookieSecure: env.COOKIE_SECURE === undefined ? true : !/^(0|false|no|off)$/i.test(env.COOKIE_SECURE),
  };
}
