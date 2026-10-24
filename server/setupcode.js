// @ts-check
import crypto from 'node:crypto';

// No 0/O, 1/I/L, to keep the code easy to read from a log and type on a phone.
export const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** @returns {string} e.g. "K7QM-2XRP-H9TA-4WNC" */
export function generateSetupCode() {
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += SETUP_ALPHABET[crypto.randomInt(SETUP_ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/**
 * Normalize user input: ignore case, spaces and dashes.
 * @param {unknown} code
 */
export function normalizeSetupCode(code) {
  return typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

/**
 * Constant-time comparison (hash both sides so lengths are equal).
 * @param {unknown} input
 * @param {string} expected
 */
export function setupCodeMatches(input, expected) {
  const a = crypto.createHash('sha256').update(normalizeSetupCode(input)).digest();
  const b = crypto.createHash('sha256').update(normalizeSetupCode(expected)).digest();
  return crypto.timingSafeEqual(a, b) && normalizeSetupCode(expected).length > 0;
}

/**
 * Holds the setup code while registration is open and prints it to stdout.
 */
export class SetupCodeManager {
  /**
   * @param {{ fixedCode?: string, isRegistered: () => boolean, log: (msg: string) => void }} opts
   */
  constructor({ fixedCode, isRegistered, log }) {
    this.fixedCode = fixedCode;
    this.isRegistered = isRegistered;
    this.log = log;
    /** @type {string|null} */
    this.code = null;
  }

  /**
   * Make sure a code exists (and was printed) while no credential is registered;
   * forget it once registration is closed.
   * @returns {string|null}
   */
  ensure() {
    if (this.isRegistered()) {
      this.code = null;
      return null;
    }
    if (!this.code) {
      this.code = this.fixedCode || generateSetupCode();
      this.announce(Boolean(this.fixedCode));
    }
    return this.code;
  }

  /** @param {unknown} input */
  check(input) {
    const code = this.ensure();
    return code !== null && setupCodeMatches(input, code);
  }

  /** @param {boolean} fromEnv */
  announce(fromEnv) {
    const line = '='.repeat(64);
    const body = fromEnv
      ? ['  Setup-Code: der in der Umgebungsvariable SETUP_CODE gesetzte Wert']
      : [`  SETUP-CODE:  ${this.code}`];
    this.log(
      [
        '',
        line,
        '  WHOOP-PLUS ERSTEINRICHTUNG – noch kein Passkey registriert',
        '',
        ...body,
        '',
        '  Öffne die App in Safari, gib den Code ein und erstelle den Passkey.',
        '  Danach ist die Registrierung dauerhaft geschlossen.',
        line,
        '',
      ].join('\n'),
    );
  }
}
