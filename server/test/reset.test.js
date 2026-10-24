// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestApp, req, register, tmpDir, makeStaticDir } from './helpers.js';
import { AuthStore } from '../store.js';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = { accept: 'text/html' };

/** Seed a data dir with one credential. */
function seededDataDir() {
  const dataDir = tmpDir('whoop-reset-');
  const store = new AuthStore(dataDir);
  store.addCredential({
    id: 'cred-old', publicKey: 'AQID', counter: 5, transports: ['internal'],
    createdAt: new Date().toISOString(), deviceLabel: 'iPhone · Safari',
  });
  return { dataDir, generation: store.generation };
}

test('reset.js wipes credentials, bumps the generation and the running server picks it up', async () => {
  const t = await startTestApp();
  try {
    const { cookie } = await register(t);
    assert.equal((await req(`${t.base}/`, { cookie, headers: HTML })).status, 200);
    const genBefore = t.store.generation;

    const out = spawnSync(process.execPath, [path.join(SERVER_DIR, 'reset.js')], {
      env: { ...process.env, DATA_DIR: t.dataDir },
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /zurückgesetzt/);
    assert.match(out.stdout, /Entfernte Passkeys: 1/);

    const file = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'auth.json'), 'utf8'));
    assert.equal(file.credentials.length, 0);
    assert.equal(file.generation, genBefore + 1);

    // Old session is dead, registration is open again with a fresh setup code.
    assert.equal((await req(`${t.base}/`, { cookie, headers: HTML })).status, 302);
    const status = await req(`${t.base}/api/auth/status`, { cookie });
    assert.deepEqual(status.data, { registered: false, authenticated: false, webauthn: true });
    const code = t.ctx.setup.code;
    assert.ok(code);
    assert.ok(t.logs.filter((l) => l.includes('SETUP-CODE')).length >= 2);
    assert.ok(t.logs.some((l) => l.includes(code)));

    // Re-registration works (credentials are stored as an array).
    const again = await register(t);
    assert.equal((await req(`${t.base}/`, { cookie: again.cookie, headers: HTML })).status, 200);
    assert.equal(t.store.credentials.length, 1);
  } finally {
    await t.close();
  }
});

/**
 * Start `node index.js` and collect output until it is listening.
 * @param {Record<string,string>} env
 */
function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SERVER_DIR, 'index.js')], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', STATIC_DIR: makeStaticDir(), ...env },
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout:\n${output}`)); }, 10_000);
    const onData = (/** @type {Buffer} */ d) => {
      output += d.toString();
      if (output.includes('läuft auf')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        child.on('exit', () => resolve(output));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
  });
}

test('RESET_AUTH=1 at startup wipes credentials, bumps the generation and warns loudly', async () => {
  const { dataDir, generation } = seededDataDir();
  const output = /** @type {string} */ (await startServer({ DATA_DIR: dataDir, RESET_AUTH: '1' }));
  assert.match(output, /RESET_AUTH ist gesetzt/);
  assert.match(output, /Entferne RESET_AUTH/);
  assert.match(output, /SETUP-CODE:\s+[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
  assert.equal(file.credentials.length, 0);
  assert.equal(file.generation, generation + 1);
});

test('without RESET_AUTH, startup keeps credentials and prints no setup code', async () => {
  const { dataDir, generation } = seededDataDir();
  const output = /** @type {string} */ (await startServer({ DATA_DIR: dataDir, RESET_AUTH: '' }));
  assert.doesNotMatch(output, /SETUP-CODE/);
  assert.doesNotMatch(output, /RESET_AUTH ist gesetzt/);
  const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
  assert.equal(file.credentials.length, 1);
  assert.equal(file.generation, generation);
  assert.ok(fs.existsSync(path.join(dataDir, 'session.key')), 'session secret persisted');
});

test('SETUP_CODE from the environment is used and not echoed to the log', async () => {
  const dataDir = tmpDir('whoop-setup-');
  const output = /** @type {string} */ (await startServer({ DATA_DIR: dataDir, SETUP_CODE: 'my-own-secret-code' }));
  assert.match(output, /SETUP_CODE gesetzte Wert/);
  assert.doesNotMatch(output, /my-own-secret-code/i);

  const t = await startTestApp({ env: { SETUP_CODE: 'my-own-secret-code' } });
  try {
    const ok = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: 'MY-OWN-SECRET-CODE' } });
    assert.equal(ok.status, 200);
    const bad = await req(`${t.base}/api/auth/register/options`, { json: { setupCode: 'other' } });
    assert.equal(bad.status, 403);
  } finally {
    await t.close();
  }
});
