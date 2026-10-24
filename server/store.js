// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * @typedef {object} StoredCredential
 * @property {string} id            base64url credential ID
 * @property {string} publicKey     base64url COSE public key
 * @property {number} counter
 * @property {string[]} transports
 * @property {string} createdAt     ISO timestamp
 * @property {string} deviceLabel
 * @property {string} [lastUsedAt]
 * @property {string} [deviceType]
 * @property {boolean} [backedUp]
 */

/**
 * @typedef {object} AuthData
 * @property {number} version
 * @property {number} generation    bumped on every reset; sessions of older generations are invalid
 * @property {string} userId        base64url WebAuthn user handle
 * @property {StoredCredential[]} credentials
 * @property {string} [updatedAt]
 * @property {string} [lastResetAt]
 */

export const AUTH_FILE = 'auth.json';
export const SECRET_FILE = 'session.key';

/** @returns {AuthData} */
function emptyData() {
  return {
    version: 1,
    generation: 1,
    userId: crypto.randomBytes(16).toString('base64url'),
    credentials: [],
  };
}

/**
 * Write a file atomically: write to a temp file in the same directory, fsync, rename.
 * @param {string} file
 * @param {string} content
 */
export function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    // When run as root (e.g. `docker exec -u root ... node server/reset.js`), keep the file owned
    // by the directory owner so the unprivileged server process can still read it.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const st = fs.statSync(dir);
      if (st.uid !== 0) fs.fchownSync(fd, st.uid, st.gid);
    }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Tiny JSON-file store for the auth state. The file is re-read whenever it changes on disk,
 * so `node server/reset.js` run in the same container takes effect without a restart.
 */
export class AuthStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, AUTH_FILE);
    /** @type {AuthData} */
    this.data = emptyData();
    /** @type {string} */
    this.stamp = '';
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.load();
  }

  /** @returns {string} */
  statStamp() {
    try {
      const st = fs.statSync(this.file);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch (err) {
      // Only a truly missing file may be (re)created – never overwrite on EACCES etc.
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return 'missing';
      throw err;
    }
  }

  load() {
    const stamp = this.statStamp();
    if (stamp === 'missing') {
      this.data = emptyData();
      this.save();
      return;
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const base = emptyData();
    this.data = {
      ...base,
      ...raw,
      generation: Number.isInteger(raw.generation) && raw.generation > 0 ? raw.generation : 1,
      userId: typeof raw.userId === 'string' && raw.userId ? raw.userId : base.userId,
      credentials: Array.isArray(raw.credentials) ? raw.credentials : [],
    };
    this.stamp = stamp;
  }

  /** Re-read the file if another process (reset.js) changed it. */
  refresh() {
    if (this.statStamp() !== this.stamp) this.load();
    return this.data;
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n');
    this.stamp = this.statStamp();
  }

  get generation() {
    return this.refresh().generation;
  }

  /** Random per auth.json and per reset; sessions and pairing tokens are bound to it. */
  get userId() {
    return this.refresh().userId;
  }

  get credentials() {
    return this.refresh().credentials;
  }

  get registered() {
    return this.credentials.length > 0;
  }

  /** @param {string} id */
  findCredential(id) {
    return this.credentials.find((c) => c.id === id);
  }

  /** @param {StoredCredential} cred */
  addCredential(cred) {
    this.refresh();
    this.data.credentials.push(cred);
    this.save();
  }

  /**
   * @param {string} id
   * @param {Partial<StoredCredential>} patch
   */
  updateCredential(id, patch) {
    this.refresh();
    const cred = this.data.credentials.find((c) => c.id === id);
    if (!cred) return;
    Object.assign(cred, patch);
    this.save();
  }

  /**
   * Wipe all credentials and bump the generation so every existing session becomes invalid.
   * @returns {{ removed: number, generation: number }}
   */
  reset() {
    this.refresh();
    const removed = this.data.credentials.length;
    this.data.credentials = [];
    this.data.generation += 1;
    this.data.userId = crypto.randomBytes(16).toString('base64url');
    this.data.lastResetAt = new Date().toISOString();
    this.save();
    return { removed, generation: this.data.generation };
  }
}

/**
 * Load the HMAC secret for session tokens from DATA_DIR, creating it on first start.
 * @param {string} dataDir
 * @param {string} [provided]  SESSION_SECRET from the environment, if any
 * @returns {Buffer}
 */
export function loadSessionSecret(dataDir, provided) {
  if (provided) return Buffer.from(provided, 'utf8');
  const file = path.join(dataDir, SECRET_FILE);
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64,}$/i.test(hex)) return Buffer.from(hex, 'hex');
  } catch { /* create below */ }
  const secret = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(file, secret.toString('hex') + '\n');
  return secret;
}
