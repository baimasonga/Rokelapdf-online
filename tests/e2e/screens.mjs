// Screenshots of every main screen at desktop and phone width, for design review.
// Run: node tools/with-postgres.mjs node tests/e2e/screens.mjs <out-dir>   (needs `npm run build`)
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { startFakeSupabase } from './fake-supabase.mjs';

const OUT = process.argv[2] ?? join(tmpdir(), 'rokela-screens');
mkdirSync(OUT, { recursive: true });
const PORT = 3110;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const AUTH_PORT = 54398;

async function pdf() {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const n of [1, 2, 3]) {
    const p = d.addPage([595, 842]);
    p.drawText(`Service agreement — page ${n}`, { x: 72, y: 760, size: 22, font: f });
    for (let i = 0; i < 24; i++)
      p.drawText('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.', { x: 72, y: 700 - i * 22, size: 11, font: f });
  }
  return Buffer.from(await d.save());
}

execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'tools/admin.ts', 'migrate'], {
  stdio: 'inherit',
  env: { ...process.env, DB_SCHEMA: 'rokela' },
});
const auth = await startFakeSupabase(AUTH_PORT);
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
  env: {
    ...process.env,
    APP_ENV: 'development',
    NODE_ENV: 'production',
    SUPABASE_URL: `http://127.0.0.1:${AUTH_PORT}`,
    SUPABASE_PUBLISHABLE_KEY: 'screens-key',
    PUBLIC_ORIGIN: ORIGIN,
    CONTENT_PORT: '3111',
    LOCAL_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'rokela-screens-')),
    JOB_INTERVAL_SECONDS: '1',
    RATE_LIMIT_PER_MINUTE: '100000',
  },
  stdio: 'ignore',
});
const browser = await chromium.launch();
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${ORIGIN}/api/v1/config`)).ok) break;
    } catch {
      /* starting */
    }
    if (i > 120) throw new Error('app did not start');
    await new Promise((r) => setTimeout(r, 500));
  }
  const file = await pdf();
  for (const [label, viewport] of [
    ['desktop', { width: 1366, height: 860 }],
    ['phone', { width: 390, height: 844 }],
  ]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    const shot = async (name) => {
      await p.waitForTimeout(400);
      await p.screenshot({ path: join(OUT, `${label}-${name}.png`), fullPage: true });
    };
    await p.goto(ORIGIN);
    await shot('01-home');
    await p.goto(`${ORIGIN}/tools`);
    await shot('02-tools');
    await p.goto(`${ORIGIN}/tools/merge-pdf`);
    await shot('03-tool-empty');
    await p.getByTestId('tool-input').setInputFiles([
      { name: 'agreement.pdf', mimeType: 'application/pdf', buffer: file },
      { name: 'annex.pdf', mimeType: 'application/pdf', buffer: file },
    ]);
    await p.getByRole('button', { name: 'Merge PDF', exact: true }).click();
    await p.locator('.results').waitFor();
    await shot('04-tool-done');
    await p.goto(`${ORIGIN}/tools/delete-pages`);
    await p.getByTestId('tool-input').setInputFiles({ name: 'agreement.pdf', mimeType: 'application/pdf', buffer: file });
    await p.locator('.picker-page canvas').nth(2).waitFor();
    await shot('05-tool-pages');
    await p.goto(`${ORIGIN}/edit`);
    await shot('06-editor-empty');
    await p.locator('input[type=file]').first().setInputFiles({ name: 'agreement.pdf', mimeType: 'application/pdf', buffer: file });
    await p.locator('.page .page-canvas[data-rendered="1"]').first().waitFor();
    await shot('07-editor');
    await p.goto(`${ORIGIN}/signin?mode=signup`);
    await shot('08-signup');
    await p.getByLabel('Email').fill(`${label}@example.test`);
    await p.getByLabel('Password').fill('correct horse battery');
    await p.getByRole('button', { name: 'Create account' }).click();
    await p.waitForURL(/\/app/);
    await p.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
    await shot('09-app-home');
    await p.goto(`${ORIGIN}/app?tab=transfers`);
    await p.locator('.send-card').waitFor();
    await shot('10-send-empty');
    await p.getByTestId('send-files').setInputFiles([
      { name: 'agreement.pdf', mimeType: 'application/pdf', buffer: file },
      { name: 'annex.pdf', mimeType: 'application/pdf', buffer: file },
    ]);
    await p.getByLabel('Email to').fill('client@example.test');
    await p.keyboard.press('Enter');
    await p.getByLabel('Title').fill('Signed agreement');
    await shot('11-send-filled');
    await p.getByRole('button', { name: 'Transfer', exact: true }).click();
    await p.locator('.send-card.sent').waitFor();
    await shot('12-send-done');
    const url = await p.locator('.sent-links input').first().inputValue();
    await p.goto(`${ORIGIN}/app?tab=transfers`);
    await p.getByRole('button', { name: /Signed agreement/ }).click();
    await p.getByRole('heading', { name: 'Recipients' }).waitFor();
    await shot('13-transfer');
    await p.goto(`${ORIGIN}/app?tab=links`);
    await shot('14-links');
    const r = await (await browser.newContext({ viewport })).newPage();
    await r.goto(url);
    await r.getByRole('heading', { name: 'Signed agreement' }).waitFor();
    await r.waitForTimeout(2500);
    await r.reload();
    await r.getByRole('heading', { name: 'Signed agreement' }).waitFor();
    await r.screenshot({ path: join(OUT, `${label}-15-recipient.png`), fullPage: true });
    await ctx.close();
  }
  console.log(`screens saved to ${OUT}`);
} finally {
  await browser.close();
  app.kill('SIGTERM');
  auth.close();
}
