// Browser smoke test of the app's web layer at phone size (npm run smoke, after npm run build): every tool is used
// once and each result the app saves is opened and checked. rokelapdf.com (sign-in and the converter) is stubbed;
// scanning and "Open with" need Android and are not covered here.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PDFDocument as SecureDocument } from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const PORT = 4176;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'rokela-mobile-'));
const FONTS = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts/');
const step = (s) => console.log(`\n▶ ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);
function check(cond, what) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  ok(what);
}

async function textOf(bytes) {
  const doc = await getDocument({ data: bytes.slice(), useSystemFonts: false, standardFontDataUrl: FONTS }).promise;
  let s = '';
  for (let n = 1; n <= doc.numPages; n++) s += (await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ') + '\n';
  return { text: s, pages: doc.numPages };
}

async function fixtures(page) {
  const font = async (d) => d.embedFont(StandardFonts.Helvetica);
  const agreement = await PDFDocument.create();
  const p = agreement.addPage([595, 842]);
  p.drawText('TENANCY AGREEMENT', { x: 50, y: 760, size: 22, font: await font(agreement) });
  p.drawText('Tenant: Aminata Kamara', { x: 50, y: 720, size: 12, font: await font(agreement) });
  writeFileSync(join(dir, 'agreement.pdf'), await agreement.save());

  const annex = await PDFDocument.create();
  for (const t of ['Annex A', 'Annex B']) annex.addPage([595, 842]).drawText(t, { x: 50, y: 780, size: 20, font: await font(annex) });
  writeFileSync(join(dir, 'annex.pdf'), await annex.save());

  const long = await PDFDocument.create();
  for (let n = 1; n <= 16; n++) long.addPage([595, 842]).drawText(`Page ${n}`, { x: 50, y: 780, size: 20, font: await font(long) });
  writeFileSync(join(dir, 'long.pdf'), await long.save());

  const form = await PDFDocument.create();
  const fp = form.addPage([595, 842]);
  form.getForm().createTextField('Full name').addToPage(fp, { x: 50, y: 700, width: 300, height: 24 });
  form.getForm().createCheckBox('Agree').addToPage(fp, { x: 50, y: 650, width: 18, height: 18 });
  writeFileSync(join(dir, 'form.pdf'), await form.save());

  // A "photo" of printed words, drawn by the browser, for Photos → PDF, compression and OCR.
  const png = await page.evaluate(() => {
    const c = Object.assign(document.createElement('canvas'), { width: 1240, height: 1754 });
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#111';
    x.font = 'bold 72px Arial';
    x.fillText('RECEIPT OF PAYMENT', 90, 220);
    x.font = '48px Arial';
    ['Received from Aminata Kamara', 'the sum of four thousand five', 'hundred leones for rent.'].forEach((l, i) => x.fillText(l, 90, 380 + i * 80));
    // Speckle so the picture is not trivially compressible.
    for (let i = 0; i < 40000; i++) {
      x.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`;
      x.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2);
    }
    return c.toDataURL('image/png').split(',')[1];
  });
  writeFileSync(join(dir, 'photo.png'), Buffer.from(png, 'base64'));
  const scan = await PDFDocument.create();
  const img = await scan.embedPng(Buffer.from(png, 'base64'));
  scan.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  writeFileSync(join(dir, 'scanned.pdf'), await scan.save());
}

async function main() {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) {
      if (
        await fetch(ORIGIN).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, acceptDownloads: true });
    // rokelapdf.com stand-ins: a signed-in session and a converter that echoes a recognisable file.
    // The paid tools stay free until a launch date is set; the Pro step sets one and answers /me/access itself.
    const site = { launched: null, access: null, offline: false };
    await ctx.route('https://www.rokelapdf.com/api/v1/config', (r) =>
      site.offline
        ? r.abort()
        : r.fulfill({ json: { supabase_url: 'https://demo.supabase.co', supabase_publishable_key: 'demo', paid_features_from: site.launched } }),
    );
    await ctx.route('https://www.rokelapdf.com/api/v1/me/access', (r) => (site.offline ? r.abort() : r.fulfill({ json: site.access })));
    await ctx.route('https://demo.supabase.co/**', (r) => r.fulfill({ json: {} }));
    const converted = [];
    await ctx.route('https://www.rokelapdf.com/api/v1/convert/**', (r) => {
      converted.push(new URL(r.request().url()).pathname);
      r.fulfill({ body: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), headers: { 'content-type': 'application/octet-stream' } });
    });
    await ctx.addInitScript(
      (exp) => {
        localStorage.setItem(
          'rokela-auth',
          JSON.stringify({
            access_token: 'demo',
            refresh_token: 'demo',
            token_type: 'bearer',
            expires_in: 86400,
            expires_at: exp,
            user: { id: 'u1', aud: 'authenticated', email: 'test@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
          }),
        );
      },
      Math.floor(Date.now() / 1000) + 86400,
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(ORIGIN);
    await fixtures(page);

    const file = (name) => join(dir, name);
    const input = (accept, multiple = false) => page.locator(`input[type=file][accept="${accept}"]${multiple ? '[multiple]' : ':not([multiple])'}`).first();
    const openPdf = async (name) => {
      await page.goto(ORIGIN);
      await input('application/pdf,.pdf').setInputFiles(file(name));
      await page.waitForSelector('.page canvas');
      await page.waitForSelector('.page .edit-layer, .page canvas[width]');
    };
    const more = (label) =>
      page
        .getByRole('button', { name: 'All tools', exact: true })
        .click()
        .then(() => page.getByRole('dialog', { name: 'All tools' }).getByRole('button', { name: label, exact: true }).click());
    const saved = async () => {
      const dl = page.waitForEvent('download');
      await more('Save to phone');
      const d = await dl;
      return new Uint8Array(readFileSync(await d.path()));
    };
    const notice = async (re) => {
      await page.locator('.notice', { hasText: re }).waitFor({ timeout: 120_000 });
      return page.locator('.notice').textContent();
    };

    step('Home');
    for (const t of [
      'Scan',
      'Edit PDF',
      'Fill & Sign',
      'Organize pages',
      'Split',
      'Compress',
      'Protect',
      'Make text searchable',
      'Fill in a form',
      'Export PDF',
      'Combine files',
      'Photos to PDF',
      'Office to PDF',
    ])
      await page.locator('.tool-grid').getByRole('button', { name: t, exact: true }).waitFor();
    await page.getByText('Files you open, scan or create appear here.').waitFor();
    ok('every tool is on the home screen, and Recent starts empty');

    step('A tool started from home asks for a PDF, then opens in that tool');
    const pickFirst = page.waitForEvent('filechooser');
    await page.locator('.tool-grid').getByRole('button', { name: 'Edit PDF', exact: true }).click();
    await (await pickFirst).setFiles(file('agreement.pdf'));
    await page.getByRole('heading', { name: 'Edit PDF' }).waitFor();
    await page.locator('.edit-layer').first().waitFor();
    ok('Edit PDF from home opens the chosen file in Edit');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    // A tool whose file picker is abandoned must not start on the next file opened some other way.
    const abandoned = page.waitForEvent('filechooser');
    await page.locator('.tool-grid').getByRole('button', { name: 'Organize pages', exact: true }).click();
    await abandoned;
    await page
      .locator('.list')
      .getByRole('button', { name: /^agreement\.pdf/ })
      .click();
    await page.getByRole('heading', { name: 'agreement.pdf' }).waitFor();
    await page.waitForTimeout(1500);
    check((await page.getByRole('heading', { name: 'Organize pages' }).count()) === 0, 'an abandoned tool does not start on a file opened from Recent');
    ok('the file is in Recent and opens again from there');

    step('Combine PDFs');
    await input('application/pdf,.pdf', true).setInputFiles([file('agreement.pdf'), file('annex.pdf')]);
    await notice(/Combined 2 PDFs/);
    let r = await textOf(await saved());
    check(r.pages === 3 && /TENANCY/.test(r.text) && /Annex B/.test(r.text), 'combined PDF has all 3 pages in order');
    await page.waitForTimeout(800);
    check((await page.locator('.page-pill').textContent()).replace(/\s/g, '') === '1/3', 'the page counter starts at the first page');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
    check((await page.locator('.page-pill').textContent()).replace(/\s/g, '') === '3/3', 'and follows scrolling to the last page');
    await page.evaluate(() => window.scrollTo(0, 0));

    step('Split');
    await more('Split');
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    const parts = page.getByRole('dialog', { name: 'Split into 3 files' });
    await parts.waitFor();
    check((await parts.locator('.row-item').count()) === 3, 'every page becomes its own file');
    await parts.getByRole('button', { name: /pages-2\.pdf/ }).click();
    r = await textOf(await saved());
    check(r.pages === 1 && /Annex A/.test(r.text), 'a part opens and holds just its page');
    await page.goto(ORIGIN);
    await input('application/pdf,.pdf', true).setInputFiles([file('agreement.pdf'), file('annex.pdf')]);
    await notice(/Combined 2 PDFs/);
    await more('Split');
    await page.getByRole('tab', { name: 'Page ranges' }).click();
    await page.getByLabel('Page ranges, one file each').fill('9');
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await page.locator('.snackbar.error').waitFor();
    ok('a range beyond the last page is refused with a message');
    await page.getByLabel('Page ranges, one file each').fill('1, 2-3');
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await page.getByRole('dialog', { name: 'Split into 2 files' }).waitFor();
    check(await page.getByRole('button', { name: /pages-2-3\.pdf/ }).isVisible(), 'page ranges make one file each');
    await page.getByRole('dialog', { name: 'Split into 2 files' }).getByRole('button', { name: 'Done' }).click();
    // Recent keeps 15 files, so a split may make at most 15: more would push the first parts out.
    await openPdf('long.pdf');
    await more('Split');
    const tooMany = page.getByRole('dialog', { name: 'Split PDF' });
    // The sheet opens after the access check, so wait for it rather than reading it at once.
    await tooMany.getByText('That makes 16 files').waitFor();
    check(
      (await tooMany.getByText('That makes 16 files').isVisible()) && (await tooMany.getByRole('button', { name: 'Split', exact: true }).isDisabled()),
      'a split into more than 15 files is explained and cannot start',
    );
    await tooMany.getByRole('tab', { name: 'Page ranges' }).click();
    await tooMany.getByLabel('Page ranges, one file each').fill(Array.from({ length: 16 }, (_, i) => i + 1).join(', '));
    await tooMany.getByRole('button', { name: 'Split', exact: true }).click();
    await page.locator('.snackbar.error', { hasText: 'That makes 16 files' }).waitFor();
    ok('16 typed ranges are refused too');
    await tooMany.getByRole('tab', { name: 'Every few pages' }).click();
    await tooMany.getByRole('button', { name: 'Split', exact: true }).click();
    await page.getByRole('dialog', { name: 'Split into 8 files' }).waitFor();
    ok('every 2 pages makes 8 files');
    await page.getByRole('dialog', { name: 'Split into 8 files' }).getByRole('button', { name: 'Done' }).click();

    step('Photos → PDF');
    await page.goto(ORIGIN);
    await input('image/*', true).setInputFiles(file('photo.png'));
    await notice(/Made a PDF from 1 picture/);
    r = await textOf(await saved());
    check(r.pages === 1, 'one picture makes a one-page PDF');

    step('Edit: text, highlight, draw, cover, image');
    await openPdf('agreement.pdf');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const layer = page.locator('.edit-layer').first();
    const box = await layer.boundingBox();
    await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.3);
    await page.getByLabel('Text', { exact: true }).fill('Paid in full · Привет');
    await page.getByRole('dialog', { name: 'Add text' }).getByRole('button', { name: 'Done' }).click();
    const drag = async (tool, x1, y1, x2, y2) => {
      await page.getByRole('radio', { name: tool }).click();
      const box = await layer.boundingBox();
      await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (x1 + ((x2 - x1) * i) / 8), box.y + box.height * (y1 + ((y2 - y1) * i) / 8));
      await page.mouse.up();
    };
    await drag('Highlight', 0.08, 0.08, 0.6, 0.11);
    await drag('Cover', 0.4, 0.4, 0.8, 0.45);
    // Drawn after the cover and across it: it must show (and save) on top of the cover.
    await drag('Draw', 0.35, 0.38, 0.85, 0.48);
    await page.getByRole('radio', { name: 'Image' }).click();
    await input('image/*').setInputFiles(file('photo.png'));
    await page.getByText(/Tap where the picture goes/).waitFor();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.75);
    check((await page.locator('.edit-layer .text-item').count()) === 1, 'text is shown where it was tapped');
    check(
      (await page.locator('.edit-layer .box').count()) === 2 &&
        (await page.locator('.edit-layer polyline').count()) === 1 &&
        (await page.locator('.edit-layer .placed').count()) === 1,
      'highlight, cover, drawing and picture are shown',
    );
    const stacked = await page.evaluate(() => {
      const els = [...document.querySelector('.edit-layer').children];
      return els.findIndex((e) => e.matches('svg.ink')) > els.findIndex((e) => e.matches('.box.whiteout'));
    });
    check(stacked, 'the preview stacks edits in the order they were made (a stroke drawn after a cover shows on top)');
    await page.getByRole('button', { name: 'Undo' }).click();
    check((await page.locator('.edit-layer .placed').count()) === 0, 'Undo removes the last change');
    await page.getByRole('button', { name: 'Done' }).click();
    await notice(/Changes saved/);
    const edited = await saved();
    r = await textOf(edited);
    check(/Paid in full/.test(r.text) && /TENANCY/.test(r.text), 'edited PDF contains the typed text and the original text');
    check(/Привет/.test(r.text), 'text beyond Latin letters is kept (embedded Unicode font)');

    step('Pages: rotate, add a PDF, move, delete');
    await page.getByRole('button', { name: 'Organize', exact: true }).click();
    const thumb = (n) => page.getByRole('button', { name: `Page ${n}`, exact: true });
    const act = (name) => page.locator('.bottombar').getByRole('button', { name, exact: true }).click();
    await thumb(1).click();
    await act('Rotate');
    await thumb(1).click(); // deselect
    const chooser = page.waitForEvent('filechooser');
    await act('Add a PDF');
    await (await chooser).setFiles(file('annex.pdf'));
    await thumb(3).waitFor();
    await thumb(3).click();
    await act('Move earlier');
    await thumb(2).click(); // the moved page, now second: deselect it
    await thumb(3).click();
    await act('Delete');
    check((await page.locator('.thumb').count()) === 2, 'selected page deleted from the grid');
    await page.getByRole('button', { name: 'Done' }).click();
    await notice(/Saved 2 pages/);
    const organized = await saved();
    const od = await PDFDocument.load(organized);
    r = await textOf(organized);
    check(od.getPageCount() === 2 && od.getPage(0).getRotation().angle === 90, 'page 1 rotated, 2 pages kept');
    check(/Paid in full/.test(r.text) && /Annex B/.test(r.text) && !/Annex A/.test(r.text), 'pages reordered and the deleted page is gone');

    step('Compress');
    await openPdf('scanned.pdf');
    await more('Compress');
    await page.getByRole('button', { name: /Strong/ }).click();
    const cn = await notice(/smaller/);
    const small = await saved();
    check(small.length < readFileSync(file('scanned.pdf')).length, `compressed file is smaller (${cn})`);

    step('Make text searchable (OCR)');
    await openPdf('scanned.pdf');
    await more('Make text searchable');
    await notice(/Found \d+ words/);
    r = await textOf(await saved());
    check(/RECEIPT/i.test(r.text) && /Kamara/i.test(r.text), 'recognised text is now in the PDF');

    step('Fill in a form');
    await openPdf('form.pdf');
    await more('Fill in a form');
    await page.getByLabel('Full name').fill('Aminata Kamara');
    await page.getByLabel('Agree').check();
    await page.getByRole('button', { name: 'Fill in', exact: true }).click();
    await notice(/Form filled in/);
    const filled = (await PDFDocument.load(await saved())).getForm();
    check(filled.getTextField('Full name').getText() === 'Aminata Kamara' && filled.getCheckBox('Agree').isChecked(), 'form values are saved in the PDF');

    step('Protect with a password, then open it again');
    await openPdf('agreement.pdf');
    await more('Protect');
    await page.getByLabel('Password (at least 6 characters)').fill('secret123');
    await page.getByLabel('Type it again').fill('secret123');
    await page.getByRole('button', { name: 'Protect', exact: true }).click();
    await page.locator('.ready', { hasText: 'agreement-protected.pdf' }).waitFor();
    const dl = page.waitForEvent('download');
    await page.locator('.ready').getByRole('button', { name: 'Save' }).click();
    const protectedBytes = readFileSync(await (await dl).path());
    check((await SecureDocument.load(protectedBytes, { ignoreEncryption: true })).isEncrypted, 'saved copy is encrypted');
    writeFileSync(file('protected.pdf'), protectedBytes);
    await page.goto(ORIGIN);
    await input('application/pdf,.pdf').setInputFiles(file('protected.pdf'));
    await page.getByRole('dialog', { name: 'This PDF is password-protected' }).waitFor();
    await page.getByLabel('Password', { exact: true }).fill('wrong-one');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.locator('.error', { hasText: 'not correct' }).waitFor();
    ok('a wrong password is refused');
    await page.getByLabel('Password', { exact: true }).fill('secret123');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await notice(/Unlocked copy/);
    r = await textOf(await saved());
    check(/TENANCY/.test(r.text), 'unlocked copy opens and keeps its text');

    step('Convert (stubbed rokelapdf.com)');
    await more('Export PDF');
    await page.getByRole('button', { name: 'To Excel' }).click();
    await page.locator('.ready', { hasText: '.xlsx is ready' }).waitFor();
    await more('Export PDF');
    await page.getByRole('button', { name: 'To PowerPoint' }).click();
    await page.locator('.ready', { hasText: '.pptx is ready' }).waitFor();
    check(converted.includes('/api/v1/convert/xlsx') && converted.includes('/api/v1/convert/pptx'), 'PDF → Excel and PowerPoint go through the converter');

    step('Receipts and the sales ledger');
    await page.goto(ORIGIN);
    await page.locator('.tool-grid').getByRole('button', { name: 'Receipts & invoices', exact: true }).click();
    const bizSheet = page.getByRole('dialog', { name: 'Your business' });
    await bizSheet.getByLabel('Business name').fill('Kamara & Sons Hardware');
    await bizSheet.getByLabel('Phone numbers').fill('+232 76 123 456');
    await bizSheet.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('radio', { name: 'Invoice', exact: true }).click();
    await page.getByLabel('Bill to').fill('Sunrise Construction Ltd');
    await page.getByLabel('Item 1', { exact: true }).fill('Cement, 50 kg bag');
    await page.getByLabel('Quantity 1').fill('10');
    await page.getByLabel('Price 1').fill('155');
    let rdl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const invoice = await textOf(new Uint8Array(readFileSync(await (await rdl).path())));
    check(
      invoice.text.includes('Kamara & Sons Hardware') && invoice.text.includes('INV-0001') && invoice.text.includes('1,550.00'),
      'an invoice is made on the phone in the website’s layout',
    );
    await page.getByRole('radio', { name: 'Sales ledger' }).click();
    await page.getByRole('button', { name: 'Record payment' }).click();
    check((await page.getByLabel('Payment for invoice').inputValue()) === 'INV-0001', 'Record payment opens a receipt for that invoice');
    await page.getByLabel('Price 1').fill('550');
    rdl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const receipt = await textOf(new Uint8Array(readFileSync(await (await rdl).path())));
    check(receipt.text.includes('Payment for invoice INV-0001') && receipt.text.includes('550.00'), 'the payment receipt is made');
    await page.getByRole('radio', { name: 'Sales ledger' }).click();
    await page.getByText('Owes 1,000.00').waitFor();
    rdl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Statement' }).click();
    const st = await textOf(new Uint8Array(readFileSync(await (await rdl).path())));
    check(st.text.includes('Statement of account') && st.text.includes('NLe 1,000.00'), 'the ledger shows 1,000.00 owed, and the statement says so');
    await page.getByRole('radio', { name: 'New document' }).click();
    await page.getByLabel('Paper').selectOption('58mm');
    await page.getByLabel('Item 1', { exact: true }).fill('Rice, 25 kg');
    await page.getByLabel('Price 1').fill('480');
    rdl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const slipBytes = new Uint8Array(readFileSync(await (await rdl).path()));
    const slipWidth = (await PDFDocument.load(slipBytes)).getPage(0).getWidth();
    check(Math.round((slipWidth * 25.4) / 72) === 58, 'a 58 mm till slip is made at the width of the roll');

    // The check QR code: registered on (stubbed) rokelapdf.com, printed with its code, the file's digest recorded.
    const checks = [];
    await ctx.route('https://www.rokelapdf.com/api/v1/me/receipt-checks**', async (r) => {
      const body = r.request().postDataJSON();
      checks.push({ path: new URL(r.request().url()).pathname, body });
      if (r.request().url().endsWith('/digest')) return r.fulfill({ json: { id: 'rck_1', code: 'ABCDEFGHJKMNPQRS', url: 'x', sha256: body.sha256 } });
      r.fulfill({ status: 201, json: { id: 'rck_1', code: 'ABCDEFGHJKMNPQRS', url: 'https://www.rokelapdf.com/receipts/ABCDEFGHJKMNPQRS', sha256: null } });
    });
    await page.getByRole('button', { name: /More options/ }).click();
    await page.getByLabel('QR code to check it').check();
    rdl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const checked = await textOf(new Uint8Array(readFileSync(await (await rdl).path())));
    check(
      checked.text.includes('ABCD EFGH JKMN PQRS') &&
        checks[0]?.body.business_name === 'Kamara & Sons Hardware' &&
        /^[0-9a-f]{64}$/.test(checks[1]?.body.sha256 ?? ''),
      'with the check QR code ticked, the receipt is registered, printed with its code, and its fingerprint recorded',
    );
    await page.evaluate(() => localStorage.removeItem('rokela-auth'));
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Item 1', { exact: true }).fill('Sugar, 1 bag');
    await page.getByLabel('Price 1').fill('90');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const signSheet = page.getByRole('dialog', { name: 'Sign in for the check QR code' });
    await signSheet.waitFor();
    await signSheet.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    check(
      (await page.getByLabel('Item 1', { exact: true }).inputValue()) === 'Sugar, 1 bag',
      'signed out, it asks to sign in, and the draft is kept while signing in',
    );
    await page.getByRole('button', { name: /More options/ }).click();
    await page.getByLabel('QR code to check it').uncheck();

    step('Pro tools (src/lib/licensing.ts)');
    site.launched = '2026-01-01T00:00:00.000Z';
    site.access = { access: 'none', until: null, reason: 'trial_ended' };
    await openPdf('agreement.pdf');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const pro = page.getByRole('dialog', { name: 'Editing is a Pro tool' });
    await pro.waitFor();
    if (process.env.VITE_DISTRIBUTION === 'play') {
      // The Google Play build (docs/google-play.md) says a licence is needed, never how to buy one.
      check(
        (await pro.getByText('need a Pro licence').isVisible()) && (await pro.getByRole('link').count()) === 0,
        'after the free month, Edit says a licence is needed, with no way to buy',
      );
      check(!(await pro.textContent()).includes('@'), 'and gives no email address');
    } else {
      check(await pro.getByRole('link', { name: 'Get a licence' }).isVisible(), 'after the free month, Edit asks for a licence');
    }
    await pro.getByRole('button', { name: 'Not now' }).click();
    check((await page.locator('.edit-layer').count()) === 0, 'and does not open');
    await more('Compress');
    await page.getByRole('dialog', { name: 'Compress PDF' }).waitFor();
    ok('free tools still open');
    await page.locator('.scrim').click({ position: { x: 20, y: 40 } });
    await page.goto(ORIGIN);
    await input('application/pdf,.pdf', true).setInputFiles([file('agreement.pdf'), file('annex.pdf')]);
    await page.getByRole('dialog', { name: 'Merging is a Pro tool' }).waitFor();
    ok('combining is merging, so it asks too');

    await page.goto(ORIGIN);
    await page.locator('.tool-grid').getByRole('button', { name: 'Receipts & invoices', exact: true }).click();
    await page.getByLabel('Item 1', { exact: true }).fill('Nails, 1 kg');
    await page.getByLabel('Price 1').fill('40');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('dialog', { name: 'Receipt Maker is a Pro tool' }).waitFor();
    ok('after the free month, making a receipt asks for a licence');

    const inMonth = new Date(Date.now() + 10 * 86400000).toISOString();
    site.access = { access: 'trial', until: inMonth };
    await openPdf('agreement.pdf');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.edit-layer').first().waitFor();
    ok('in the free month, Edit opens');
    await page.getByRole('button', { name: 'Cancel' }).click();

    site.offline = true;
    await openPdf('agreement.pdf');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.edit-layer').first().waitFor();
    ok('offline, the last answer still lets Edit open until its date');
    await page.getByRole('button', { name: 'Cancel' }).click();
    site.offline = false;

    await openPdf('agreement.pdf');
    await page.evaluate(() => localStorage.removeItem('rokela-auth'));
    await page.getByRole('button', { name: 'Fill & Sign', exact: true }).click();
    const signin = page.getByRole('dialog', { name: 'Signing is a Pro tool' });
    await signin.waitFor();
    check(await signin.getByRole('button', { name: 'Sign in' }).isVisible(), 'signed out, a Pro tool offers to sign in');
    site.launched = null;

    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
    await browser.close();
    console.log('\nMobile smoke test passed.');
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
