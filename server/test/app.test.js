// @ts-check
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startTestApp, req, cookieJar, register, ORIGIN, RP_ID, randomIp } from './helpers.js';
import { signSession } from '../session.js';
import { CSP, PAIR_TTL_MS, CHALLENGE_TTL_MS } from '../app.js';

/** @type {Awaited<ReturnType<typeof startTestApp>>} */
let t;
beforeEach(async () => { t = await startTestApp(); });
afterEach(async () => { await t.close(); });

const HTML = { accept: 'text/html,application/xhtml+xml' };
const SESSION = '__Host-wp_session';

describe('public endpoints and headers', () => {
  test('GET /healthz is public and returns ok', async () => {
    const r = await req(`${t.base}/healthz`);
    assert.equal(r.status, 200);
    assert.equal(r.text, 'ok');
  });

  test('security headers are set on every response', async () => {
    for (const p of ['/healthz', '/login', '/', '/assets/index-abc123.js', '/api/auth/status']) {
      const { res } = await req(`${t.base}${p}`);
      assert.equal(res.headers.get('content-security-policy'), CSP, p);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', p);
      assert.match(res.headers.get('permissions-policy') || '', /bluetooth=\(self\)/, p);
      assert.match(res.headers.get('strict-transport-security') || '', /max-age=\d+/, p);
      assert.equal(res.headers.get('x-powered-by'), null, p);
    }
    assert.match(CSP, /default-src 'self'/);
    assert.match(CSP, /script-src 'self'(;|$)/);
    assert.match(CSP, /frame-ancestors 'none'/);
    assert.match(CSP, /base-uri 'none'/);
  });

  test('login page, its assets and the WebAuthn browser bundle are public', async () => {
    const page = await req(`${t.base}/login`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Whoop-plus/);
    assert.match(page.text, /src="\/login\/vendor\/simplewebauthn-browser\.js"/);
    assert.doesNotMatch(page.text, /<script>(?!<)/, 'no inline scripts');
    assert.equal(page.res.headers.get('cache-control'), 'no-store');
    const js = await req(`${t.base}/login/login.js`);
    assert.equal(js.status, 200);
    assert.match(js.res.headers.get('content-type') || '', /javascript/);
    const css = await req(`${t.base}/login/login.css`);
    assert.equal(css.status, 200);
    assert.match(css.res.headers.get('content-type') || '', /css/);
    const vendor = await req(`${t.base}/login/vendor/simplewebauthn-browser.js`);
    assert.equal(vendor.status, 200);
    assert.match(vendor.res.headers.get('content-type') || '', /javascript/);
    assert.match(vendor.text, /SimpleWebAuthnBrowser/);
    const sub = await req(`${t.base}/login/anything`);
    assert.equal(sub.status, 200);
    assert.match(sub.text, /Whoop-plus/);
  });

  test('status reports unregistered + unauthenticated', async () => {
    const r = await req(`${t.base}/api/auth/status`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { registered: false, authenticated: false, webauthn: true });
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
  });
});

describe('access control', () => {
  test('unauthenticated HTML navigation redirects to /login', async () => {
    for (const p of ['/', '/index.html', '/some/deep/route']) {
      const r = await req(`${t.base}${p}`, { headers: HTML });
      assert.equal(r.status, 302, p);
      assert.equal(r.res.headers.get('location'), '/login', p);
    }
    // fetch() overrides Sec-Fetch-Mode, so use node:http for a "real" navigation request.
    const navStatus = await new Promise((resolve, reject) => {
      http.get(`${t.base}/`, { headers: { 'sec-fetch-mode': 'navigate', accept: '*/*' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(navStatus, 302);
  });

  test('unauthenticated non-HTML requests get 401', async () => {
    for (const p of ['/assets/index-abc123.js', '/manifest.webmanifest', '/']) {
      const r = await req(`${t.base}${p}`, { headers: { accept: '*/*' } });
      assert.equal(r.status, 401, p);
      assert.doesNotMatch(r.text, /FAKE-APP|console\.log/);
    }
    const pair = await req(`${t.base}/api/auth/pair`, { json: {} });
    assert.equal(pair.status, 401);
  });

  test('a valid session cookie grants access to static files with correct caching', async () => {
    const { cookie } = await register(t);
    const index = await req(`${t.base}/`, { cookie, headers: HTML });
    assert.equal(index.status, 200);
    assert.match(index.text, /FAKE-APP/);
    assert.equal(index.res.headers.get('cache-control'), 'no-store');

    const direct = await req(`${t.base}/index.html`, { cookie });
    assert.equal(direct.status, 200);
    assert.equal(direct.res.headers.get('cache-control'), 'no-store');

    const asset = await req(`${t.base}/assets/index-abc123.js`, { cookie });
    assert.equal(asset.status, 200);
    assert.match(asset.res.headers.get('cache-control') || '', /max-age=31536000/);
    assert.match(asset.res.headers.get('cache-control') || '', /private/);

    const spa = await req(`${t.base}/history/2026-10-01`, { cookie, headers: HTML });
    assert.equal(spa.status, 200);
    assert.match(spa.text, /FAKE-APP/);

    const missing = await req(`${t.base}/assets/nope.js`, { cookie });
    assert.equal(missing.status, 404);
  });

  test('expired, forged, tampered and old-generation tokens are rejected', async () => {
    const { cookie } = await register(t);
    const ok = await req(`${t.base}/`, { cookie, headers: HTML });
    assert.equal(ok.status, 200);

    const day = 24 * 3600 * 1000;
    const expired = signSession(t.sessionSecret, {
      generation: t.store.generation, now: t.clock.t - 31 * day, ttlMs: 30 * day, via: 'passkey',
    }).token;
    assert.equal((await req(`${t.base}/`, { cookie: `${SESSION}=${expired}`, headers: HTML })).status, 302);

    const forged = signSession(Buffer.alloc(32, 7), {
      generation: t.store.generation, now: t.clock.t, ttlMs: day, via: 'passkey',
    }).token;
    assert.equal((await req(`${t.base}/`, { cookie: `${SESSION}=${forged}`, headers: HTML })).status, 302);

    const valid = signSession(t.sessionSecret, { generation: t.store.generation, now: t.clock.t, ttlMs: day, via: 'passkey' }).token;
    const [body, sig] = valid.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.exp += 365 * day;
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    assert.equal((await req(`${t.base}/`, { cookie: `${SESSION}=${tampered}`, headers: HTML })).status, 302);
    assert.equal((await req(`${t.base}/`, { cookie: `${SESSION}=garbage`, headers: HTML })).status, 302);

    const oldGen = signSession(t.sessionSecret, {
      generation: t.store.generation - 1, now: t.clock.t, ttlMs: day, via: 'passkey',
    }).token;
    assert.equal((await req(`${t.base}/`, { cookie: `${SESSION}=${oldGen}`, headers: HTML })).status, 302);

    // Session expires after SESSION_DAYS
    t.clock.t += 30 * day + 1000;
    assert.equal((await req(`${t.base}/`, { cookie, headers: HTML })).status, 302);
  });
});

describe('registration', () => {
  test('the setup code is printed to the log while unregistered', () => {
    const code = t.ctx.setup.code;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(t.logs.some((l) => l.includes(code) && l.includes('SETUP-CODE')));
  });

  test('register/options requires the correct setup code', async () => {
    const none = await req(`${t.base}/api/auth/register/options`, { json: {} });
    assert.equal(none.status, 403);
    assert.equal(none.data.error, 'invalid_setup_code');
    const wrong = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: 'AAAA-AAAA-AAAA-AAAA' } });
    assert.equal(wrong.status, 403);
    // case/whitespace-insensitive
    const sloppy = t.ctx.setup.code.toLowerCase().replace(/-/g, ' ');
    const ok = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: sloppy } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.rp.id, RP_ID);
    assert.equal(ok.data.attestation, 'none');
    assert.equal(ok.data.authenticatorSelection.residentKey, 'preferred');
    assert.equal(ok.data.authenticatorSelection.userVerification, 'preferred');
    assert.ok(ok.data.challenge);
    const chal = ok.setCookies.find((c) => c.startsWith('wp_chal='));
    assert.ok(chal);
    assert.match(chal, /HttpOnly/);
    assert.match(chal, /Path=\/api\/auth/);
    assert.match(chal, /Max-Age=300/);
  });

  test('setup code attempts are rate-limited per IP (also blocks the correct code)', async () => {
    const ip = randomIp();
    for (let i = 0; i < 5; i++) {
      const r = await req(`${t.base}/api/auth/register/options`, {
        json: { setupCode: 'WRONG' }, headers: { 'x-forwarded-for': ip },
      });
      assert.equal(r.status, 403);
    }
    const blocked = await req(`${t.base}/api/auth/register/options`, {
      json: { setupCode: t.ctx.setup.code }, headers: { 'x-forwarded-for': ip },
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.res.headers.get('retry-after'));
    // Another client IP (via trusted proxy header) is not affected.
    const other = await req(`${t.base}/api/auth/register/options`, {
      json: { setupCode: t.ctx.setup.code }, headers: { 'x-forwarded-for': randomIp() },
    });
    assert.equal(other.status, 200);
    // After the window the IP may try again.
    t.clock.t += 15 * 60_000 + 1;
    const later = await req(`${t.base}/api/auth/register/options`, {
      json: { setupCode: t.ctx.setup.code }, headers: { 'x-forwarded-for': ip },
    });
    assert.equal(later.status, 200);
  });

  test('registration stores the credential, sets a session and closes registration for good', async () => {
    const { cookie, verify } = await register(t);
    const sc = verify.setCookies.find((c) => c.startsWith(`${SESSION}=`));
    assert.ok(sc, 'session cookie set');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /Secure/);
    assert.match(sc, /SameSite=Lax/);
    assert.match(sc, /Path=\//);
    assert.match(sc, new RegExp(`Max-Age=${30 * 24 * 3600}`));

    const call = t.verifyRegistration.calls[0];
    assert.equal(call.expectedOrigin, ORIGIN);
    assert.equal(call.expectedRPID, RP_ID);
    assert.equal(typeof call.expectedChallenge, 'string');

    const file = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'auth.json'), 'utf8'));
    assert.equal(file.credentials.length, 1);
    const cred = file.credentials[0];
    assert.equal(cred.id, 'cred-1');
    assert.equal(cred.publicKey, Buffer.from([1, 2, 3, 4]).toString('base64url'));
    assert.equal(cred.counter, 0);
    assert.deepEqual(cred.transports, ['internal', 'hybrid']);
    assert.ok(cred.createdAt);
    assert.ok(cred.deviceLabel);

    const status = await req(`${t.base}/api/auth/status`, { cookie });
    assert.equal(status.data.registered, true);
    assert.equal(status.data.authenticated, true);
    assert.ok(t.logs.some((l) => /GESCHLOSSEN/.test(l)));
    assert.equal(t.ctx.setup.code, null, 'setup code forgotten');

    const again = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: 'anything' } });
    assert.equal(again.status, 403);
    assert.equal(again.data.error, 'registration_closed');
  });

  test('a second verify with a stale register challenge cannot add a credential', async () => {
    const code = t.ctx.setup.code;
    const a = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: code } });
    const b = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: code } });
    const body = { response: { id: 'cred-1', response: {} } };
    const va = await req(`${t.base}/api/auth/register/verify`, { json: body, cookie: cookieJar(a.setCookies) });
    assert.equal(va.status, 200);
    const vb = await req(`${t.base}/api/auth/register/verify`, {
      json: { response: { id: 'cred-2', response: {} } }, cookie: cookieJar(b.setCookies),
    });
    assert.equal(vb.status, 403);
    assert.equal(t.store.credentials.length, 1);
  });

  test('challenges are single-use and expire after 5 minutes', async () => {
    const code = t.ctx.setup.code;
    const body = { response: { id: 'cred-1', response: {} } };
    const noCookie = await req(`${t.base}/api/auth/register/verify`, { json: body });
    assert.equal(noCookie.status, 400);
    assert.equal(noCookie.data.error, 'challenge_expired');

    const opt = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: code } });
    t.clock.t += CHALLENGE_TTL_MS + 1;
    const late = await req(`${t.base}/api/auth/register/verify`, { json: body, cookie: cookieJar(opt.setCookies) });
    assert.equal(late.status, 400);
    assert.equal(late.data.error, 'challenge_expired');
    assert.equal(t.store.credentials.length, 0);

    const { cookie } = await register(t);
    // Login challenge reuse
    const lo = await req(`${t.base}/api/auth/login/options`, { json: {} });
    const chal = cookieJar(lo.setCookies);
    const v1 = await req(`${t.base}/api/auth/login/verify`, { json: { response: { id: 'cred-1' } }, cookie: chal });
    assert.equal(v1.status, 200);
    const v2 = await req(`${t.base}/api/auth/login/verify`, { json: { response: { id: 'cred-1' } }, cookie: chal });
    assert.equal(v2.status, 400);
    assert.ok(cookie);
  });

  test('verification failures are reported without storing anything or issuing a session', async () => {
    for (const impl of [async () => { throw new Error('bad signature'); }, async () => ({ verified: false })]) {
      const failing = await startTestApp({ verifyRegistration: impl });
      try {
        const opt = await req(`${failing.base}/api/auth/register/options`, { json: { setupCode: failing.ctx.setup.code } });
        const bad = await req(`${failing.base}/api/auth/register/verify`, {
          json: { response: { id: 'x', response: {} } }, cookie: cookieJar(opt.setCookies),
        });
        assert.equal(bad.status, 400);
        assert.equal(bad.data.error, 'verification_failed');
        assert.ok(!bad.setCookies.some((c) => c.startsWith(`${SESSION}=`)));
        assert.equal(failing.store.credentials.length, 0);
        assert.ok(failing.ctx.setup.code, 'registration still open');
      } finally {
        await failing.close();
      }
    }
  });
});

describe('login', () => {
  test('login options require a registered credential', async () => {
    const r = await req(`${t.base}/api/auth/login/options`, { json: {} });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'not_registered');
  });

  test('login flow issues a session and updates the counter', async () => {
    await register(t);
    const opt = await req(`${t.base}/api/auth/login/options`, { json: {} });
    assert.equal(opt.status, 200);
    assert.equal(opt.data.rpId, RP_ID);
    assert.equal(opt.data.userVerification, 'preferred');
    assert.deepEqual(opt.data.allowCredentials.map((/** @type {any} */ c) => c.id), ['cred-1']);

    const unknown = await req(`${t.base}/api/auth/login/verify`, {
      json: { response: { id: 'nope' } }, cookie: cookieJar(opt.setCookies),
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.data.error, 'unknown_credential');

    const opt2 = await req(`${t.base}/api/auth/login/options`, { json: {} });
    const ver = await req(`${t.base}/api/auth/login/verify`, {
      json: { response: { id: 'cred-1' } }, cookie: cookieJar(opt2.setCookies),
    });
    assert.equal(ver.status, 200);
    const cookie = cookieJar(ver.setCookies);
    assert.match(cookie, new RegExp(`${SESSION}=`));
    const call = t.verifyAuthentication.calls.at(-1);
    assert.equal(call.expectedOrigin, ORIGIN);
    assert.equal(call.expectedRPID, RP_ID);
    assert.deepEqual([...call.credential.publicKey], [1, 2, 3, 4]);
    assert.equal(t.store.findCredential('cred-1')?.counter, 1);
    assert.equal((await req(`${t.base}/`, { cookie, headers: HTML })).status, 200);
  });

  test('failed authentication does not issue a session', async () => {
    await register(t);
    for (const impl of [async () => { throw new Error('bad signature'); }, async () => ({ verified: false, authenticationInfo: {} })]) {
      const app2 = await startTestApp({ dataDir: t.dataDir, verifyAuthentication: impl });
      try {
        const opt = await req(`${app2.base}/api/auth/login/options`, { json: {} });
        const r = await req(`${app2.base}/api/auth/login/verify`, {
          json: { response: { id: 'cred-1' } }, cookie: cookieJar(opt.setCookies),
        });
        assert.equal(r.status, 400);
        assert.equal(r.data.error, 'verification_failed');
        assert.ok(!r.setCookies.some((c) => c.startsWith(`${SESSION}=`)));
        assert.equal(app2.store.findCredential('cred-1')?.counter, 0);
      } finally {
        await app2.close();
      }
    }
  });

  test('logout clears the session cookie', async () => {
    const { cookie } = await register(t);
    const r = await req(`${t.base}/api/auth/logout`, { json: {}, cookie });
    assert.equal(r.status, 200);
    assert.ok(r.setCookies.some((c) => c.startsWith(`${SESSION}=;`) && /Max-Age=0/.test(c)));
  });
});

describe('pairing links', () => {
  test('creates a single-use link that logs in another browser', async () => {
    const { cookie } = await register(t);
    const p = await req(`${t.base}/api/auth/pair`, { json: {}, cookie });
    assert.equal(p.status, 200);
    assert.match(p.data.url, new RegExp(`^${ORIGIN}/pair/[A-Za-z0-9_-]{40,}$`));
    const exp = Date.parse(p.data.expiresAt);
    assert.ok(Math.abs(exp - (t.clock.t + PAIR_TTL_MS)) < 1000);
    assert.ok(!t.logs.some((l) => l.includes(p.data.url.split('/pair/')[1])), 'token not logged');

    const local = p.data.url.replace(ORIGIN, t.base);
    // HEAD (link previews) does not consume the token
    const head = await fetch(local, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, 204);

    const use = await req(local, { headers: HTML });
    assert.equal(use.status, 302);
    assert.equal(use.res.headers.get('location'), '/');
    const bluefy = cookieJar(use.setCookies);
    assert.match(bluefy, new RegExp(`${SESSION}=`));
    const sc = use.setCookies.find((c) => c.startsWith(`${SESSION}=`)) || '';
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /Secure/);
    assert.match(sc, /SameSite=Lax/);
    assert.equal((await req(`${t.base}/`, { cookie: bluefy, headers: HTML })).status, 200);

    const reuse = await req(local, { headers: HTML });
    assert.equal(reuse.status, 302);
    assert.equal(reuse.res.headers.get('location'), '/login?pair=invalid');
    assert.equal(reuse.setCookies.length, 0);
  });

  test('links expire after 10 minutes', async () => {
    const { cookie } = await register(t);
    const p = await req(`${t.base}/api/auth/pair`, { json: {}, cookie });
    t.clock.t += PAIR_TTL_MS + 1;
    const use = await req(p.data.url.replace(ORIGIN, t.base), { headers: HTML });
    assert.equal(use.status, 302);
    assert.equal(use.res.headers.get('location'), '/login?pair=invalid');
  });

  test('unknown tokens redirect to the login page', async () => {
    const r = await req(`${t.base}/pair/${'x'.repeat(43)}`, { headers: HTML });
    assert.equal(r.status, 302);
    assert.equal(r.res.headers.get('location'), '/login?pair=invalid');
  });

  test('links die with a reset (generation bump)', async () => {
    const { cookie } = await register(t);
    const p = await req(`${t.base}/api/auth/pair`, { json: {}, cookie });
    t.store.reset();
    const use = await req(p.data.url.replace(ORIGIN, t.base), { headers: HTML });
    assert.equal(use.res.headers.get('location'), '/login?pair=invalid');
  });
});

describe('request hardening', () => {
  test('cross-origin and non-JSON POSTs are refused', async () => {
    const { cookie } = await register(t);
    const evil = await req(`${t.base}/api/auth/pair`, { json: {}, cookie, headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const same = await req(`${t.base}/api/auth/pair`, { json: {}, cookie, headers: { origin: ORIGIN } });
    assert.equal(same.status, 200);
    const form = await fetch(`${t.base}/api/auth/pair`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b',
    });
    assert.equal(form.status, 415);
  });

  test('oversized JSON bodies are rejected', async () => {
    const r = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: 'x'.repeat(40_000) } });
    assert.equal(r.status, 413);
  });

  test('/api/auth/* is rate limited', async () => {
    const ip = randomIp();
    let last;
    for (let i = 0; i < 61; i++) {
      last = await req(`${t.base}/api/auth/status`, { headers: { 'x-forwarded-for': ip } });
    }
    assert.equal(last?.status, 429);
  });
});
