// Version, Build-Nummer und „Was ist neu“ – setzt der iOS-Workflow beim `npm run build`
// (VITE_APP_VERSION, VITE_APP_BUILD, VITE_CHANGELOG, siehe .github/workflows/ios.yml). Lokal: „dev“.
const env = import.meta.env;

export const APP_VERSION: string = (env.VITE_APP_VERSION as string | undefined)?.trim() || 'dev';
export const APP_BUILD: string = (env.VITE_APP_BUILD as string | undefined)?.trim() || '';
export const APP_CHANGELOG: string = (env.VITE_CHANGELOG as string | undefined)?.trim() || '';

/** z. B. „0.1.12 (12)“ bzw. „dev“. */
export const versionLabel = (): string => (APP_BUILD ? `${APP_VERSION} (${APP_BUILD})` : APP_VERSION);
