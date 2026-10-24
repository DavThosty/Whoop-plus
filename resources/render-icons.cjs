// Rendert App-Icon und Startbild-Logo aus den SVGs in diesem Ordner in den Xcode-Asset-Katalog.
// Benötigt Playwright mit Chromium und Python/Pillow (entfernt den Alphakanal – iOS-Icons müssen deckend sein):
//   NODE_PATH=$(npm root -g) node resources/render-icons.cjs
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const assets = path.join(here, '..', 'ios', 'App', 'App', 'Assets.xcassets');
const jobs = [
  ['app-icon.svg', 1024, path.join(assets, 'AppIcon.appiconset', 'AppIcon-1024.png')],
  ['splash-logo.svg', 360, path.join(assets, 'Splash.imageset', 'splash-logo.png')],
  // Icon der SideStore-Quelle (der Workflow kopiert es auf den Branch „sidestore“).
  ['app-icon.svg', 512, path.join(here, 'icon-512.png')],
];

(async () => {
  const browser = await chromium.launch();
  for (const [svg, size, out] of jobs) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const markup = fs.readFileSync(path.join(here, svg), 'utf8').replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
    await page.setContent(`<html><body style="margin:0;background:#05070a">${markup}</body></html>`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    execFileSync('python3', ['-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).convert("RGB").save(sys.argv[1],optimize=True)', out]);
    console.log(`${svg} → ${path.relative(process.cwd(), out)}`);
  }
  await browser.close();
})();
