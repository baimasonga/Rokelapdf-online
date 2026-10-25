// Step 1 of the adverts (npm run ads): drives the real app build (vite preview of dist/) through each feature on
// sample documents and screenshots it at 390x844 @3x into ads-out/screens/, with the tap targets in taps.json.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'ads-out', 'screens');
mkdirSync(out, { recursive: true });
const PORT = 4191;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const taps = {};

const navy = rgb(0.06, 0.12, 0.24);
const grey = rgb(0.35, 0.4, 0.48);

async function agreement() {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const b = await d.embedFont(StandardFonts.HelveticaBold);
  const pages = [];
  for (let n = 0; n < 3; n++) pages.push(d.addPage([595, 842]));
  const p = pages[0];
  p.drawRectangle({ x: 0, y: 800, width: 595, height: 42, color: navy });
  p.drawText('FREETOWN HOMES LTD', { x: 50, y: 815, size: 12, font: b, color: rgb(1, 1, 1) });
  p.drawText('TENANCY AGREEMENT', { x: 50, y: 740, size: 26, font: b, color: navy });
  p.drawText('Agreement no. FH-2026-0418', { x: 50, y: 716, size: 12, font: f, color: grey });
  const body = [
    ['Landlord:', 'Freetown Homes Ltd, 12 Wilkinson Road'],
    ['Tenant:', 'Aminata Kamara'],
    ['Property:', 'Flat 3, 45 Spur Road, Freetown'],
    ['Rent:', 'Le 4,500 per month, paid in advance'],
    ['Term:', '12 months from 1 November 2026'],
  ];
  body.forEach(([k, v], i) => {
    p.drawText(k, { x: 50, y: 660 - i * 30, size: 14, font: b, color: navy });
    p.drawText(v, { x: 140, y: 660 - i * 30, size: 14, font: f, color: navy });
  });
  const clauses = [
    '1. The tenant pays the rent on or before the first day of each month.',
    '2. The landlord keeps the roof, walls and plumbing in good repair.',
    '3. The tenant keeps the flat clean and reports any damage promptly.',
    '4. Either party may end this agreement with two months notice.',
  ];
  clauses.forEach((c, i) => p.drawText(c, { x: 50, y: 470 - i * 28, size: 13, font: f, color: navy }));
  p.drawText('Signed', { x: 50, y: 250, size: 14, font: b, color: navy });
  p.drawLine({ start: { x: 50, y: 170 }, end: { x: 260, y: 170 }, thickness: 1, color: grey });
  p.drawLine({ start: { x: 330, y: 170 }, end: { x: 545, y: 170 }, thickness: 1, color: grey });
  p.drawText('Landlord', { x: 50, y: 150, size: 12, font: f, color: grey });
  p.drawText('Tenant', { x: 330, y: 150, size: 12, font: f, color: grey });
  pages.slice(1).forEach((q, i) => {
    q.drawText(i === 0 ? 'SCHEDULE A: INVENTORY' : 'SCHEDULE B: HOUSE RULES', { x: 50, y: 760, size: 22, font: b, color: navy });
    for (let l = 0; l < 14; l++) q.drawRectangle({ x: 50, y: 700 - l * 36, width: 300 + ((l * 53) % 180), height: 10, color: rgb(0.85, 0.87, 0.9) });
  });
  return d.save();
}

async function simple(title, lines) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const b = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([595, 842]);
  p.drawText(title, { x: 50, y: 760, size: 24, font: b, color: navy });
  lines.forEach((l, i) => p.drawText(l, { x: 50, y: 700 - i * 28, size: 14, font: f, color: navy }));
  return d.save();
}

async function main() {
  const fx = join(root, 'ads-out', 'fixtures');
  mkdirSync(fx, { recursive: true });
  writeFileSync(join(fx, 'Tenancy agreement.pdf'), await agreement());
  writeFileSync(join(fx, 'School fees invoice.pdf'), await simple('INVOICE', ['Term 1 school fees', 'Amount due: Le 1,200', 'Due: 15 November 2026']));
  writeFileSync(join(fx, 'Payment receipt.pdf'), await simple('RECEIPT OF PAYMENT', ['Received from Aminata Kamara', 'Le 4,500 for rent, November 2026']));

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
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
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  const KEEP_MESSAGE = ['08-signed'];
  const shot = async (name, settle = 600) => {
    if (!KEEP_MESSAGE.includes(name)) for (const b of await page.locator('.snack-close').all()) await b.click().catch(() => {});
    // The browser-preview note does not exist in the Android app.
    await page.addStyleTag({ content: '.note { display: none !important; }' });
    await page.waitForTimeout(settle);
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log('shot', name);
  };
  const tap = async (name, locator) => {
    const b = await locator.boundingBox();
    taps[name] = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const pdfInput = page.locator('input[type=file][accept="application/pdf,.pdf"]:not([multiple])').first();
  // Recent files live in memory in a browser, so stay on one page load and go Back to home between files.
  const home = async () => {
    while ((await page.locator('.fab').count()) === 0) {
      await page.locator('.appbar .icon-btn').first().click();
      await page.waitForTimeout(300);
    }
  };
  await page.goto(ORIGIN);
  const open = async (name) => {
    await home();
    await pdfInput.setInputFiles(join(fx, name));
    await page.waitForSelector('.page canvas[width]');
  };

  // Recent files, newest last so the agreement sits on top.
  for (const n of ['Payment receipt.pdf', 'School fees invoice.pdf', 'Tenancy agreement.pdf']) await open(n);
  await home();
  await page.waitForSelector('.list');
  await tap('home_fab', page.locator('.fab'));
  await tap('home_edit', page.locator('.tool-grid').getByRole('button', { name: 'Edit PDF', exact: true }));
  await tap('home_recent', page.locator('.list .row-main').first());
  await shot('01-home');

  await page.locator('.list .row-main').first().click();
  await page.waitForSelector('.page canvas[width]');
  await tap('view_edit', page.locator('.bottombar').getByRole('button', { name: 'Edit', exact: true }));
  await tap('view_sign', page.locator('.bottombar').getByRole('button', { name: 'Fill & Sign', exact: true }));
  await tap('view_organize', page.locator('.bottombar').getByRole('button', { name: 'Organize', exact: true }));
  await tap('view_all', page.locator('.bottombar').getByRole('button', { name: 'All tools', exact: true }));
  await shot('02-viewer', 1200);

  // Edit: highlight the rent line, add a note.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const layer = page.locator('.edit-layer').first();
  const box = await layer.boundingBox();
  const at = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  await page.getByRole('radio', { name: 'Highlight' }).click();
  const h1 = at(0.07, 0.278),
    h2 = at(0.62, 0.301);
  await page.mouse.move(h1.x, h1.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(h1.x + ((h2.x - h1.x) * i) / 10, h1.y + ((h2.y - h1.y) * i) / 10);
  await page.mouse.up();
  taps.edit_highlight_from = h1;
  taps.edit_highlight_to = h2;
  await shot('03-edit-highlight');
  await page.getByRole('radio', { name: 'Text' }).click();
  const t = at(0.66, 0.31);
  taps.edit_text = t;
  await page.mouse.click(t.x, t.y);
  await page.getByLabel('Text', { exact: true }).fill('Paid in full');
  await shot('04-edit-textsheet');
  await page.getByRole('dialog', { name: 'Add text' }).getByRole('button', { name: 'Done' }).click();
  await shot('05-edit-done');
  await tap('edit_done', page.locator('.appbar .text-btn'));
  await page.locator('.appbar .text-btn').click();
  await page.waitForSelector('.page canvas[width]');
  await page.waitForTimeout(2000);

  // Fill & Sign: typed signature, placed on the tenant line.
  await page.getByRole('button', { name: 'Fill & Sign', exact: true }).click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByLabel('Your name').fill('Aminata Kamara');
  await page.waitForTimeout(400);
  await shot('06-sign-pad');
  await tap('sign_use', page.getByRole('button', { name: 'Use signature' }));
  await page.getByRole('button', { name: 'Use signature' }).click();
  const box2 = await page.locator('.sign-layer').first().boundingBox();
  const s = { x: box2.x + box2.width * 0.74, y: box2.y + box2.height * 0.765 };
  taps.sign_place = s;
  await page.mouse.click(s.x, s.y);
  await shot('07-sign-placed');
  await page.locator('.appbar .text-btn').click();
  await page.waitForSelector('.page canvas[width]');
  await page.waitForTimeout(1500);
  await shot('08-signed', 400);

  // Organize: select page 2.
  await page.getByRole('button', { name: 'Organize', exact: true }).click();
  await page.locator('.thumb canvas').first().waitFor();
  await page.waitForTimeout(1200);
  await tap('org_page2', page.getByRole('button', { name: 'Page 2', exact: true }));
  await shot('09a-organize');
  await page.getByRole('button', { name: 'Page 2', exact: true }).click();
  await tap('org_rotate', page.locator('.bottombar').getByRole('button', { name: 'Rotate', exact: true }));
  await shot('09-organize-selected');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(600);

  // All tools, Export, Compress, Protect.
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'All tools' });
  await dlg.waitFor();
  await tap('all_export', dlg.getByRole('button', { name: 'Export PDF', exact: true }));
  await tap('all_compress', dlg.getByRole('button', { name: 'Compress', exact: true }));
  await shot('11-all-tools');
  await dlg.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await page.getByRole('dialog', { name: 'Export PDF' }).waitFor();
  await shot('12-export');
  await page.locator('.scrim').click({ position: { x: 20, y: 40 } });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('dialog', { name: 'All tools' }).getByRole('button', { name: 'Compress', exact: true }).click();
  await page.getByRole('dialog', { name: 'Compress PDF' }).waitFor();
  await shot('13-compress');
  await page.locator('.scrim').click({ position: { x: 20, y: 40 } });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('dialog', { name: 'All tools' }).getByRole('button', { name: 'Protect', exact: true }).click();
  await page.getByRole('dialog', { name: 'Protect with a password' }).waitFor();
  await page.getByLabel('Password (at least 6 characters)').fill('secret123');
  await page.getByLabel('Type it again').fill('secret123');
  await shot('14-protect');

  // Large system text (Android font size 130%): every font size grows, layout sizes do not.
  await page.locator('.scrim').click({ position: { x: 20, y: 40 } });
  await page.waitForTimeout(400);
  await home();
  await page.waitForSelector('.list');
  await page.evaluate(() => {
    for (const sheet of document.styleSheets)
      for (const r of sheet.cssRules) if (r.style?.fontSize?.endsWith('px')) r.style.fontSize = parseFloat(r.style.fontSize) * 1.3 + 'px';
    document.body.style.fontSize = 16 * 1.3 + 'px';
  });
  await shot('15-home-large-text');
  await page.locator('.list .row-main').first().click();
  await page.waitForSelector('.page canvas[width]');
  await page.getByRole('button', { name: 'Organize', exact: true }).click();
  await page.locator('.thumb canvas').first().waitFor();
  await shot('16-organize-large-text', 1200);

  writeFileSync(join(out, 'taps.json'), JSON.stringify(taps, null, 2));
  await browser.close();
  server.kill();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
