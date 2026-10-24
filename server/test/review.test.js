// @ts-check
// Regression tests for the issues found in the independent security review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, req, cookieJar, register, randomIp, stubVerifyRegistration, ORIGIN } from './helpers.js';
import { MAX_CHALLENGES } from '../app.js';

const HTML = { accept: 'text/html' };

test('concurrent register/verify requests cannot both register (re-check after await)', async () => {
  const inner = stubVerifyRegistration();
  /** @param {any} opts */
  const slowVerify = async (opts) => {
    await new Promise((r) => setTimeout(r, 50));
    return inner(opts);
  };
  const t = await startTestApp({ verifyRegistration: slowVerify });
  try {
    const code = t.ctx.setup.code;
    const a = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: code } });
    const b = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: code } });
    const [ra, rb] = await Promise.all([
      req(`${t.base}/api/auth/register/verify`, { json: { response: { id: 'cred-a', response: {} } }, cookie: cookieJar(a.setCookies) }),
      req(`${t.base}/api/auth/register/verify`, { json: { response: { id: 'cred-b', response: {} } }, cookie: cookieJar(b.setCookies) }),
    ]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 403]);
    const loser = ra.status === 403 ? ra : rb;
    assert.equal(loser.data.error, 'registration_closed');
    assert.ok(!loser.setCookies.some((c) => c.startsWith('__Host-wp_session=')), 'loser gets no session');
    assert.equal(inner.calls.length, 2, 'both really went through the (slow) verification');
    assert.equal(t.store.credentials.length, 1);
  } finally {
    await t.close();
  }
});

test('deleting auth.json does not revive old sessions or pairing links', async () => {
  const t = await startTestApp();
  try {
    const { cookie } = await register(t);
    const genBefore = t.store.generation;
    const pair = await req(`${t.base}/api/auth/pair`, { json: {}, cookie });
    assert.equal(pair.status, 200);
    assert.equal((await req(`${t.base}/`, { cookie, headers: HTML })).status, 200);

    fs.unlinkSync(path.join(t.dataDir, 'auth.json'));

    // The recreated file starts at the same generation again – only the userId binding catches this.
    assert.equal(t.store.generation, genBefore);
    assert.equal((await req(`${t.base}/`, { cookie, headers: HTML })).status, 302);
    const status = await req(`${t.base}/api/auth/status`, { cookie });
    assert.equal(status.data.authenticated, false);
    assert.equal(status.data.registered, false);
    const use = await req(pair.data.url.replace(ORIGIN, t.base), { headers: HTML });
    assert.equal(use.res.headers.get('location'), '/login?pair=invalid');
  } finally {
    await t.close();
  }
});

test('failed setup codes from many IPs cannot lock the owner out', async () => {
  const t = await startTestApp();
  try {
    for (let i = 0; i < 40; i++) {
      const r = await req(`${t.base}/api/auth/register/options`, {
        json: { setupCode: 'WRONG' }, headers: { 'x-forwarded-for': randomIp() },
      });
      assert.equal(r.status, 403);
    }
    const owner = await req(`${t.base}/api/auth/register/options`, {
      json: { setupCode: t.ctx.setup.code }, headers: { 'x-forwarded-for': '192.0.2.10' },
    });
    assert.equal(owner.status, 200);
  } finally {
    await t.close();
  }
});

test('only passkey sessions may create pairing links', async () => {
  const t = await startTestApp();
  try {
    const { cookie } = await register(t);
    const p = await req(`${t.base}/api/auth/pair`, { json: {}, cookie });
    assert.equal(p.status, 200);
    const use = await req(p.data.url.replace(ORIGIN, t.base), { headers: HTML });
    const paired = cookieJar(use.setCookies);

    const status = await req(`${t.base}/api/auth/status`, { cookie: paired });
    assert.equal(status.data.authenticated, true);
    assert.equal(status.data.sessionVia, 'pair');
    assert.equal((await req(`${t.base}/api/auth/status`, { cookie })).data.sessionVia, 'passkey');

    const renew = await req(`${t.base}/api/auth/pair`, { json: {}, cookie: paired });
    assert.equal(renew.status, 403);
    assert.equal(renew.data.error, 'pairing_requires_passkey');
    assert.match(renew.data.message, /Passkey/);

    // A passkey login (not only registration) may pair.
    const opt = await req(`${t.base}/api/auth/login/options`, { json: {} });
    const ver = await req(`${t.base}/api/auth/login/verify`, { json: { response: { id: 'cred-1' } }, cookie: cookieJar(opt.setCookies) });
    const p2 = await req(`${t.base}/api/auth/pair`, { json: {}, cookie: cookieJar(ver.setCookies) });
    assert.equal(p2.status, 200);
  } finally {
    await t.close();
  }
});

test('a full challenge store evicts the oldest challenge instead of clearing everything', async () => {
  const t = await startTestApp();
  try {
    await register(t);
    const oldest = await req(`${t.base}/api/auth/login/options`, { json: {} });
    const keep = await req(`${t.base}/api/auth/login/options`, { json: {} });
    /** @type {Map<string, any>} */
    const map = t.ctx.challenges;
    for (let i = 0; map.size < MAX_CHALLENGES; i++) {
      map.set(`fake-${i}`, { challenge: 'x', kind: 'login', expiresAt: t.clock.t + 60_000 });
    }
    const fresh = await req(`${t.base}/api/auth/login/options`, { json: {} });
    assert.equal(map.size, MAX_CHALLENGES);

    const body = { json: { response: { id: 'cred-1' } } };
    const vOld = await req(`${t.base}/api/auth/login/verify`, { ...body, cookie: cookieJar(oldest.setCookies) });
    assert.equal(vOld.status, 400, 'oldest challenge evicted');
    const vKeep = await req(`${t.base}/api/auth/login/verify`, { ...body, cookie: cookieJar(keep.setCookies) });
    assert.equal(vKeep.status, 200, 'second-oldest challenge survives');
    const vFresh = await req(`${t.base}/api/auth/login/verify`, { ...body, cookie: cookieJar(fresh.setCookies) });
    assert.equal(vFresh.status, 200, 'new challenge works');
  } finally {
    await t.close();
  }
});

test('login page only offers "Bluefy koppeln" to passkey sessions', async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'login', 'login.js'), 'utf8');
  assert.match(src, /status\.sessionVia === 'passkey'\)\s*\{\s*show\('view-pair'\)/);
  assert.equal((src.match(/show\('view-pair'\)/g) || []).length, 1, 'pair view shown in exactly one place');
  assert.match(src, /pairing_requires_passkey/);
  // The page sends JSON bodies for pair/logout (server requires application/json).
  assert.match(src, /api\('\/api\/auth\/pair', \{\}\)/);
  assert.match(src, /api\('\/api\/auth\/logout', \{\}\)/);
  assert.match(src, /'Content-Type'\] = 'application\/json'/);
});
