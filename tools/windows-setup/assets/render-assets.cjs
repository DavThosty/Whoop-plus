// Erzeugt die Bilder des Einrichtungshelfers und bettet sie in WhoopPlusSetup.ps1 ein:
//   - icon.ico (Programmsymbol, aus resources/app-icon.svg)
//   - kleine Schritt-Bilder (einfache Strich-Grafiken, keine Apple-Oberflächen)
//   - QR-Codes (LocalDevVPN im App Store, Whoop-Plus-Quelle für SideStore)
// Benötigt Playwright mit Chromium sowie Python mit Pillow und segno:
//   pip install pillow segno
//   NODE_PATH=$(npm root -g) node tools/windows-setup/assets/render-assets.cjs
// Die Ergebnisse werden committet; der CI-Build braucht diese Werkzeuge nicht.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const here = __dirname;
const toolDir = path.join(here, '..');
const repo = path.join(toolDir, '..', '..');
const scriptPath = path.join(toolDir, 'WhoopPlusSetup.ps1');

// Muss zu $script:Config in WhoopPlusSetup.ps1 passen (ein Pester-Test prüft das).
const LOCALDEVVPN_URL = 'https://apps.apple.com/app/localdevvpn/id6755608044';
const SOURCE_URL = 'https://raw.githubusercontent.com/DavThosty/Whoop-plus/sidestore/source.json';
const SOURCE_DEEPLINK = 'sidestore://source?url=' + encodeURIComponent(SOURCE_URL);

const G = '#16ec06'; // Akzent (App-Icon)
const W = '#e8eef2'; // Linien
const D = '#1f262d'; // Flächen

const phone = (x = 30, y = 8, h = 72) => `
  <rect x="${x}" y="${y}" width="36" height="${h}" rx="8" fill="${D}" stroke="${W}" stroke-width="4"/>
  <line x1="${x + 13}" y1="${y + 7}" x2="${x + 23}" y2="${y + 7}" stroke="${W}" stroke-width="3" stroke-linecap="round"/>`;
const monitor = `
  <rect x="10" y="14" width="76" height="50" rx="6" fill="${D}" stroke="${W}" stroke-width="4"/>
  <line x1="48" y1="64" x2="48" y2="76" stroke="${W}" stroke-width="4"/>
  <line x1="32" y1="80" x2="64" y2="80" stroke="${W}" stroke-width="4" stroke-linecap="round"/>`;
const g = (inner) => `<g fill="none" stroke="${G}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;

const icons = {
  pc: monitor + g('<polyline points="34,40 44,50 62,30"/>'),
  apple: `<rect x="18" y="34" width="60" height="46" rx="6" fill="${D}" stroke="${W}" stroke-width="4"/>
    <line x1="18" y1="48" x2="78" y2="48" stroke="${W}" stroke-width="4"/>` +
    g('<line x1="48" y1="8" x2="48" y2="40"/><polyline points="36,28 48,40 60,28"/>'),
  vpn: phone() + g('<path d="M48 26 l12 5 v9 c0 9 -6 14 -12 17 c-6 -3 -12 -8 -12 -17 v-9 z"/><polyline points="43,41 47,45 54,37"/>'),
  cable: phone(30, 4, 58) + g('<line x1="48" y1="62" x2="48" y2="74"/><rect x="39" y="74" width="18" height="12" rx="3"/><line x1="44" y1="86" x2="44" y2="92"/><line x1="52" y1="86" x2="52" y2="92"/>'),
  download: monitor + g('<line x1="48" y1="22" x2="48" y2="50"/><polyline points="37,40 48,51 59,40"/>'),
  login: monitor + g('<circle cx="48" cy="32" r="8"/><path d="M33 56 c2 -9 8 -12 15 -12 s13 3 15 12"/>'),
  install: phone() + g('<line x1="48" y1="24" x2="48" y2="54"/><polyline points="38,44 48,54 58,44"/>'),
  trust: phone() + g('<polyline points="38,44 46,52 59,36"/>'),
  devmode: phone() + g('<circle cx="48" cy="44" r="7"/><path d="M48 30 v4 M48 54 v4 M34 44 h4 M58 44 h4 M38 34 l3 3 M55 51 l3 3 M58 34 l-3 3 M41 51 l-3 3"/>'),
  refresh: phone() + g('<path d="M58 40 a10 10 0 1 0 -2 10"/><polyline points="59,30 59,40 49,40"/>'),
  add: phone() + g('<line x1="48" y1="32" x2="48" y2="56"/><line x1="36" y1="44" x2="60" y2="44"/>'),
  repair: phone() + g('<path d="M55 30 a9 9 0 0 0 -11 11 l-9 9 a3 3 0 0 0 4 4 l9 -9 a9 9 0 0 0 11 -11 l-5 5 l-4 -1 l-1 -4 z"/>'),
  question: phone() + g('<path d="M41 36 a7 7 0 1 1 10 6 c-2 1 -3 3 -3 6"/><line x1="48" y1="56" x2="48" y2="57"/>'),
  done: `<circle cx="48" cy="48" r="38" fill="${D}" stroke="${G}" stroke-width="6"/>` + g('<polyline points="30,49 43,62 67,36" stroke-width="8"/>'),
  warn: `<path d="M48 10 L88 82 H8 Z" fill="${D}" stroke="#ffb020" stroke-width="5" stroke-linejoin="round"/>
    <line x1="48" y1="36" x2="48" y2="58" stroke="#ffb020" stroke-width="7" stroke-linecap="round"/>
    <circle cx="48" cy="70" r="4" fill="#ffb020"/>`,
};

const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-assets-'));
  const browser = await chromium.launch();
  const shot = async (markup, size, out, background) => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:${background || 'transparent'}">${markup}</body></html>`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size, height: size }, omitBackground: !background });
    await page.close();
  };

  // 1) Programmsymbol (mehrere Größen, damit es auch klein scharf bleibt)
  const appSvg = fs.readFileSync(path.join(repo, 'resources', 'app-icon.svg'), 'utf8');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) {
    const out = path.join(tmp, `icon-${s}.png`);
    // Abgerundete Ecken wie ein App-Symbol, außen transparent.
    const markup = `<div style="width:${s}px;height:${s}px;border-radius:${Math.round(s * 0.22)}px;overflow:hidden">` +
      appSvg.replace(/width="\d+" height="\d+"/, `width="${s}" height="${s}"`) + '</div>';
    await shot(markup, s, out);
    pngs.push(out);
  }
  py(`import sys
from PIL import Image
paths = sys.argv[2:]
imgs = [Image.open(p).convert('RGBA') for p in paths]
big = imgs[-1]
big.save(sys.argv[1], format='ICO', sizes=[im.size for im in imgs], append_images=imgs[:-1])`,
  path.join(toolDir, 'icon.ico'), ...pngs);

  // 2) Schritt-Bilder
  const assets = {};
  for (const [name, inner] of Object.entries(icons)) {
    const out = path.join(tmp, `step-${name}.png`);
    await shot(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 96 96">${inner}</svg>`, 192, out);
    py('import sys\nfrom PIL import Image\nImage.open(sys.argv[1]).save(sys.argv[1], optimize=True)', out);
    assets[`step-${name}`] = fs.readFileSync(out).toString('base64');
  }
  await browser.close();

  // 3) QR-Codes (dunkel auf weiß mit Rand, damit die iPhone-Kamera sie sicher erkennt)
  const qr = (data, out) => py(`import sys, segno
segno.make(sys.argv[1], error='m', micro=False).save(sys.argv[2], scale=6, border=3, dark='#000000', light='#ffffff')`, data, out);
  for (const [name, data] of [['qr-localdevvpn', LOCALDEVVPN_URL], ['qr-source', SOURCE_DEEPLINK]]) {
    const out = path.join(tmp, `${name}.png`);
    qr(data, out);
    assets[name] = fs.readFileSync(out).toString('base64');
  }

  // 4) In das Skript einbetten (zwischen den Markierungen)
  const lines = ['# region GENERATED-ASSETS (nicht von Hand ändern – tools/windows-setup/assets/render-assets.cjs)',
    'function Get-EmbeddedAssetData {',
    '    # Base64-kodierte PNG-Bilder. Leerzeichen und Zeilenumbrüche ignoriert [Convert]::FromBase64String.',
    '    return @{'];
  for (const [name, b64] of Object.entries(assets)) {
    const wrapped = b64.match(/.{1,100}/g).join('\n');
    lines.push(`        '${name}' = @'\n${wrapped}\n'@`);
  }
  lines.push('    }', '}', '# endregion GENERATED-ASSETS');
  const block = lines.join('\n');

  const src = fs.readFileSync(scriptPath, 'utf8');
  const re = /# region GENERATED-ASSETS[\s\S]*?# endregion GENERATED-ASSETS/;
  if (!re.test(src)) throw new Error('Markierung GENERATED-ASSETS fehlt in WhoopPlusSetup.ps1');
  let next = src.replace(re, () => block);
  // Windows PowerShell 5.1 braucht UTF-8 *mit* BOM, sonst werden Umlaute falsch gelesen.
  if (!next.startsWith('﻿')) next = '﻿' + next;
  fs.writeFileSync(scriptPath, next, 'utf8');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`icon.ico + ${Object.keys(assets).length} Bilder → ${path.relative(process.cwd(), scriptPath)}`);
})();
