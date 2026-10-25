// Step 2 of the adverts (npm run ads): renders ad.html frame by frame from the screens capture.mjs took, encodes each
// advert as H.264 MP4, and mixes its sound. Needs ffmpeg on the PATH.
//
// Sound is optional and never committed (music licences allow use in a video, not redistributing the file):
//   ADS_MUSIC=path/to/music.mp3    background music, faded in and out and lowered while the voice speaks
//   ADS_VOICE=path/to/voice.onnx   a Piper voice (https://github.com/rhasspy/piper) that reads each scene's `vo` line;
//                                  PIPER names the piper command if it is not on the PATH. Scenes stretch to fit.
// With neither, the advert gets a silent audio track.
//
// node tools/ads/render.mjs [w h cut name]... renders one advert; with no arguments, all three.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, 'ads-out');
const FPS = 30;
const MUSIC = process.env.ADS_MUSIC;
const VOICE = process.env.ADS_VOICE;
const PIPER = process.env.PIPER || 'piper';
// A line starts this long after its scene does (once the caption is in) and leaves this much room before the next.
const LEAD = 0.35;
const TAIL = 0.35;
const ADS =
  process.argv.length > 2
    ? [[+process.argv[2], +process.argv[3], process.argv[4], process.argv[5]]]
    : [
        [1080, 1920, 'full', 'rokela-pdf-android-30s-9x16'],
        [1080, 1920, 'short', 'rokela-pdf-android-15s-9x16'],
        [1920, 1080, 'full', 'rokela-pdf-android-30s-16x9'],
      ];

for (const [name, file] of [
  ['ADS_MUSIC', MUSIC],
  ['ADS_VOICE', VOICE],
])
  if (file && !existsSync(file)) throw new Error(`${name}: ${file} does not exist`);

const run = (cmd, args, input) => execFileSync(cmd, args, { input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'] });
const seconds = (file) => +run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();

/** Speaks one line with Piper, trimmed of leading and trailing silence; cached by voice and text. */
function speak(text) {
  const dir = join(out, 'voice');
  mkdirSync(dir, { recursive: true });
  const id = createHash('sha1').update(`${VOICE}\n${text}`).digest('hex').slice(0, 16);
  const wav = join(dir, `${id}.wav`);
  if (!existsSync(wav)) {
    const raw = join(dir, `${id}.raw.wav`);
    run(PIPER, ['-m', VOICE, '-f', raw, '--length-scale', '0.9', '--sentence-silence', '0.12'], text);
    const trim = 'silenceremove=start_periods=1:start_threshold=-45dB';
    run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', raw, '-af', `${trim},areverse,${trim},areverse`, '-ar', '48000', '-ac', '2', wav]);
    rmSync(raw);
  }
  return { wav, length: seconds(wav) };
}

/** Music under the voice: the music ducks while a line plays, then everything is levelled for social platforms. */
function mix(video, lines, duration, target) {
  const args = ['-nostdin', '-v', 'error', '-y', '-i', video];
  const parts = [];
  let n = 1;
  let music = null;
  if (MUSIC) {
    args.push('-i', MUSIC);
    const fadeOut = Math.max(0, duration - 2);
    parts.push(
      `[${n}:a]atrim=0:${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=0.6,` +
        `afade=t=in:d=0.6,afade=t=out:st=${fadeOut}:d=2[music]`,
    );
    music = '[music]';
    n++;
  }
  let voice = null;
  if (lines.length) {
    for (const [i, l] of lines.entries()) {
      args.push('-i', l.wav);
      const ms = Math.round(l.at * 1000);
      parts.push(`[${n}:a]adelay=${ms}|${ms}[v${i}]`);
      n++;
    }
    parts.push(`${lines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${lines.length}:normalize=0,apad[voice]`);
    voice = '[voice]';
  }
  // The music dips about 13 dB under the voice: clearly behind it, but still there.
  if (music && voice) {
    parts.push('[voice]asplit=2[vo][key]');
    parts.push('[music][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=450[ducked]');
    parts.push('[ducked][vo]amix=inputs=2:normalize=0[mixed]');
  } else if (music || voice) parts.push(`${music || voice}anull[mixed]`);
  else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    parts.push(`[${n}:a]anull[mixed]`);
  }
  // -14 LUFS is what TikTok, Instagram and YouTube normalise to, so the advert is neither quieter nor turned down.
  parts.push(`[mixed]${music || voice ? 'loudnorm=I=-14:TP=-1.5:LRA=11,' : ''}aresample=48000[a]`);
  args.push('-filter_complex', parts.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k');
  args.push('-t', String(duration), '-movflags', '+faststart', target);
  run('ffmpeg', args);
}

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

  // Voice first: a scene whose line needs longer than its planned length is stretched to fit.
  const scenes = await page.evaluate(() => window.SCENES);
  const spoken = VOICE ? scenes.map((s) => (s.vo ? speak(s.vo) : null)) : scenes.map(() => null);
  const durs = scenes.map((s, i) => (spoken[i] ? Math.max(s.dur, LEAD + spoken[i].length + TAIL) : s.dur));
  const starts = await page.evaluate((d) => window.setDurations(d), durs);
  const lines = spoken.flatMap((v, i) => (v ? [{ wav: v.wav, at: starts[i] + LEAD }] : []));
  const duration = await page.evaluate(() => window.DURATION);

  // Frames go to ffmpeg as PNGs on stdin, so every frame is exact whatever the machine's speed.
  const video = join(out, `${name}.video.mp4`);
  const ff = spawn(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-'].concat([
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
      video,
    ]),
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

  const target = join(out, `${name}.mp4`);
  mix(video, lines, frames / FPS, target);
  rmSync(video);
  const sound = [MUSIC && 'music', lines.length && `${lines.length} voice lines`].filter(Boolean).join(' and ') || 'silent';
  console.log(`${target}: ${frames} frames, ${(frames / FPS).toFixed(1)}s, ${sound}`);
  await page.close();
}
await browser.close();
