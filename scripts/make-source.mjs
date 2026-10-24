#!/usr/bin/env node
// Versionsnummern, „Was ist neu“-Text und die SideStore-/AltStore-Quelle (source.json) für die iOS-Builds.
// Wird vom Workflow .github/workflows/ios.yml benutzt; die Funktionen sind in make-source.test.mjs getestet.
//
// Aufrufe:
//   node scripts/make-source.mjs version <runNumber>        → "marketing=0.1.12" und "build=12" (für $GITHUB_OUTPUT)
//   node scripts/make-source.mjs changelog < message.txt    → bereinigter „Was ist neu“-Text
//   node scripts/make-source.mjs meta --info Info.json --changelog changelog.txt --version 0.1.12 --build 12 --out release-meta.json
//        (prüft die Versionsnummern im gebauten Info.plist und sammelt minOSVersion + Datenschutz-Texte)
//   node scripts/make-source.mjs source --meta release-meta.json --ipa WhoopPlus-0.1.12.ipa \
//        [--previous alt/source.json] (--out source.json [--removed removed.txt] | --check)
//        Exit-Code 3: Der Build ist nicht neuer als der neueste in der Quelle (z. B. „Re-run“ eines alten Laufs)
//        – dann wird nichts veröffentlicht. `--check` prüft nur, ohne etwas zu schreiben.
//
// Format der Quelle: https://faq.altstore.io/developers/make-a-source (SideStore ist dazu kompatibel,
// https://docs.sidestore.io/docs/advanced/app-sources).
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** owner/repo – im Workflow aus GITHUB_REPOSITORY, lokal das Original-Repository. */
export const REPO = process.env.GITHUB_REPOSITORY?.trim() || 'DavThosty/Whoop-plus';
export const BUNDLE_ID = 'de.steinerkn.whoopplus';
export const RELEASE_TAG = 'ios-latest';
/** Branch, auf dem der Workflow source.json und das Icon ablegt (stabile raw-URL). */
export const SOURCE_BRANCH = 'sidestore';
export const SOURCE_URL = `https://raw.githubusercontent.com/${REPO}/${SOURCE_BRANCH}/source.json`;
export const ICON_URL = `https://raw.githubusercontent.com/${REPO}/${SOURCE_BRANCH}/icon.png`;
export const RELEASE_DOWNLOAD = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/`;
/** So viele Versionen (mit eigener IPA im Release) bleiben in der Quelle. */
export const KEEP_VERSIONS = 10;
export const MAX_CHANGELOG = 600;
export const DEFAULT_CHANGELOG = 'Kleinere Verbesserungen und Fehlerbehebungen.';
/** Exit-Code der CLI, wenn der Build veraltet ist (kein Fehler, aber nichts zu veröffentlichen). */
export const EXIT_STALE = 3;

/** Der Build ist nicht neuer als der neueste bereits veröffentlichte – würde alle Nutzer zurückstufen. */
export class StaleBuildError extends Error {
  constructor(build, newest) {
    super(`Build ${build} ist nicht neuer als der neueste veröffentlichte Build ${newest} – nichts zu veröffentlichen.`);
    this.name = 'StaleBuildError';
    this.code = 'STALE_BUILD';
    this.build = build;
    this.newest = newest;
  }
}

/** Build-Nummer eines Eintrags als Zahl (ungültig → −∞, landet ganz hinten). */
const buildNumber = (v) => {
  const n = Number(v?.buildVersion);
  return v?.buildVersion != null && String(v.buildVersion).trim() !== '' && Number.isFinite(n) ? n : -Infinity;
};

/** Versionsname der IPA im Release, eindeutig je Version. */
export const ipaName = (version) => `WhoopPlus-${version}.ipa`;

/** `<major>.<minor>` aus package.json + Lauf-Nummer als Patch; Build = Lauf-Nummer. */
export function computeVersion(pkgVersion, runNumber) {
  const m = /^(\d+)\.(\d+)/.exec(String(pkgVersion ?? '').trim());
  if (!m) throw new Error(`Ungültige Version in package.json: ${pkgVersion}`);
  const run = String(runNumber ?? '').trim();
  if (!/^\d+$/.test(run)) throw new Error(`Ungültige Lauf-Nummer: ${runNumber}`);
  const build = String(Number(run));
  return { marketing: `${Number(m[1])}.${Number(m[2])}.${build}`, build };
}

/** Zeilen, die nicht in „Was ist neu“ gehören (Git-Trailer, Bot-Hinweise, Sitzungs-Links). */
const TRAILER = /^\s*(co-authored-by|signed-off-by|claude-session|reviewed-by|acked-by|tested-by|helped-by|reported-by|change-id|generated-by|cc)\s*:/i;
const NOISE = [
  /generated with \[?claude code/i,
  /^\s*https?:\/\/claude\.ai\/code\/\S*\s*$/i,
  /^\s*<!--.*-->\s*$/,
  /^\s*(```|~~~)/,
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/, // Tabellen-Trennzeile
  /^\s*([-*_]\s*){3,}$/, // horizontale Linie
];

/** Inline-Markdown entfernen (Links, Bilder, Hervorhebungen, Code). */
function inline(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Macht aus einer (Squash-)Merge-Commit-Nachricht einen kurzen, lesbaren „Was ist neu“-Text:
 * Titel ohne „(#12)“, Trailer wie Co-Authored-By/Claude-Session raus, Markdown vereinfacht,
 * höchstens `max` Zeichen (an einer Wortgrenze gekürzt, mit „…“).
 */
export function cleanChangelog(message, max = MAX_CHANGELOG) {
  const lines = String(message ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let first = true;
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (TRAILER.test(raw) || NOISE.some((r) => r.test(raw))) continue;
    let line = raw.replace(/<!--.*?-->/g, '');
    if (first && line.trim()) {
      first = false;
      // GitHub-Merge-Commits: „Merge pull request #12 from …“ trägt keine Information (der PR-Titel steht im Text).
      if (/^\s*merge (pull request #\d+ from \S+|branch '[^']*'( into \S+)?|remote-tracking branch .*)\s*$/i.test(line)) continue;
      line = line.replace(/\s*\(#\d+\)\s*$/, '');
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/.exec(line);
    if (bullet) {
      const text = inline(line.slice(bullet[0].length));
      if (text) out.push(`• ${text}`);
      continue;
    }
    line = line.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*>\s?/, '');
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' – ');
    }
    out.push(inline(line));
  }
  let text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > max) {
    const cut = text.slice(0, max - 1);
    const ws = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
    text = `${(ws > max * 0.6 ? cut.slice(0, ws) : cut).replace(/[\s.,;:–-]+$/, '')}…`;
  }
  return text;
}

/** ISO 8601 ohne Millisekunden – SideStore liest nur `yyyy-MM-ddTHH:mm:ssZ` oder `yyyy-MM-dd`. */
export function isoDate(d = new Date()) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Name der IPA-Datei im eigenen Release (oder null, wenn die URL woanders hinzeigt). */
export function releaseAssetName(url) {
  if (typeof url !== 'string' || !url.startsWith(RELEASE_DOWNLOAD)) return null;
  const name = decodeURIComponent(url.slice(RELEASE_DOWNLOAD.length));
  return name && !name.includes('/') ? name : null;
}

const APP_DESCRIPTION = [
  'Eigene iPhone-App für das WHOOP 4.0 – ohne Abo, ohne WHOOP-Cloud, ohne Server.',
  '',
  'Whoop Plus verbindet sich per Bluetooth direkt mit dem Band, lädt den Verlauf herunter und berechnet Schlaf, HRV, Ruhepuls, Recovery, Strain und Kalorien lokal auf dem iPhone. Alle Daten bleiben auf dem Gerät.',
  '',
  'Kein offizielles WHOOP-Produkt. Keine Medizin-App – alle Werte sind Schätzungen.',
].join('\n');

/**
 * Baut die neue source.json. Versionen stehen nach Build-Nummer absteigend (SideStore nimmt die erste als
 * „neueste“), ältere Versionen aus `previous` bleiben bis `keep` erhalten. `removedAssets`: IPA-Dateien im
 * Release, die nicht mehr referenziert werden und gelöscht werden können.
 * Wirft `StaleBuildError`, wenn `build` nicht größer als der neueste Build in `previous` ist.
 */
export function makeSource(p) {
  const { previous = null, version, build, changelog, size, sha256, date = isoDate(), minOSVersion = '15.0', privacy = {}, keep = KEEP_VERSIONS } = p;
  if (!version || !build) throw new Error('version und build sind nötig');
  if (!/^\d+$/.test(String(build))) throw new Error(`Ungültige Build-Nummer: ${build}`);
  if (!Number.isInteger(size) || size <= 0) throw new Error('size (Bytes) fehlt');
  const entry = {
    version: String(version),
    buildVersion: String(build),
    date,
    localizedDescription: changelog?.trim() || DEFAULT_CHANGELOG,
    downloadURL: RELEASE_DOWNLOAD + ipaName(version),
    size,
    ...(sha256 ? { sha256: String(sha256).toLowerCase() } : {}),
    minOSVersion: String(minOSVersion),
  };

  const prevApp = Array.isArray(previous?.apps) ? previous.apps.find((a) => a?.bundleIdentifier === BUNDLE_ID) : null;
  const validPrev = (Array.isArray(prevApp?.versions) ? prevApp.versions : []).filter(
    (v) => v && typeof v.version === 'string' && typeof v.downloadURL === 'string',
  );
  const newest = Math.max(-Infinity, ...validPrev.map(buildNumber));
  if (newest >= Number(build)) throw new StaleBuildError(Number(build), newest);
  const prevVersions = validPrev.filter((v) => v.version !== entry.version && v.downloadURL !== entry.downloadURL);
  // Stabil nach Build absteigend sortieren – unabhängig davon, in welcher Reihenfolge die alte Quelle war.
  const all = [entry, ...prevVersions].sort((a, b) => buildNumber(b) - buildNumber(a));
  const kept = all.slice(0, Math.max(1, keep));
  const keptAssets = new Set(kept.map((v) => releaseAssetName(v.downloadURL)).filter(Boolean));
  const removedAssets = [...new Set(all.slice(kept.length).map((v) => releaseAssetName(v.downloadURL)))].filter(
    (n) => n && n !== 'WhoopPlus.ipa' && !keptAssets.has(n),
  );

  const source = {
    name: 'Whoop Plus',
    identifier: `${BUNDLE_ID}.source`,
    subtitle: 'WHOOP 4.0 ohne Abo – Updates direkt in SideStore',
    description:
      'Quelle für Whoop Plus von DavThosty. Jede neue Version aus GitHub erscheint hier automatisch; SideStore zeigt sie unter „Updates“ an.',
    iconURL: ICON_URL,
    website: `https://github.com/${REPO}`,
    tintColor: '#16ec06',
    nsfw: false,
    featuredApps: [BUNDLE_ID],
    apps: [
      {
        name: 'Whoop Plus',
        bundleIdentifier: BUNDLE_ID,
        developerName: 'DavThosty',
        subtitle: 'Schlaf, Recovery & Strain für WHOOP 4.0 – lokal auf dem iPhone',
        localizedDescription: APP_DESCRIPTION,
        iconURL: ICON_URL,
        tintColor: '#16ec06',
        category: 'lifestyle',
        // Veraltete, aber weiter unterstützte Felder für ältere AltStore-/SideStore-Versionen (= neueste Version).
        version: kept[0].version,
        versionDate: kept[0].date,
        versionDescription: kept[0].localizedDescription,
        downloadURL: kept[0].downloadURL,
        size: kept[0].size,
        versions: kept,
        appPermissions: {
          entitlements: [],
          privacy: { ...privacy },
        },
      },
    ],
    news: [],
  };
  return { source, removedAssets };
}

/**
 * Metadaten für den Release-Job aus dem gebauten Info.plist (als JSON). Bricht ab, wenn Version, Build oder
 * Bundle-ID nicht stimmen – SideStore prüft beides gegen die Quelle und würde die Installation sonst ablehnen.
 */
export function makeMeta(info, { version, build, changelog }) {
  if (!info || typeof info !== 'object') throw new Error('Info.plist fehlt');
  if (info.CFBundleIdentifier !== BUNDLE_ID) throw new Error(`Bundle-ID ${info.CFBundleIdentifier} ≠ ${BUNDLE_ID}`);
  if (String(info.CFBundleShortVersionString) !== String(version)) {
    throw new Error(`CFBundleShortVersionString ${info.CFBundleShortVersionString} ≠ ${version}`);
  }
  if (String(info.CFBundleVersion) !== String(build)) throw new Error(`CFBundleVersion ${info.CFBundleVersion} ≠ ${build}`);
  const privacy = Object.fromEntries(
    Object.entries(info).filter(([k, v]) => /UsageDescription$/.test(k) && typeof v === 'string').sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    version: String(version),
    build: String(build),
    changelog: String(changelog ?? '').trim() || DEFAULT_CHANGELOG,
    minOSVersion: String(info.MinimumOSVersion || '15.0'),
    privacy,
  };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i];
  }
  return o;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const v = computeVersion(pkg.version, rest[0]);
    process.stdout.write(`marketing=${v.marketing}\nbuild=${v.build}\n`);
    return;
  }
  if (cmd === 'changelog') {
    process.stdout.write(cleanChangelog(readFileSync(0, 'utf8')) || DEFAULT_CHANGELOG);
    return;
  }
  if (cmd === 'meta') {
    const a = args(rest);
    if (!a.info || !a.version || !a.build || !a.out) throw new Error('--info, --version, --build und --out sind nötig');
    const changelog = typeof a.changelog === 'string' ? readFileSync(a.changelog, 'utf8') : '';
    const meta = makeMeta(JSON.parse(readFileSync(a.info, 'utf8')), { version: a.version, build: a.build, changelog });
    writeFileSync(a.out, `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`Meta: ${meta.version} (${meta.build}), iOS ab ${meta.minOSVersion}, Datenschutz: ${Object.keys(meta.privacy).join(', ') || '–'}`);
    return;
  }
  if (cmd === 'source') {
    const a = args(rest);
    if (!a.meta || !a.ipa || (!a.out && !a.check)) throw new Error('--meta, --ipa und --out (oder --check) sind nötig');
    const meta = JSON.parse(readFileSync(a.meta, 'utf8'));
    if (basename(a.ipa) !== ipaName(meta.version)) throw new Error(`IPA muss ${ipaName(meta.version)} heißen`);
    let previous = null;
    if (typeof a.previous === 'string') {
      try {
        previous = JSON.parse(readFileSync(a.previous, 'utf8'));
      } catch (e) {
        if (e?.code !== 'ENOENT') console.warn(`Vorherige Quelle nicht lesbar, beginne neu: ${e.message}`);
      }
    }
    const { source, removedAssets } = makeSource({
      previous,
      version: meta.version,
      build: meta.build,
      changelog: meta.changelog,
      minOSVersion: meta.minOSVersion || '15.0',
      privacy: meta.privacy || {},
      size: statSync(a.ipa).size,
      sha256: sha256File(a.ipa),
    });
    if (a.check) {
      console.log(`Prüfung ok: ${meta.version} (${meta.build}) ist neuer als alles in der Quelle.`);
      return;
    }
    writeFileSync(a.out, `${JSON.stringify(source, null, 2)}\n`);
    if (typeof a.removed === 'string') writeFileSync(a.removed, removedAssets.map((n) => `${n}\n`).join(''));
    console.log(`source.json: ${source.apps[0].versions.length} Version(en), neueste ${meta.version} (${meta.build}); zu löschen: ${removedAssets.join(', ') || '–'}`);
    return;
  }
  throw new Error(`Unbekannter Befehl: ${cmd ?? '(keiner)'} – erwartet: version | changelog | meta | source`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(e instanceof StaleBuildError ? EXIT_STALE : 1);
  }
}
