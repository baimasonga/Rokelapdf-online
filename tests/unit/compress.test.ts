import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { compressPdf, type ImageRecoder, type RecodeInput } from '@/lib/tools/ops';

/** A JPEG that pdf-lib accepts: SOI, a baseline SOF0 header with the size, filler, EOI. */
function jpeg(w: number, h: number, components = 3, filler = 20_000) {
  const sof = [0xff, 0xc0, 0x00, 8 + components * 3, 8, h >> 8, h & 255, w >> 8, w & 255, components];
  for (let i = 0; i < components; i++) sof.push(i + 1, 0x11, 0);
  return new Uint8Array([0xff, 0xd8, ...sof, ...randomBytes(filler), 0xff, 0xd9]);
}

/** A test PDF: text, an RGB JPEG photo, a CMYK JPEG and a raw RGB (Flate) image. */
async function sample() {
  const d = await PDFDocument.create();
  const page = d.addPage([600, 800]);
  page.drawText('Quarterly report', { x: 50, y: 750, size: 20, font: await d.embedFont(StandardFonts.Helvetica) });
  page.drawImage(await d.embedJpg(jpeg(3000, 2000)), { x: 50, y: 400, width: 300, height: 200 });
  page.drawImage(await d.embedJpg(jpeg(800, 600, 4)), { x: 50, y: 100, width: 160, height: 120 });
  const raw = d.context.stream(deflateSync(randomBytes(200 * 100 * 3)), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 200,
    Height: 100,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'FlateDecode',
  });
  d.context.register(raw);
  // CMYK JPEG without a Decode array (as many scanners write them): must be left alone.
  d.context.register(
    d.context.stream(jpeg(900, 700, 4), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 900,
      Height: 700,
      ColorSpace: 'DeviceCMYK',
      BitsPerComponent: 8,
      Filter: 'DCTDecode',
    }),
  );
  return d.save();
}

function images(d: PDFDocument) {
  return d.context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
}

describe('compress PDF', () => {
  it('re-encodes photos smaller, keeps CMYK images and the text, and reports the saving', async () => {
    const seen: RecodeInput[] = [];
    const recode: ImageRecoder = async (img, o) => {
      seen.push(img);
      const k = Math.min(1, o.maxSide / Math.max(img.width, img.height));
      return {
        bytes: jpeg(Math.round(img.width * k), Math.round(img.height * k), 3, 500),
        width: Math.round(img.width * k),
        height: Math.round(img.height * k),
      };
    };
    const input = await sample();
    const r = await compressPdf(input, 'recommended', recode);
    expect(seen.map((s) => s.kind).sort()).toEqual(['jpeg', 'raw']);
    const rawIn = seen.find((s) => s.kind === 'raw')!;
    expect(rawIn.kind === 'raw' && rawIn.pixels.length).toBe(200 * 100 * 3);
    expect(r.images).toBe(2);
    expect(r.before).toBe(input.length);
    expect(r.after).toBe(r.bytes.length);
    expect(r.after).toBeLessThan(r.before * 0.6);

    const out = await PDFDocument.load(r.bytes);
    const dims = images(out).map((i) => [
      i.dict.get(PDFName.of('Width'))?.toString(),
      i.dict.get(PDFName.of('Height'))?.toString(),
      i.dict.get(PDFName.of('Filter'))?.toString(),
    ]);
    expect(dims).toContainEqual(['1600', '1067', '/DCTDecode']); // the 3000×2000 photo, scaled to the level's size
    expect(dims).toContainEqual(['800', '600', '/DCTDecode']); // CMYK kept as it was
    expect(images(out).some((i) => i.dict.get(PDFName.of('ColorSpace'))?.toString() === '/DeviceCMYK')).toBe(true);

    const doc = await getDocument({ data: r.bytes.slice(), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => (i as { str: string }).str).join('');
    expect(text).toBe('Quarterly report');
  });

  it('keeps the original when re-encoding would not make it smaller', async () => {
    const input = await sample();
    const r = await compressPdf(input, 'strong', async (img) => ({ bytes: jpeg(img.width, img.height, 3, 400_000), width: img.width, height: img.height }));
    expect(r.images).toBe(0);
    expect(r.after).toBeLessThanOrEqual(r.before);
    const noop = await compressPdf(input, 'light', async () => undefined);
    expect(noop.images).toBe(0);
  });

  it('passes the level’s size and quality to the encoder and rejects junk', async () => {
    const calls: Array<{ maxSide: number; quality: number }> = [];
    await compressPdf(await sample(), 'strong', async (_i, o) => (calls.push(o), undefined));
    expect(calls[0]).toEqual({ maxSide: 1000, quality: 0.5 });
    await expect(compressPdf(new TextEncoder().encode('nope'), 'light', async () => undefined)).rejects.toThrow(/not a readable PDF/);
  });
});
