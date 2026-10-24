// @ts-check
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { AuthStore, loadSessionSecret } from './store.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = new AuthStore(config.dataDir);

if (config.resetAuth) {
  const { removed, generation } = store.reset();
  const line = '!'.repeat(64);
  console.warn([
    '',
    line,
    '  RESET_AUTH ist gesetzt – Zugangsdaten wurden ZURÜCKGESETZT.',
    `  Entfernte Passkeys: ${removed}. Alle Sitzungen sind ungültig (Generation ${generation}).`,
    '',
    '  WICHTIG: Entferne RESET_AUTH jetzt wieder aus dem Stack und deploye neu,',
    '  sonst wird bei JEDEM Neustart erneut zurückgesetzt!',
    line,
    '',
  ].join('\n'));
}

const sessionSecret = loadSessionSecret(config.dataDir, config.sessionSecret);

if (!fs.existsSync(`${config.staticDir}/index.html`)) {
  console.warn(`[server] Warnung: ${config.staticDir}/index.html fehlt – die App ist nicht gebaut.`);
}
if (!config.cookieSecure) {
  console.warn('[server] Warnung: COOKIE_SECURE ist deaktiviert – nur für lokale Entwicklung verwenden!');
}

const app = createApp({ config, store, sessionSecret });

const server = app.listen(config.port, config.host, () => {
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.port;
  console.log(
    `[server] Whoop-plus läuft auf ${config.host}:${port} (Origin ${config.origin}, RP-ID ${config.rpId}, ` +
      `Daten ${config.dataDir}, Passkey registriert: ${store.registered ? 'ja' : 'nein'})`,
  );
});

const shutdown = (/** @type {string} */ signal) => {
  console.log(`[server] ${signal} empfangen, beende…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
