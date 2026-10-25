// Step 2 of the adverts (npm run ads): renders ad.html frame by frame from the screens capture.mjs took, and encodes
// each advert as H.264 MP4 with a silent audio track (add music on the platform). Needs ffmpeg on the PATH.
// node tools/ads/render.mjs [w h cut name]... renders one advert; with no arguments, all three.
import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, 'ads-out');
const FPS = 30;
const ADS =
  process.argv.length > 2
    ? [[+process.argv[2], +process.argv[3], process.argv[4], process.argv[5]]]
    : [
        [1080, 1920, 'full', 'rokela-pdf-android-30s-9x16'],
        [1080, 1920, 'short', 'rokela-pdf-android-15s-9x16'],
        [1920, 1080, 'full', 'rokela-pdf-android-30s-16x9'],
      ];

// The page loads screens/ and logo.png next to itself.
copyFileSync(join(here, 'ad.html'), join(out, 'ad.html'));
copyFileSync(join(root, '..', 'public', 'brand', 'rokela-icon.png'), join(out, 'logo.png'));
const taps = readFileSync(join(out, 'screens', 'taps.json')).toString('base64');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
for (const [w, h, cut, name] of ADS) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.goto(`${pathToFileURL(join(out, 'ad.html'))}?w=${w}&h=${h}&cut=${cut}&taps=${encodeURIComponent(taps)}`);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.DURATION);
  const target = join(out, `${name}.mp4`);
  // Frames go to ffmpeg as PNGs on stdin, so every frame is exact whatever the machine's speed.
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(FPS),
      '-i',
      '-',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-shortest',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(FPS),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      target,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const frames = Math.round(duration * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    const png = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  const code = await new Promise((r) => ff.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg failed for ${name}`);
  console.log(`${target}: ${frames} frames, ${duration}s`);
  await page.close();
}
await browser.close();
