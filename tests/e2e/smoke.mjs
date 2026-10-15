// End-to-end smoke test in a real browser (Chromium): sign up, edit a PDF, save it to the workspace, export and
// publish, share it, open the link anonymously and download, create a confidential short link with QR, and collect a
// file through an upload request — all against a production build with the production CSP.
//
// Run: npm run e2e  (starts a throwaway PostgreSQL, a local Supabase Auth stand-in and `next start`; needs `npm run build`)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { startFakeSupabase } from './fake-supabase.mjs';

const APP_PORT = 3100;
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const AUTH_PORT = 54399;
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('run through tools/with-postgres.mjs (npm run e2e)');

const step = (s) => console.log(`\n▶ ${s}`);
/** With E2E_ARTIFACTS set, keeps screenshots of key screens for review. */
const shot = async (page, name) => process.env.E2E_ARTIFACTS && page.screenshot({ path: join(process.env.E2E_ARTIFACTS, `e2e-${name}.png`) });
const ok = (s) => console.log(`  ✓ ${s}`);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  ok(msg);
}

async function fixturePdf() {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const n of [1, 2]) d.addPage([595, 842]).drawText(`Original page ${n}`, { x: 72, y: 760, size: 24, font: f });
  return Buffer.from(await d.save());
}

async function textOf(bytes) {
  const doc = await getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(' '));
  return out;
}

async function main() {
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'tools/admin.ts', 'migrate'], {
    stdio: 'inherit',
    env: { ...process.env, DB_SCHEMA: 'rokela' },
  });
  const auth = await startFakeSupabase(AUTH_PORT);
  const env = {
    ...process.env,
    APP_ENV: 'development',
    NODE_ENV: 'production',
    DATABASE_URL: DB,
    SUPABASE_URL: `http://127.0.0.1:${AUTH_PORT}`,
    SUPABASE_PUBLISHABLE_KEY: 'e2e-publishable-key',
    PUBLIC_ORIGIN: ORIGIN,
    CONTENT_PORT: '3101',
    LOCAL_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'rokela-e2e-')),
    JOB_INTERVAL_SECONDS: '1',
    RATE_LIMIT_PER_MINUTE: '100000',
  };
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(APP_PORT), '-H', '127.0.0.1'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appLog = '';
  app.stdout.on('data', (d) => (appLog += d));
  app.stderr.on('data', (d) => (appLog += d));
  const browser = await chromium.launch();
  const problems = [];
  const pages = [];
  const watch = (page, who) => {
    pages.push([who, page]);
    page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) problems.push(`${who} CSP: ${m.text()}`);
      else if (m.type() === 'error') console.log(`  (${who} console: ${m.text().slice(0, 200)})`);
    });
  };
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

    step('Landing page and security headers');
    const owner = await browser.newContext({ acceptDownloads: true });
    const p = await owner.newPage();
    watch(p, 'owner');
    const res = await p.goto(ORIGIN);
    const csp = res.headers()['content-security-policy'] ?? '';
    check(
      /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/.test(csp) && !csp.includes("'unsafe-eval'"),
      'strict nonce-based CSP without unsafe-eval',
    );
    check(res.headers()['x-frame-options'] === 'DENY', 'framing denied');
    await p.getByRole('heading', { name: /Edit, finish and share PDFs/ }).waitFor();
    ok('landing page renders');

    step('Sign up');
    await p.goto(`${ORIGIN}/signin?mode=signup`);
    await p.getByLabel('Email').fill('owner@example.test');
    await p.getByLabel('Password').fill('correct horse battery');
    await p.getByRole('button', { name: 'Create account' }).click();
    await p.waitForURL(/\/app/);
    await p.getByRole('heading', { name: /Personal workspace · usage/ }).waitFor();
    ok('account created and personal workspace shown');

    step('Edit a PDF in the browser');
    await p.goto(`${ORIGIN}/edit`);
    await p
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: await fixturePdf() });
    await p.locator('.page').first().waitFor();
    const canvas = p.locator('.page .page-canvas').first();
    await p.waitForFunction(() => {
      const c = document.querySelector('.page .page-canvas');
      return !!c && (c.dataset.rendered === '1' || !!c.dataset.renderError);
    });
    const renderError = await canvas.getAttribute('data-render-error');
    check(!renderError, `page rendered without error${renderError ? `: ${renderError}` : ''}`);
    const dark = await canvas.evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 128) n++;
      return n;
    });
    check(dark > 50, `the page shows its text (${dark} dark pixels)`);
    ok('pdf.js rendered the page (worker loaded under CSP)');
    check((await p.locator('.thumb').count()) === 2, 'two page thumbnails');
    await p.getByRole('radio', { name: 'Text' }).click();
    const page1 = p.locator('.page').first();
    const box = await page1.boundingBox();
    await p.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.3);
    await p.getByLabel('Text', { exact: true }).fill('Signed by Rokela');
    await p.keyboard.press('Control+Enter');
    await p.locator('.page svg text', { hasText: 'Signed by Rokela' }).waitFor();
    ok('text annotation placed');
    await p.getByRole('radio', { name: 'Highlight' }).click();
    await p.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.08);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.12, { steps: 5 });
    await p.mouse.up();
    check((await p.locator('.page').first().locator('rect.annot').count()) === 1, 'highlight drawn');
    await p.getByRole('button', { name: 'Rotate page 2 right' }).click();
    await p.getByRole('button', { name: 'Undo', exact: true }).click();
    await p.getByRole('button', { name: 'Redo', exact: true }).click();
    ok('rotated page 2 (with undo/redo)');
    await shot(p, 'editor');

    step('Save to workspace, export and publish');
    await p.getByRole('button', { name: 'Save to workspace' }).click();
    await p.getByLabel('Document title').fill('Service agreement');
    await p.getByRole('button', { name: 'Save draft', exact: true }).click();
    await p.waitForURL(/\/edit\?ws=.*&doc=/);
    await p.getByText('Draft saved privately').waitFor();
    ok('draft uploaded directly to storage');
    await p.getByRole('link', { name: /Export & share/ }).click();
    await p.getByRole('heading', { name: 'Service agreement' }).waitFor();
    for (let i = 0; ; i++) {
      const [resp] = await Promise.all([
        p.waitForResponse((x) => x.url().endsWith('/export') && x.request().method() === 'POST'),
        p.getByRole('button', { name: 'Export new version' }).click(),
      ]);
      if (resp.status() === 201) break;
      const body = await resp.json().catch(() => ({}));
      if (i > 20) throw new Error(`export failed: ${resp.status()} ${body.message}`);
      console.log(`  (export not ready yet: ${resp.status()} ${body.message})`);
      await p.waitForTimeout(1000);
    }
    await p.getByText('Version 1 exported').waitFor();
    ok('version 1 exported after the draft passed checks');
    await p.getByRole('button', { name: 'Publish', exact: true }).click();
    await p.getByText('Version 1 is now the published version').waitFor();
    ok('published');

    step('Share the latest published version');
    await p.getByRole('button', { name: 'Share latest published version' }).click();
    await p.getByRole('button', { name: 'Create share link' }).click();
    const shareUrl = await p.getByLabel('Share link URL').inputValue();
    await shot(p, 'share-link');
    check(shareUrl.startsWith(`${ORIGIN}/s/`), `share link created (${shareUrl.slice(0, 40)}…)`);

    step('Recipient opens the link anonymously and downloads');
    const anon = await browser.newContext({ acceptDownloads: true });
    const r = await anon.newPage();
    watch(r, 'recipient');
    await r.goto(shareUrl);
    await r.getByRole('heading', { name: 'Service agreement' }).waitFor();
    const [dl] = await Promise.all([r.waitForEvent('download'), r.getByRole('button', { name: 'Download', exact: true }).click()]);
    const bytes = readFileSync(await dl.path());
    const doc = await PDFDocument.load(bytes);
    check(doc.getPageCount() === 2, 'downloaded PDF has 2 pages');
    check(doc.getPage(1).getRotation().angle === 90, 'page 2 is rotated');
    const text = await textOf(bytes);
    check(text[0].includes('Signed by Rokela') && text[0].includes('Original page 1'), 'added text is in the downloaded file');
    await r.getByRole('button', { name: 'I confirm receipt' }).waitFor();
    await r.getByLabel(/Your name/).fill('Aminata');
    await r.getByRole('button', { name: 'I confirm receipt' }).click();
    await r.getByText('Receipt confirmed. Thank you.').waitFor();
    await shot(r, 'recipient');
    ok('receipt confirmed');

    step('Confidential short link with QR code');
    await p.getByRole('button', { name: 'Create confidential short link' }).click();
    await p.getByRole('img', { name: /QR code for/ }).waitFor();
    check(await p.getByRole('img', { name: /QR code for/ }).evaluate((img) => img.naturalWidth > 0), 'QR code image loaded');
    await shot(p, 'short-link');
    const shortUrl = await p.getByLabel('Short URL').inputValue();
    await r.goto(shortUrl);
    await r.waitForURL(/\/s\//);
    await r.getByRole('heading', { name: 'Service agreement' }).waitFor();
    ok('short link resolves to the share');

    step('Revoke the share link');
    await p.goto(
      `${p.url().split('?')[0]}?${new URL(p.url()).searchParams
        .toString()
        .replace(/tab=[^&]*/, 'tab=links')
        .replace(/&id=[^&]*/, '')}`,
    );
    await p.getByRole('button', { name: 'Manage' }).first().click();
    p.once('dialog', (d) => d.accept('no longer needed'));
    await p.getByRole('button', { name: 'Revoke', exact: true }).click();
    await p.getByText('revoked').first().waitFor();
    await r.goto(shareUrl);
    await r.getByText('The sender revoked this link.').waitFor();
    ok('revoked link shows a clear state to the recipient');

    step('Request files from someone (plan feature)');
    await p.getByRole('button', { name: 'Upload requests' }).click();
    await p.getByText(/Upload requests are not included/).waitFor();
    ok('free plan explains that upload requests are not included');
    const orgId = new URL(p.url()).searchParams.get('ws');
    const tool = (...args) =>
      execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'tools/admin.ts', ...args], { env: { ...process.env, DB_SCHEMA: 'rokela' } }).toString();
    tool('operator', '--email', 'owner@example.test', '--reason', 'e2e operator');
    tool(
      'plan',
      '--org',
      orgId,
      '--plan',
      'business',
      '--entitlements',
      '{"share_upload_requests":true}',
      '--by',
      'owner@example.test',
      '--reason',
      'e2e upgrade',
    );
    await p.reload();
    await p.getByRole('button', { name: 'Upload requests' }).click();
    await p.getByLabel('Title').fill('Your ID for onboarding');
    await p.getByLabel(/Files you need/).fill('ID scan');
    await p.getByRole('button', { name: 'Create upload request' }).click();
    const reqUrl = await p.getByLabel('Upload request URL').inputValue();
    await r.goto(reqUrl);
    await r.getByLabel('Your name').fill('Aminata');
    await r.getByRole('button', { name: 'Start', exact: true }).click();
    await r.getByLabel('Upload ID scan').setInputFiles({ name: 'id.pdf', mimeType: 'application/pdf', buffer: await fixturePdf() });
    await r.getByText(/id\.pdf · .* · (received, being checked|available)/).waitFor();
    await r.getByRole('button', { name: 'Send files', exact: true }).click();
    await r.getByRole('heading', { name: 'Files sent' }).waitFor();
    await p.reload();
    await p.getByText('Aminata').waitFor();
    ok('submission received by the requester');

    if (problems.length) throw new Error(`browser problems:\n${problems.join('\n')}`);
    console.log('\nE2E smoke test passed.');
  } catch (e) {
    console.error(String(e?.stack ?? e));
    const dir = process.env.E2E_ARTIFACTS ?? tmpdir();
    for (const [who, pg] of pages) {
      const toast = await pg
        .locator('.toast')
        .innerText()
        .catch(() => '');
      await pg.screenshot({ path: join(dir, `e2e-${who}.png`), fullPage: true }).catch(() => undefined);
      console.error(`${who}: ${pg.url()} toast="${toast}" screenshot ${join(dir, `e2e-${who}.png`)}`);
    }
    if (problems.length) console.error(`browser problems:\n${problems.join('\n')}`);
    console.error(`--- app log (tail) ---\n${appLog.slice(-4000)}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    app.kill('SIGTERM');
    auth.close();
  }
}

await main();
