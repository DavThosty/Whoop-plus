// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import {
  generateRegistrationOptions as swaGenerateRegistrationOptions,
  generateAuthenticationOptions as swaGenerateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { SERVER_DIR } from './config.js';
import { signSession, verifySession, parseCookies, serializeCookie } from './session.js';
import { RateLimiter } from './ratelimit.js';
import { SetupCodeManager } from './setupcode.js';

const require = createRequire(import.meta.url);

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PAIR_TTL_MS = 10 * 60 * 1000;
export const CHALLENGE_COOKIE = 'wp_chal';
const LOGIN_DIR = path.join(SERVER_DIR, 'login');

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Absolute path of the prebuilt @simplewebauthn/browser UMD bundle. */
export function resolveWebAuthnBrowserBundle() {
  const main = require.resolve('@simplewebauthn/browser'); // .../browser/script/index.js
  return path.join(path.dirname(main), '..', 'dist', 'bundle', 'index.umd.min.js');
}

/**
 * @typedef {import('./config.js').Config} Config
 * @typedef {import('./store.js').AuthStore} AuthStore
 * @typedef {{ info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void }} Logger
 */

/**
 * @typedef {object} AppDeps
 * @property {Config} config
 * @property {AuthStore} store
 * @property {Buffer} sessionSecret
 * @property {Logger} [logger]
 * @property {() => number} [now]
 * @property {typeof verifyRegistrationResponse} [verifyRegistration]
 * @property {typeof verifyAuthenticationResponse} [verifyAuthentication]
 * @property {typeof swaGenerateRegistrationOptions} [generateRegistrationOptions]
 * @property {typeof swaGenerateAuthenticationOptions} [generateAuthenticationOptions]
 */

/** @param {string} token */
const sha256 = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Rough, human-readable device label from the User-Agent (no fingerprinting, just a hint).
 * @param {string|undefined} ua
 */
export function deviceLabelFromUA(ua) {
  if (!ua) return 'Unbekanntes Gerät';
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Gerät';
  const browser = /Bluefy/i.test(ua) ? 'Bluefy' : /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${device} · ${browser}`.slice(0, 60);
}

/** @param {import('express').Request} req */
function isHtmlNavigation(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.get('sec-fetch-mode') === 'navigate') return true;
  return (req.get('accept') || '').includes('text/html');
}

/**
 * Build the Express app. All WebAuthn primitives are injectable for tests.
 * @param {AppDeps} deps
 */
export function createApp(deps) {
  const {
    config,
    store,
    sessionSecret,
    logger = console,
    now = Date.now,
    verifyRegistration = verifyRegistrationResponse,
    verifyAuthentication = verifyAuthenticationResponse,
    generateRegistrationOptions = swaGenerateRegistrationOptions,
    generateAuthenticationOptions = swaGenerateAuthenticationOptions,
  } = deps;

  const sessionCookie = config.cookieSecure ? '__Host-wp_session' : 'wp_session';
  const sessionTtlMs = config.sessionDays * 24 * 60 * 60 * 1000;

  const setup = new SetupCodeManager({
    fixedCode: config.setupCode,
    isRegistered: () => store.registered,
    log: (m) => logger.info(m),
  });

  /** @type {Map<string, { challenge: string, kind: 'register'|'login', expiresAt: number }>} */
  const challenges = new Map();
  /** @type {Map<string, { expiresAt: number, generation: number }>} hashed pairing tokens */
  const pairings = new Map();

  const authLimiter = new RateLimiter({ limit: 60, windowMs: 60_000, now });
  const setupFailIp = new RateLimiter({ limit: 5, windowMs: 15 * 60_000, now });
  const setupFailGlobal = new RateLimiter({ limit: 30, windowMs: 60 * 60_000, now });
  const pairFailIp = new RateLimiter({ limit: 10, windowMs: 15 * 60_000, now });

  const sweep = () => {
    const t = now();
    for (const [k, v] of challenges) if (v.expiresAt <= t) challenges.delete(k);
    for (const [k, v] of pairings) if (v.expiresAt <= t) pairings.delete(k);
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.locals.ctx = { config, store, setup, challenges, pairings, sessionSecret, sessionCookie };

  // ---------------------------------------------------------------- helpers
  /** @param {import('express').Request} req */
  const getSession = (req) => {
    const token = parseCookies(req.headers.cookie)[sessionCookie];
    return verifySession(sessionSecret, token, { generation: store.generation, now: now() });
  };

  /**
   * @param {import('express').Response} res
   * @param {'passkey'|'pair'} via
   */
  const issueSession = (res, via) => {
    const { token, payload } = signSession(sessionSecret, {
      generation: store.generation,
      now: now(),
      ttlMs: sessionTtlMs,
      via,
    });
    res.append('Set-Cookie', serializeCookie(sessionCookie, token, {
      maxAgeSec: sessionTtlMs / 1000,
      secure: config.cookieSecure,
      sameSite: 'Lax',
    }));
    return payload;
  };

  /**
   * @param {import('express').Response} res
   * @param {string} challenge
   * @param {'register'|'login'} kind
   */
  const storeChallenge = (res, challenge, kind) => {
    sweep();
    if (challenges.size > 1000) challenges.clear();
    const id = crypto.randomBytes(24).toString('base64url');
    challenges.set(id, { challenge, kind, expiresAt: now() + CHALLENGE_TTL_MS });
    res.append('Set-Cookie', serializeCookie(CHALLENGE_COOKIE, id, {
      maxAgeSec: CHALLENGE_TTL_MS / 1000,
      path: '/api/auth',
      secure: config.cookieSecure,
      sameSite: 'Strict',
    }));
  };

  /**
   * Take (and delete) the challenge bound to this request's challenge cookie.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {'register'|'login'} kind
   */
  const consumeChallenge = (req, res, kind) => {
    const id = parseCookies(req.headers.cookie)[CHALLENGE_COOKIE];
    res.append('Set-Cookie', serializeCookie(CHALLENGE_COOKIE, '', {
      maxAgeSec: 0, path: '/api/auth', secure: config.cookieSecure, sameSite: 'Strict',
    }));
    if (!id) return null;
    const entry = challenges.get(id);
    challenges.delete(id);
    if (!entry || entry.kind !== kind || entry.expiresAt <= now()) return null;
    return entry.challenge;
  };

  /**
   * @param {import('express').Response} res
   * @param {number} status
   * @param {string} error
   * @param {string} message  German, user-facing
   */
  const fail = (res, status, error, message) => res.status(status).json({ error, message });

  // ------------------------------------------------------- global headers
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'bluetooth=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    next();
  });

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
  });

  // ----------------------------------------------------------- rate limit
  /** @type {import('express').RequestHandler} */
  const limitAuth = (req, res, next) => {
    const r = authLimiter.hit(req.ip || 'unknown');
    if (!r.allowed) {
      res.set('Retry-After', String(r.retryAfterSec));
      return fail(res, 429, 'rate_limited', 'Zu viele Anfragen. Bitte warte einen Moment.');
    }
    next();
  };
  app.use('/api/auth', limitAuth);
  app.use('/pair', limitAuth);

  // ------------------------------------------------------------- API body
  app.use('/api', express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'POST') {
      // CSRF hardening: cross-site POSTs carry a foreign Origin; JSON-only bodies force a preflight.
      const origin = req.get('origin');
      if (origin && origin !== config.origin) return fail(res, 403, 'bad_origin', 'Ungültiger Ursprung.');
      if (!req.is('application/json')) return fail(res, 415, 'json_required', 'Ungültige Anfrage.');
    }
    next();
  });

  /** @type {import('express').RequestHandler} */
  const requireSession = (req, res, next) => {
    const session = getSession(req);
    if (!session) return fail(res, 401, 'unauthenticated', 'Nicht angemeldet.');
    res.locals.session = session;
    next();
  };

  // ----------------------------------------------------------- auth API
  app.get('/api/auth/status', (req, res) => {
    setup.ensure();
    const session = getSession(req);
    res.json({
      registered: store.registered,
      authenticated: Boolean(session),
      webauthn: true,
      ...(session ? { sessionExpiresAt: new Date(session.exp).toISOString() } : {}),
    });
  });

  app.post('/api/auth/register/options', async (req, res) => {
    if (store.registered) {
      return fail(res, 403, 'registration_closed', 'Die Registrierung ist geschlossen. Bitte mit dem Passkey anmelden.');
    }
    const ip = req.ip || 'unknown';
    const blockedFor = setupFailIp.blocked(ip) ?? setupFailGlobal.blocked('global');
    if (blockedFor !== null) {
      res.set('Retry-After', String(blockedFor));
      return fail(res, 429, 'setup_rate_limited', 'Zu viele falsche Setup-Codes. Bitte später erneut versuchen.');
    }
    if (!setup.check(req.body?.setupCode)) {
      setupFailIp.hit(ip);
      setupFailGlobal.hit('global');
      logger.warn(`[auth] Falscher Setup-Code von ${ip}`);
      return fail(res, 403, 'invalid_setup_code', 'Der Setup-Code ist falsch. Du findest ihn im Container-Log.');
    }
    const options = await generateRegistrationOptions({
      rpName: 'Whoop-plus',
      rpID: config.rpId,
      userName: 'whoop-plus',
      userDisplayName: 'Whoop-plus',
      userID: new Uint8Array(Buffer.from(store.refresh().userId, 'base64url')),
      attestationType: 'none',
      excludeCredentials: store.credentials.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    storeChallenge(res, options.challenge, 'register');
    res.json(options);
  });

  app.post('/api/auth/register/verify', async (req, res) => {
    const expectedChallenge = consumeChallenge(req, res, 'register');
    if (!expectedChallenge) {
      return fail(res, 400, 'challenge_expired', 'Die Anfrage ist abgelaufen. Bitte noch einmal versuchen.');
    }
    if (store.registered) {
      return fail(res, 403, 'registration_closed', 'Die Registrierung ist geschlossen.');
    }
    const response = req.body?.response;
    if (!response || typeof response !== 'object') {
      return fail(res, 400, 'bad_request', 'Ungültige Anfrage.');
    }
    let verification;
    try {
      verification = await verifyRegistration({
        response,
        expectedChallenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      logger.warn(`[auth] Passkey-Registrierung fehlgeschlagen: ${/** @type {Error} */ (err).message}`);
      return fail(res, 400, 'verification_failed', 'Der Passkey konnte nicht überprüft werden.');
    }
    if (!verification.verified || !verification.registrationInfo) {
      return fail(res, 400, 'verification_failed', 'Der Passkey konnte nicht überprüft werden.');
    }
    const info = verification.registrationInfo;
    const { credential } = info;
    store.addCredential({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? response.response?.transports ?? [],
      createdAt: new Date(now()).toISOString(),
      deviceLabel: deviceLabelFromUA(req.get('user-agent')),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
    setup.ensure();
    issueSession(res, 'passkey');
    logger.info('[auth] Passkey registriert. Die Registrierung ist jetzt dauerhaft GESCHLOSSEN.');
    res.json({ ok: true });
  });

  app.post('/api/auth/login/options', async (req, res) => {
    const creds = store.credentials;
    if (creds.length === 0) {
      return fail(res, 409, 'not_registered', 'Es ist noch kein Passkey eingerichtet.');
    }
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: 'preferred',
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    });
    storeChallenge(res, options.challenge, 'login');
    res.json(options);
  });

  app.post('/api/auth/login/verify', async (req, res) => {
    const expectedChallenge = consumeChallenge(req, res, 'login');
    if (!expectedChallenge) {
      return fail(res, 400, 'challenge_expired', 'Die Anfrage ist abgelaufen. Bitte noch einmal versuchen.');
    }
    const response = req.body?.response;
    const cred = response && typeof response.id === 'string' ? store.findCredential(response.id) : undefined;
    if (!cred) {
      return fail(res, 400, 'unknown_credential', 'Dieser Passkey ist hier nicht registriert.');
    }
    let verification;
    try {
      verification = await verifyAuthentication({
        response,
        expectedChallenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
          counter: cred.counter,
          transports: cred.transports,
        },
        requireUserVerification: false,
      });
    } catch (err) {
      logger.warn(`[auth] Passkey-Anmeldung fehlgeschlagen: ${/** @type {Error} */ (err).message}`);
      return fail(res, 400, 'verification_failed', 'Die Anmeldung mit dem Passkey ist fehlgeschlagen.');
    }
    if (!verification.verified) {
      return fail(res, 400, 'verification_failed', 'Die Anmeldung mit dem Passkey ist fehlgeschlagen.');
    }
    store.updateCredential(cred.id, {
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(now()).toISOString(),
    });
    issueSession(res, 'passkey');
    logger.info('[auth] Anmeldung mit Passkey erfolgreich.');
    res.json({ ok: true });
  });

  app.post('/api/auth/pair', requireSession, (req, res) => {
    sweep();
    if (pairings.size >= 20) {
      return fail(res, 429, 'too_many_pairings', 'Zu viele offene Kopplungs-Links. Bitte 10 Minuten warten.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + PAIR_TTL_MS;
    pairings.set(sha256(token), { expiresAt, generation: store.generation });
    logger.info(`[auth] Kopplungs-Link erstellt, gültig bis ${new Date(expiresAt).toISOString()}.`);
    res.json({ url: `${config.origin}/pair/${token}`, expiresAt: new Date(expiresAt).toISOString() });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.append('Set-Cookie', serializeCookie(sessionCookie, '', {
      maxAgeSec: 0, secure: config.cookieSecure, sameSite: 'Lax',
    }));
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => fail(res, 404, 'not_found', 'Nicht gefunden.'));

  // ------------------------------------------------------------ pairing
  app.get('/pair/:token', (req, res) => {
    res.set('Cache-Control', 'no-store');
    // Link previews / prefetchers often send HEAD — never burn the single-use token on those.
    if (req.method === 'HEAD') return res.status(204).end();
    const ip = req.ip || 'unknown';
    if (pairFailIp.blocked(ip) !== null) return res.redirect(302, '/login?pair=invalid');
    const key = sha256(String(req.params.token));
    const entry = pairings.get(key);
    pairings.delete(key); // single use, even if expired
    if (!entry || entry.expiresAt <= now() || entry.generation !== store.generation) {
      pairFailIp.hit(ip);
      logger.warn(`[auth] Ungültiger oder abgelaufener Kopplungs-Link von ${ip}`);
      return res.redirect(302, '/login?pair=invalid');
    }
    issueSession(res, 'pair');
    logger.info(`[auth] Gerät über Kopplungs-Link angemeldet (${deviceLabelFromUA(req.get('user-agent'))}).`);
    res.redirect(302, '/');
  });

  // --------------------------------------------------------- login page
  const sendLoginIndex = (/** @type {import('express').Response} */ res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(LOGIN_DIR, 'index.html'));
  };
  app.get('/login', (req, res) => sendLoginIndex(res));
  app.get('/login/vendor/simplewebauthn-browser.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(resolveWebAuthnBrowserBundle());
  });
  app.use('/login', express.static(LOGIN_DIR, {
    index: false,
    redirect: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }));
  app.get('/login/{*rest}', (req, res) => sendLoginIndex(res));

  // --------------------------------------------------------- auth gate
  app.use((req, res, next) => {
    const session = getSession(req);
    if (session) {
      res.locals.session = session;
      return next();
    }
    res.set('Cache-Control', 'no-store');
    if (isHtmlNavigation(req)) return res.redirect(302, '/login');
    return fail(res, 401, 'unauthenticated', 'Nicht angemeldet.');
  });

  // -------------------------------------------------------- static app
  const indexFile = path.join(config.staticDir, 'index.html');
  app.use(express.static(config.staticDir, {
    index: false,
    redirect: false,
    setHeaders: (res, filePath) => {
      const rel = path.relative(config.staticDir, filePath).split(path.sep).join('/');
      if (rel === 'index.html') res.set('Cache-Control', 'no-store');
      else if (rel.startsWith('assets/')) res.set('Cache-Control', 'private, max-age=31536000, immutable');
      else res.set('Cache-Control', 'no-cache');
    },
  }));

  // SPA fallback: extension-less GET/HEAD navigations get index.html.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const last = req.path.split('/').pop() || '';
    if (last.includes('.') && !isHtmlNavigation(req)) return next();
    if (!fs.existsSync(indexFile)) {
      res.set('Cache-Control', 'no-store');
      return res.status(503).type('text/plain').send('App ist nicht gebaut (index.html fehlt).');
    }
    res.set('Cache-Control', 'no-store');
    res.sendFile(indexFile);
  });

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Nicht gefunden');
  });

  /** @type {import('express').ErrorRequestHandler} */
  const onError = (err, req, res, _next) => {
    const status = Number(err?.status || err?.statusCode) || 500;
    if (status >= 500) logger.error(`[server] ${req.method} ${req.path}: ${err?.stack || err}`);
    if (res.headersSent) return;
    if (req.path.startsWith('/api/')) {
      return fail(res, status, status === 413 ? 'too_large' : status < 500 ? 'bad_request' : 'server_error',
        status < 500 ? 'Ungültige Anfrage.' : 'Interner Fehler.');
    }
    res.status(status).type('text/plain').send(status < 500 ? 'Ungültige Anfrage' : 'Interner Fehler');
  };
  app.use(onError);

  // Print the setup code right away if registration is still open.
  setup.ensure();

  return app;
}
