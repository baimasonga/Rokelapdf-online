// Google Play store images (docs/google-play.md): the 512 × 512 icon, the 1024 × 500 feature graphic and 1080 × 1920
// phone screenshots, rendered from store.html into ads-out/store/. Uses the screens the adverts capture, so run
// `node tools/ads/capture.mjs` first (or `npm run ads`). Run from mobile/: node tools/store/render.mjs
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, 'ads-out', 'store');
if (!existsSync(join(root, 'ads-out', 'screens', '01-home.png'))) throw new Error('no screens: run node tools/ads/capture.mjs first');
mkdirSync(out, { recursive: true });

const SHOTS = ['home', 'scan', 'sign', 'edit', 'split', 'convert', 'protect', 'compress'];
const IMAGES = [
  ['icon', 512, 512, 'icon-512.png'],
  ['feature', 1024, 500, 'feature-graphic-1024x500.png'],
  ...SHOTS.map((s, i) => [s, 1080, 1920, `phone-${i + 1}-${s}.png`]),
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
try {
  for (const [card, width, height, name] of IMAGES) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`${pathToFileURL(join(here, 'store.html'))}?card=${card}`);
    await page.evaluate(() => window.ready);
    // Google Play wants the icon and feature graphic without transparency; PNG screenshots are fine as they are.
    await page.screenshot({ path: join(out, name), omitBackground: false });
    await page.close();
    console.log('wrote', name);
  }
} finally {
  await browser.close();
}
