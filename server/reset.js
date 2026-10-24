#!/usr/bin/env node
// @ts-check
// Reset authentication: removes all registered passkeys and invalidates every session.
//
//   docker exec -it whoop-plus node server/reset.js
//   (or in the Portainer container console:  node server/reset.js)
//
// The running server notices the change on the next request; it then prints a new setup code
// to the container log (open the login page once, or restart the container).
import { loadConfig } from './config.js';
import { AuthStore } from './store.js';

const config = loadConfig();
const store = new AuthStore(config.dataDir);
const { removed, generation } = store.reset();

console.log([
  '',
  'Whoop-plus: Zugangsdaten zurückgesetzt.',
  `  Entfernte Passkeys: ${removed}`,
  `  Neue Generation:    ${generation} (alle bisherigen Sitzungen und Kopplungs-Links sind ungültig)`,
  '',
  'Nächste Schritte:',
  '  1. Login-Seite in Safari öffnen (oder Container neu starten).',
  '  2. Den neuen Setup-Code aus dem Container-Log ablesen.',
  '  3. Neuen Passkey erstellen.',
  '',
].join('\n'));
