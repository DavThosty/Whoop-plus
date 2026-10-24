// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { AuthStore, loadSessionSecret } from '../store.js';
import { createApp } from '../app.js';

export const ORIGIN = 'https://whoop.example.test';
export const RP_ID = 'whoop.example.test';

/** Create a temp dir under the OS tmp dir. */
export function tmpDir(prefix = 'whoop-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fake frontend build. */
export function makeStaticDir() {
  const dir = tmpDir('whoop-static-');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>APP</title><div id="app">FAKE-APP</div>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("app")');
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
  return dir;
}

export function stubVerifyRegistration() {
  /** @type {any[]} */
  const calls = [];
  /** @param {any} opts */
  const fn = async (opts) => {
    calls.push(opts);
    return {
      verified: true,
      registrationInfo: {
        credential: {
          id: opts.response.id || 'cred-1',
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: ['internal', 'hybrid'],
        },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    };
  };
  return Object.assign(fn, { calls });
}

export function stubVerifyAuthentication() {
  /** @type {any[]} */
  const calls = [];
  /** @param {any} opts */
  const fn = async (opts) => {
    calls.push(opts);
    return { verified: true, authenticationInfo: { credentialID: opts.credential.id, newCounter: opts.credential.counter + 1 } };
  };
  return Object.assign(fn, { calls });
}

/**
 * Spin up an app on a random port with stubbed WebAuthn verification and a controllable clock.
 * @param {{ env?: Record<string,string>, dataDir?: string, verifyRegistration?: any, verifyAuthentication?: any }} [opts]
 */
export async function startTestApp(opts = {}) {
  const dataDir = opts.dataDir || tmpDir('whoop-data-');
  const staticDir = makeStaticDir();
  const config = loadConfig({
    RP_ID,
    ORIGIN,
    DATA_DIR: dataDir,
    STATIC_DIR: staticDir,
    ...opts.env,
  });
  const store = new AuthStore(config.dataDir);
  const sessionSecret = loadSessionSecret(config.dataDir, config.sessionSecret);
  /** @type {string[]} */
  const logs = [];
  const logger = {
    info: (/** @type {string} */ m) => logs.push(m),
    warn: (/** @type {string} */ m) => logs.push(m),
    error: (/** @type {string} */ m) => logs.push(m),
  };
  const clock = { t: Date.now() };
  const verifyRegistration = opts.verifyRegistration || stubVerifyRegistration();
  const verifyAuthentication = opts.verifyAuthentication || stubVerifyAuthentication();
  const app = createApp({
    config,
    store,
    sessionSecret,
    logger,
    now: () => clock.t,
    // @ts-ignore stub
    verifyRegistration,
    // @ts-ignore stub
    verifyAuthentication,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  // @ts-ignore
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    app,
    ctx: app.locals.ctx,
    config,
    store,
    sessionSecret,
    dataDir,
    staticDir,
    logs,
    clock,
    verifyRegistration,
    verifyAuthentication,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * fetch wrapper: never follows redirects, JSON helper, cookie header.
 * @param {string} url
 * @param {{ method?: string, json?: any, cookie?: string, headers?: Record<string,string> }} [opts]
 */
export async function req(url, opts = {}) {
  /** @type {Record<string,string>} */
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  let body;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(url, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { res, status: res.status, text, data, setCookies: res.headers.getSetCookie() };
}

/**
 * Turn Set-Cookie headers into a Cookie request header (ignoring cleared cookies).
 * @param {string[]} setCookies
 * @param {string} [existing]
 */
export function cookieJar(setCookies, existing = '') {
  /** @type {Map<string,string>} */
  const jar = new Map();
  for (const part of existing.split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (/Max-Age=0/i.test(sc)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Run the full (stubbed) registration flow. Returns the session cookie header.
 * @param {Awaited<ReturnType<typeof startTestApp>>} t
 * @param {Record<string,string>} [headers]
 */
export async function register(t, headers = {}) {
  const code = t.ctx.setup.code;
  const opt = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: code }, headers });
  if (opt.status !== 200) throw new Error(`register/options ${opt.status} ${opt.text}`);
  const chal = cookieJar(opt.setCookies);
  const ver = await req(`${t.base}/api/auth/register/verify`, {
    json: { response: { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: { transports: ['internal'] } } },
    cookie: chal,
    headers,
  });
  if (ver.status !== 200) throw new Error(`register/verify ${ver.status} ${ver.text}`);
  return { cookie: cookieJar(ver.setCookies), options: opt.data, verify: ver };
}

export const randomIp = () => `10.${crypto.randomInt(255)}.${crypto.randomInt(255)}.${crypto.randomInt(255)}`;
