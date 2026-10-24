// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { signSession, verifySession, parseCookies, serializeCookie } from '../session.js';
import { generateSetupCode, setupCodeMatches, normalizeSetupCode, SETUP_ALPHABET } from '../setupcode.js';
import { loadConfig, parseTrustProxy } from '../config.js';
import { AuthStore, loadSessionSecret } from '../store.js';
import { RateLimiter } from '../ratelimit.js';
import { deviceLabelFromUA } from '../app.js';
import { tmpDir } from './helpers.js';

const secret = Buffer.alloc(32, 1);

test('session tokens round-trip and enforce expiry and generation', () => {
  const now = 1_700_000_000_000;
  const { token, payload } = signSession(secret, { generation: 3, now, ttlMs: 1000, via: 'pair' });
  assert.deepEqual(verifySession(secret, token, { generation: 3, now: now + 999 }), payload);
  assert.equal(verifySession(secret, token, { generation: 3, now: now + 1000 }), null);
  assert.equal(verifySession(secret, token, { generation: 4, now }), null);
  assert.equal(verifySession(Buffer.alloc(32, 2), token, { generation: 3, now }), null);
  assert.equal(verifySession(secret, `${token}x`, { generation: 3, now }), null);
  assert.equal(verifySession(secret, undefined, { generation: 3, now }), null);
  assert.equal(verifySession(secret, 'a.b.c', { generation: 3, now }), null);
});

test('cookie helpers', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world; a=2'), { a: '1', b: 'hello world' });
  const c = serializeCookie('x', 'y', { maxAgeSec: 60 });
  assert.match(c, /^x=y; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=60; Expires=/);
});

test('setup codes are 4x4 chars from an unambiguous alphabet', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateSetupCode();
    assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    for (const ch of code.replace(/-/g, '')) assert.ok(SETUP_ALPHABET.includes(ch));
  }
  assert.doesNotMatch(SETUP_ALPHABET, /[01OIL]/);
  assert.equal(normalizeSetupCode(' ab-cd ef '), 'ABCDEF');
  assert.ok(setupCodeMatches('abcd efgh', 'ABCD-EFGH'));
  assert.ok(!setupCodeMatches('ABCD', 'ABCD-EFGH'));
  assert.ok(!setupCodeMatches('', ''));
  assert.ok(!setupCodeMatches(undefined, 'X'));
});

test('config defaults and TRUST_PROXY parsing', () => {
  const c = loadConfig({});
  assert.equal(c.rpId, 'whoop.steiner-kn.de');
  assert.equal(c.origin, 'https://whoop.steiner-kn.de');
  assert.equal(c.port, 8080);
  assert.equal(c.dataDir, '/data');
  assert.equal(c.sessionDays, 30);
  assert.equal(c.trustProxy, 1);
  assert.equal(c.resetAuth, false);
  assert.equal(c.cookieSecure, true);
  assert.equal(loadConfig({ RESET_AUTH: '1' }).resetAuth, true);
  assert.equal(loadConfig({ ORIGIN: 'https://x.test/' }).origin, 'https://x.test');
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('loopback, 172.16.0.0/12'), 'loopback, 172.16.0.0/12');
});

test('store writes atomically and persists credentials as an array', () => {
  const dir = tmpDir();
  const s = new AuthStore(dir);
  assert.equal(s.registered, false);
  s.addCredential({ id: 'a', publicKey: 'AA', counter: 0, transports: [], createdAt: 'x', deviceLabel: 'd' });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  assert.ok(Array.isArray(raw.credentials));
  assert.equal(raw.credentials[0].id, 'a');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.equal((fs.statSync(path.join(dir, 'auth.json')).mode & 0o777).toString(8), '600');
  const s2 = new AuthStore(dir);
  assert.equal(s2.registered, true);
  const r = s2.reset();
  assert.deepEqual(r, { removed: 1, generation: 2 });
  assert.equal(s.registered, false, 'first instance sees the change from disk');
  assert.equal(s.generation, 2);
});

test('session secret is generated once and persisted', () => {
  const dir = tmpDir();
  const a = loadSessionSecret(dir);
  const b = loadSessionSecret(dir);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  assert.deepEqual(loadSessionSecret(dir, 'x'.repeat(40)), Buffer.from('x'.repeat(40)));
});

test('rate limiter', () => {
  let t = 0;
  const rl = new RateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(rl.hit('a').allowed, true);
  assert.equal(rl.hit('a').allowed, true);
  assert.equal(rl.hit('a').allowed, false);
  assert.ok(rl.blocked('a'));
  assert.equal(rl.hit('b').allowed, true);
  t = 1000;
  assert.equal(rl.blocked('a'), null);
  assert.equal(rl.hit('a').allowed, true);
});

test('device label from user agent', () => {
  assert.equal(
    deviceLabelFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),
    'iPhone · Safari',
  );
  assert.equal(deviceLabelFromUA(undefined), 'Unbekanntes Gerät');
});
