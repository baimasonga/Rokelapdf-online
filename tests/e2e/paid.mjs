// End-to-end test of the paid tools on the website (src/lib/licensing.ts; docs/licensing.md), in a real browser against
// a production build, after the launch date: signed out, in the free month, after it, and with a licence granted by
// an operator through the admin command.
//
// Run: npm run e2e (after npm run build); runs after tests/e2e/smoke.mjs with its own throwaway database.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import pg from 'pg';
import { startFakeSupabase } from './fake-supabase.mjs';

const APP_PORT = 3100;
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const AUTH_PORT = 54399;
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('run through tools/with-postgres.mjs (npm run e2e)');

const step = (s) => console.log(`\n▶ ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  ok(msg);
}

async function pdf(label) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const n of [1, 2]) d.addPage([595, 842]).drawText(`${label} page ${n}`, { x: 72, y: 760, size: 24, font: f });
  return { name: `${label}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await d.save()) };
}

const admin = (...args) =>
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'tools/admin.ts', ...args], {
    stdio: 'pipe',
    env: { ...process.env, DB_SCHEMA: 'rokela' },
  }).toString();

async function main() {
  admin('migrate');
  const auth = await startFakeSupabase(AUTH_PORT, {});
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(APP_PORT), '-H', '127.0.0.1'], {
    env: {
      ...process.env,
      APP_ENV: 'development',
      NODE_ENV: 'production',
      DATABASE_URL: DB,
      SUPABASE_URL: `http://127.0.0.1:${AUTH_PORT}`,
      SUPABASE_PUBLISHABLE_KEY: 'e2e-publishable-key',
      PUBLIC_ORIGIN: ORIGIN,
      CONTENT_PORT: '3101',
      LOCAL_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'rokela-e2e-paid-')),
      RATE_LIMIT_PER_MINUTE: '100000',
      // Launched in the past, so the locks are on.
      PAID_FEATURES_FROM: '2026-01-01',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appLog = '';
  app.stdout.on('data', (d) => (appLog += d));
  app.stderr.on('data', (d) => (appLog += d));
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
  const errors = [];
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${ORIGIN}/api/v1/config`)).ok) break;
      } catch {
        /* starting */
      }
      if (i > 120) throw new Error(`app did not start:\n${appLog}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const p = await (await browser.newContext({ acceptDownloads: true })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    const choose = async (slug, files) => {
      await p.goto(`${ORIGIN}/tools/${slug}`);
      await p.getByTestId('tool-input').setInputFiles(files);
    };
    const prompt = (name) => p.getByRole('dialog', { name: `${name} is a Pro tool` });

    step('Signed out');
    await choose('merge-pdf', [await pdf('a'), await pdf('b')]);
    await prompt('Merging').waitFor();
    const link = prompt('Merging').getByRole('link', { name: 'Sign in or create an account' });
    check((await link.getAttribute('href')) === '/signin?next=%2Ftools%2Fmerge-pdf', 'Merge asks to sign in, and comes back after');
    await choose('edit-pdf', [await pdf('c')]);
    await prompt('Editing').waitFor();
    check(new URL(p.url()).pathname === '/tools/edit-pdf', 'Edit asks before opening the editor');
    await choose('compress-pdf', [await pdf('d')]);
    await p.getByText('d.pdf').first().waitFor();
    check((await p.getByRole('dialog').count()) === 0, 'Compress stays free without an account');

    step('Free month');
    await p.goto(`${ORIGIN}/signin?mode=signup`);
    await p.getByLabel('Email').fill('buyer@example.test');
    await p.getByLabel('Password').fill('correct horse battery');
    await p.getByRole('button', { name: 'Create account' }).click();
    await p.waitForURL(/\/app/);
    await choose('merge-pdf', [await pdf('a'), await pdf('b')]);
    await p.getByRole('button', { name: 'Merge PDF', exact: true }).click();
    await p.locator('.results').waitFor();
    check((await p.getByRole('dialog').count()) === 0, 'a new account merges in its free month');

    step('After the free month');
    await db.query("UPDATE rokela.users SET created_at = now() - interval '40 days' WHERE email = 'buyer@example.test'");
    await choose('split-pdf', [await pdf('e')]);
    await prompt('Splitting').waitFor();
    const buy = prompt('Splitting').getByRole('link', { name: 'Get a licence' });
    check((await buy.getAttribute('href'))?.startsWith('mailto:'), 'Split asks for a licence');
    await choose('create-fillable-pdf', [await pdf('f')]);
    await p.waitForURL(/\/edit/);
    await p.getByRole('radio', { name: 'Text', exact: true }).click();
    await prompt('Editing').waitFor();
    check((await p.getByRole('radio', { name: 'Text', exact: true }).getAttribute('aria-checked')) === 'false', 'in the editor, the Text tool is locked too');
    await prompt('Editing').getByRole('button', { name: 'Close' }).click();
    const pagesBefore = await p.locator('.thumb-page').count();
    await p.locator('input[type=file][multiple]').setInputFiles([await pdf('g')]);
    await prompt('Merging').waitFor();
    check((await p.locator('.thumb-page').count()) === pagesBefore, "and so is the editor's Add PDF (merging)");
    await p.goto(`${ORIGIN}/receipts`);
    await p.getByLabel('Business name').fill('Kamara & Sons Hardware');
    await p.getByLabel('Item 1', { exact: true }).fill('Cement, 50 kg bag');
    await p.getByLabel('Rate 1').fill('155');
    await p.getByRole('button', { name: 'Download PDF' }).click();
    await prompt('Receipt Maker').waitFor();
    check(!!(await prompt('Receipt Maker').getByRole('link', { name: 'Get a licence' }).count()), 'the Receipt Maker asks for a licence after the free month');
    await prompt('Receipt Maker').getByRole('button', { name: 'Close' }).click();

    step('Licence granted by an operator');
    admin('operator', '--email', 'buyer@example.test', '--reason', 'e2e operator');
    const out = admin('license', '--email', 'buyer@example.test', '--by', 'buyer@example.test', '--reason', 'paid by mobile money');
    check(/licensed until/.test(out), 'npm run license:grant grants a year');
    await choose('split-pdf', [await pdf('e')]);
    await p.getByRole('radio', { name: 'Every page' }).click();
    await p.getByRole('button', { name: 'Split PDF', exact: true }).click();
    await p.getByText('2 files are ready').waitFor();
    check((await p.getByRole('dialog').count()) === 0, 'with a licence, Split works');

    step('Receipt check QR code');
    await p.goto(`${ORIGIN}/receipts`);
    await p.getByLabel('Item 1', { exact: true }).fill('Cement, 50 kg bag');
    await p.getByLabel('Rate 1').fill('155');
    await p.getByLabel('QR code to check it').check();
    const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Download PDF' }).click()]);
    const file = await dl.path();
    const rows = (await db.query('SELECT code, business_name, total, sha256 FROM rokela.receipt_checks')).rows;
    check(
      rows.length === 1 && rows[0].business_name === 'Kamara & Sons Hardware' && Number(rows[0].total) === 155 && !!rows[0].sha256,
      'downloading registers the facts and the file fingerprint',
    );
    await p.goto(`${ORIGIN}/receipts/${rows[0].code}`);
    await p.getByText('Cash receipt on record').waitFor();
    check(await p.getByText('NLe 155.00').isVisible(), 'the check page shows the total');
    await p.getByLabel('PDF to check').setInputFiles(file);
    await p.getByText('Exact match').waitFor();
    check(true, 'and confirms the downloaded PDF is the one that was made');

    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
    console.log('\nPaid tools end-to-end test passed.');
  } finally {
    await browser.close();
    await db.end();
    app.kill();
    auth.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
