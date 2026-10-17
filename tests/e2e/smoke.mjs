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
import { PDFDocument, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
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
    await p.getByRole('heading', { name: /Every PDF tool you need/ }).waitFor();
    check((await p.locator('.tiles a.tile[href^="/tools/"]').count()) >= 20, 'home page lists every tool');
    ok('landing page renders');
    await shot(p, 'home');

    step('Browser tools (no account, nothing uploaded)');
    const visitor = await browser.newContext({ acceptDownloads: true });
    const v = await visitor.newPage();
    watch(v, 'visitor');
    const uploads = [];
    v.on('request', (rq) => rq.method() !== 'GET' && uploads.push(`${rq.method()} ${rq.url()}`));
    const fetchDownload = async (locator) => {
      const [dl] = await Promise.all([v.waitForEvent('download'), locator.click()]);
      return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
    };
    const pdf = await fixturePdf();
    const runTool = async (slug, files, title) => {
      await v.goto(`${ORIGIN}/tools/${slug}`);
      await v.getByTestId('tool-input').setInputFiles(files);
      await v.getByRole('button', { name: title, exact: true }).click();
      await v.locator('.results').waitFor();
    };

    await runTool(
      'merge-pdf',
      [
        { name: 'a.pdf', mimeType: 'application/pdf', buffer: pdf },
        { name: 'b.pdf', mimeType: 'application/pdf', buffer: pdf },
      ],
      'Merge PDF',
    );
    const merged = await fetchDownload(v.getByRole('link', { name: /^Download a-merged\.pdf/ }));
    check((await PDFDocument.load(merged.bytes)).getPageCount() === 4, 'merge: two 2-page PDFs became 4 pages');

    await v.goto(`${ORIGIN}/tools/split-pdf`);
    await v.getByTestId('tool-input').setInputFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf });
    await v.locator('.picker-page canvas').nth(1).waitFor();
    check((await v.locator('.picker-page').count()) === 2, 'split: page thumbnails shown');
    await v.getByRole('radio', { name: 'Every page' }).click();
    await v.getByRole('button', { name: 'Split PDF', exact: true }).click();
    await v.getByText('2 files are ready').waitFor();
    await shot(v, 'split');
    const zip = await fetchDownload(v.getByRole('button', { name: /Download all/ }));
    check(zip.bytes.subarray(0, 2).toString() === 'PK' && zip.name === 'contract.zip', 'split: one file per page, downloadable as a ZIP');

    await v.goto(`${ORIGIN}/tools/delete-pages`);
    await v.getByTestId('tool-input').setInputFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf });
    await v.getByRole('button', { name: 'Page 2', exact: true }).click();
    check((await v.getByLabel('Pages to delete').inputValue()) === '2', 'delete: clicking a thumbnail fills in the page range');
    await v.getByRole('button', { name: 'Delete PDF pages', exact: true }).click();
    const trimmed = await fetchDownload(v.getByRole('link', { name: /^Download / }));
    check((await textOf(trimmed.bytes)).join('|') === 'Original page 1', 'delete: page 2 removed');

    await runTool('watermark-pdf', { name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf }, 'Add watermark');
    const marked = await fetchDownload(v.getByRole('link', { name: /^Download / }));
    check(
      (await textOf(marked.bytes)).every((t) => t.includes('CONFIDENTIAL')),
      'watermark on every page',
    );

    // Batch: the same tool on two PDFs (with the same name) gives one ZIP with both results.
    await v.goto(`${ORIGIN}/tools/watermark-pdf`);
    await v.getByTestId('tool-input').setInputFiles([
      { name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf },
      { name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf },
    ]);
    await v.getByText('The same settings are applied to each file').waitFor();
    await v.getByRole('button', { name: /^Add watermark/ }).click();
    await v.getByText('2 files are ready').waitFor();
    const batchZip = await fetchDownload(v.getByRole('button', { name: /Download all/ }));
    const batch = unzipSync(new Uint8Array(batchZip.bytes));
    const batchNames = Object.keys(batch).sort();
    let batchMarked = true;
    for (const n of batchNames) batchMarked &&= (await textOf(Buffer.from(batch[n]))).every((t) => t.includes('CONFIDENTIAL'));
    check(
      batchNames.join(',') === 'contract-watermarked (2).pdf,contract-watermarked.pdf' && batchMarked,
      'batch: two PDFs watermarked in one go, distinct names in the ZIP',
    );

    // A PDF with a large photo-like image (stored losslessly) and some text.
    const photoPdf = await (async () => {
      const d = await PDFDocument.create();
      const page = d.addPage([595, 842]);
      page.drawText('Site survey', { x: 60, y: 780, size: 22, font: await d.embedFont(StandardFonts.Helvetica) });
      const [w, h] = [1400, 1000];
      const px = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 3;
          const n = (x * 7 + y * 13) % 17;
          px[o] = (x / 6 + n) & 255;
          px[o + 1] = (y / 4 + n) & 255;
          px[o + 2] = ((x + y) / 10) & 255;
        }
      const img = d.context.register(
        d.context.flateStream(px, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }),
      );
      const name = page.node.newXObject('Photo', img);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(500, 0, 0, 357, 48, 380), drawObject(name), popGraphicsState());
      return Buffer.from(await d.save());
    })();
    await v.goto(`${ORIGIN}/tools/compress-pdf`);
    await v.getByTestId('tool-input').setInputFiles({ name: 'survey.pdf', mimeType: 'application/pdf', buffer: photoPdf });
    await v.getByRole('radio', { name: /Strong/ }).click();
    await v.getByRole('button', { name: /^Compress PDF/ }).click();
    await v.locator('.results').waitFor();
    const note = await v.locator('.done-note').innerText();
    const small = await fetchDownload(v.getByRole('link', { name: /^Download/ }));
    check(
      small.bytes.length < photoPdf.length / 3 && /\d+% smaller/.test(note) && (await textOf(small.bytes))[0].includes('Site survey'),
      `compress: ${photoPdf.length} → ${small.bytes.length} bytes (${note}), text kept`,
    );

    await runTool('pdf-to-png', { name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf }, 'PDF to PNG');
    const png = await fetchDownload(v.getByRole('link', { name: 'contract-page-1.png' }));
    check(png.bytes.subarray(1, 4).toString() === 'PNG' && png.bytes.length > 2000, `pdf to png: page rendered (${png.bytes.length} bytes)`);

    await runTool('jpg-to-pdf', { name: 'page.png', mimeType: 'image/png', buffer: png.bytes }, 'JPG to PDF');
    const fromImage = await fetchDownload(v.getByRole('link', { name: /^Download page\.pdf/ }));
    check((await PDFDocument.load(fromImage.bytes)).getPageCount() === 1, 'image to pdf: one page per image');

    await v.goto(`${ORIGIN}/tools/sign-pdf`);
    await v.getByTestId('tool-input').setInputFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf });
    await v.waitForURL(/\/edit\?handoff=1&tool=signature/);
    const pad = v.getByLabel('Draw your signature here');
    await pad.waitFor();
    const pb = await pad.boundingBox();
    await v.mouse.move(pb.x + pb.width * 0.15, pb.y + pb.height * 0.6);
    await v.mouse.down();
    await v.mouse.move(pb.x + pb.width * 0.5, pb.y + pb.height * 0.3, { steps: 6 });
    await v.mouse.move(pb.x + pb.width * 0.8, pb.y + pb.height * 0.65, { steps: 6 });
    await v.mouse.up();
    await v.getByRole('button', { name: 'Use signature' }).click();
    const sp = await v.locator('.page').first().boundingBox();
    await v
      .locator('.page')
      .first()
      .click({ position: { x: sp.width * 0.6, y: sp.height * 0.3 } });
    await v.locator('.page').first().locator('svg image').waitFor();
    const signed = await fetchDownload(v.getByRole('button', { name: 'Download PDF' }));
    const sdoc = await getDocument({ data: new Uint8Array(signed.bytes), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` })
      .promise;
    const sops = await (await sdoc.getPage(1)).getOperatorList();
    check(sops.fnArray.includes(OPS.paintImageXObject), 'sign: the handed-over PDF opened with the signature tool, and the signature is in the download');

    await v.goto(`${ORIGIN}/tools/create-fillable-pdf`);
    await v.getByTestId('tool-input').setInputFiles({ name: 'form.pdf', mimeType: 'application/pdf', buffer: pdf });
    await v.waitForURL(/tool=field/);
    const fp = v.locator('.page').first();
    await fp.waitFor();
    const fb = await fp.boundingBox();
    await v.mouse.move(fb.x + fb.width * 0.1, fb.y + fb.height * 0.2);
    await v.mouse.down();
    await v.mouse.move(fb.x + fb.width * 0.5, fb.y + fb.height * 0.24, { steps: 5 });
    await v.mouse.up();
    await v.getByRole('radio', { name: 'Checkbox' }).click();
    await fp.click({ position: { x: fb.width * 0.1, y: fb.height * 0.32 } });
    const fillable = await fetchDownload(v.getByRole('button', { name: 'Download PDF' }));
    const fields = (await PDFDocument.load(fillable.bytes)).getForm().getFields();
    check(fields.map((f) => f.constructor.name).join(',') === 'PDFTextField,PDFCheckBox', 'create fillable: text field and checkbox added');

    await v.goto(`${ORIGIN}/tools/organize-pdf`);
    await v.getByTestId('tool-input').setInputFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf });
    await v.locator('.org-card canvas').nth(1).waitFor();
    await v.getByRole('button', { name: 'Rotate page 1' }).click();
    await v.getByRole('button', { name: 'Move page 2 earlier' }).click();
    await v.getByRole('button', { name: /Add a blank page/ }).click();
    await v.getByTestId('organize-add').setInputFiles({ name: 'annex.pdf', mimeType: 'application/pdf', buffer: pdf });
    await v.locator('.org-card').nth(4).waitFor();
    // Drag the last page in front of the first.
    await v
      .locator('.org-card')
      .nth(4)
      .dragTo(v.locator('.org-card').nth(0), { targetPosition: { x: 8, y: 60 } });
    await v.getByRole('button', { name: /^Organize PDF/ }).click();
    const organized = await fetchDownload(v.getByRole('link', { name: /^Download/ }));
    const orgDoc = await PDFDocument.load(organized.bytes);
    check(
      (await textOf(organized.bytes)).join('|') === 'Original page 2|Original page 2|Original page 1||Original page 1' &&
        orgDoc.getPage(2).getRotation().angle === 90,
      'organize: rotate, move, blank page, second PDF and drag-and-drop all applied',
    );

    await v.goto(ORIGIN);
    await v.locator('.home-hero input[type=file]').setInputFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf });
    await v.waitForURL(/\/edit\?handoff=1/);
    await v.locator('.thumb').nth(1).waitFor();
    ok('home page drop opens the PDF in the editor');
    await shot(v, 'tools');
    check(uploads.length === 0, `browser tools sent no files to the server${uploads.length ? `: ${uploads.join(', ')}` : ''}`);

    step('Sign up');
    await p.goto(`${ORIGIN}/signin?mode=signup`);
    await p.getByLabel('Email').fill('owner@example.test');
    await p.getByLabel('Password').fill('correct horse battery');
    await p.getByRole('button', { name: 'Create account' }).click();
    await p.waitForURL(/\/app/);
    await p.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
    ok('account created and personal workspace shown');

    step('Send files, WeTransfer-style');
    await p.goto(`${ORIGIN}/send`);
    await p.waitForURL(/tab=transfers/);
    await p.getByTestId('send-files').setInputFiles([
      { name: 'contract.pdf', mimeType: 'application/pdf', buffer: await fixturePdf() },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Meeting notes\nBring the drawings.\n') },
    ]);
    await p.getByRole('radio', { name: 'Get a link' }).click();
    await p.getByLabel('Title').fill('Project pack');
    await p.getByLabel('Message').fill('Here are the files we discussed.');
    await p.getByRole('button', { name: 'Transfer', exact: true }).click();
    await p.getByRole('heading', { name: 'Your link is ready' }).waitFor();
    const packUrl = await p.getByLabel('Transfer link').inputValue();
    check(/\/s\/[A-Za-z0-9_-]{43}$/.test(packUrl), 'link mode: files uploaded and one link created');
    await shot(p, 'send-done');
    await p.getByRole('button', { name: 'Send another' }).click();
    await p.getByTestId('send-files').setInputFiles({ name: 'brief.pdf', mimeType: 'application/pdf', buffer: await fixturePdf() });
    await p.getByRole('radio', { name: 'Send email' }).click();
    await p.getByLabel('Email to').fill('client@example.test');
    await p.keyboard.press('Enter');
    await p.getByRole('button', { name: 'Transfer', exact: true }).click();
    await p.getByRole('heading', { name: 'Your links are ready' }).waitFor();
    check(
      (await p.locator('a[href^="mailto:client%40example.test"]').count()) === 1,
      'email mode without a mail provider: a personal link per recipient to send yourself',
    );

    const rc = await browser.newContext({ acceptDownloads: true });
    // Force the in-memory ZIP path (headless Chromium has no save dialog to answer).
    await rc.addInitScript(() => delete window.showSaveFilePicker);
    const rp = await rc.newPage();
    watch(rp, 'transfer-recipient');
    await rp.goto(packUrl);
    await rp.getByRole('heading', { name: 'Project pack' }).waitFor();
    for (let i = 0; !(await rp.getByRole('button', { name: 'Download all' }).isVisible()); i++) {
      if (i > 30) throw new Error('files never became available');
      await new Promise((r) => setTimeout(r, 1000));
      await rp.reload();
      await rp.getByRole('heading', { name: 'Project pack' }).waitFor();
    }
    check(await rp.getByText('2 files').isVisible(), 'recipient sees the file count and size');
    await rp
      .locator('li', { hasText: 'notes.txt' })
      .getByRole('button', { name: /Preview/ })
      .click();
    await rp.locator('.preview pre', { hasText: 'Meeting notes' }).waitFor();
    ok('text file previewed in the page');
    await rp.getByRole('button', { name: 'Close' }).click();
    await rp
      .locator('li', { hasText: 'contract.pdf' })
      .getByRole('button', { name: /Preview/ })
      .click();
    await rp.locator('.preview .picker-page canvas').first().waitFor();
    ok('PDF previewed in the page');
    await rp.getByRole('button', { name: 'Close' }).click();
    const [zipDl] = await Promise.all([rp.waitForEvent('download'), rp.getByRole('button', { name: 'Download all' }).click()]);
    const zipped = unzipSync(new Uint8Array(readFileSync(await zipDl.path())));
    check(
      zipDl.suggestedFilename() === 'Project pack.zip' &&
        Object.keys(zipped).sort().join(',') === 'contract.pdf,notes.txt' &&
        strFromU8(zipped['notes.txt']).startsWith('Meeting notes'),
      'download all: one ZIP with every file',
    );
    await shot(rp, 'transfer-recipient');
    await rc.close();

    await p.goto(`${ORIGIN}/app?tab=transfers`);
    await p.getByRole('button', { name: /Project pack/ }).click();
    await p.getByRole('heading', { name: 'Recipients' }).waitFor();
    await p.locator('.people li', { hasText: 'Shareable link' }).getByText('Downloaded 1×').waitFor();
    ok('sender sees the download on the transfer');
    await shot(p, 'transfer-detail');

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
    await shot(p, 'document');

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
    await shot(r, 'upload-request');
    await r.getByRole('button', { name: 'Send files', exact: true }).click();
    await r.getByRole('heading', { name: 'Files sent' }).waitFor();
    await p.reload();
    await p.getByText('Aminata').waitFor();
    await shot(p, 'request-detail');
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
