import jsQRModule from 'jsqr';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { stampVerification } from '@/lib/tools/ops';

const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as (
  data: Uint8ClampedArray,
  w: number,
  h: number,
) => { data: string; location: { topLeftCorner: { x: number; y: number } } } | null;

const URL_ = 'https://www.rokelapdf.com/v/ABCDEFGHIJKLMNOPQRST';

/** Pages covering every rotation, landscape and an offset crop box, each shaded so the stamp must stand out. */
async function fixture() {
  const d = await PDFDocument.create();
  const specs: Array<{ size: [number, number]; rotate: number; crop?: [number, number, number, number] }> = [
    { size: [595, 842], rotate: 0 },
    { size: [595, 842], rotate: 90 },
    { size: [595, 842], rotate: 180 },
    { size: [612, 792], rotate: 270 },
    { size: [842, 595], rotate: 0 },
    { size: [700, 900], rotate: 0, crop: [50, 80, 600, 780] },
  ];
  for (const s of specs) {
    const p = d.addPage(s.size);
    p.drawRectangle({ x: 0, y: 0, width: s.size[0], height: s.size[1], color: rgb(0.55, 0.55, 0.55) });
    p.setRotation(degrees(s.rotate));
    if (s.crop) p.setCropBox(...s.crop);
  }
  return d.save();
}

/** Renders a page as displayed (pdf.js applies rotation and crop box) and decodes any QR code in it. */
async function scan(bytes: Uint8Array) {
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const out: Array<{ text: string | undefined; bottomRight: boolean; label: boolean }> = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
    const text = (await page.getTextContent()).items.map((t) => ('str' in t ? t.str : '')).join(' ');
    out.push({
      text: found?.data,
      bottomRight: !!found && found.location.topLeftCorner.x > img.width / 2 && found.location.topLeftCorner.y > img.height / 2,
      label: text.includes('Verify at www.rokelapdf.com/v/ABCDEFGHIJKLMNOPQRST'),
    });
  }
  return out;
}

describe('verified document stamping', () => {
  it('puts a scannable QR code and the verify line at the bottom right of every page, upright on any rotation', async () => {
    const stamped = await stampVerification(await fixture(), URL_);
    const pages = await scan(stamped);
    expect(pages).toHaveLength(6);
    for (const [i, p] of pages.entries()) expect(p, `page ${i + 1}`).toEqual({ text: URL_, bottomRight: true, label: true });
    expect((await PDFDocument.load(stamped)).getPageCount()).toBe(6);
  });

  it('refuses addresses that are not plain http(s) URLs and unreadable files', async () => {
    const pdf = await fixture();
    for (const bad of ['javascript:alert(1)', 'https://a b', `https://x/${'y'.repeat(200)}`])
      await expect(stampVerification(pdf, bad)).rejects.toThrow(/verification address/);
    await expect(stampVerification(new TextEncoder().encode('not a pdf'), URL_)).rejects.toThrow();
  });
});
