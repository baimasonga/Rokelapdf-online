import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { buildPdf } from '@/lib/editor/export';
import { appendPages, upsertAnnot } from '@/lib/editor/model';
import { cleanDesign, INKS, newStamp, stampDate, stampNumber, TEMPLATES } from '@/lib/stamp/design';
import { inkify, rng } from '@/lib/stamp/ink';
import { png } from './png';

/** A flat stamp: a filled square with a transparent border, the way render.ts draws one before inking it. */
function flat(w = 120, h = 80) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = 35;
      px[i + 1] = 54;
      px[i + 2] = 168;
      px[i + 3] = x >= 10 && x < w - 10 && y >= 10 && y < h - 10 ? 255 : 0;
    }
  return px;
}
const alphas = (px: Uint8ClampedArray) => px.filter((_, i) => i % 4 === 3);

describe('stamp ink', () => {
  it('adds reproducible rough edges without changing the default impression', () => {
    const pixels = flat(100, 100);
    const original = new Uint8ClampedArray(pixels);
    const explicitDefault = new Uint8ClampedArray(pixels);
    const rough = new Uint8ClampedArray(pixels);
    inkify(original, 100, 100, { seed: 12, wear: 0.5 });
    inkify(explicitDefault, 100, 100, { seed: 12, wear: 0.5, edgeWear: 0 });
    inkify(rough, 100, 100, { seed: 12, wear: 0.5, edgeWear: 1 });
    expect(explicitDefault).toEqual(original);
    expect(rough).not.toEqual(original);
    for (let i = 3; i < rough.length; i += 4) expect(rough[i]).toBeLessThanOrEqual(pixels[i]!);
  });
  it('is the same for the same seed and different for another, like separate impressions', () => {
    const a = flat();
    const b = flat();
    const c = flat();
    inkify(a, 120, 80, { seed: 7, wear: 0.6 });
    inkify(b, 120, 80, { seed: 7, wear: 0.6 });
    inkify(c, 120, 80, { seed: 8, wear: 0.6 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('only ever lightens: paper stays clear and no pixel gets more ink than the design', () => {
    const before = flat();
    const after = flat();
    inkify(after, 120, 80, { seed: 3, wear: 1 });
    const a0 = alphas(before);
    const a1 = alphas(after);
    a0.forEach((v, i) => expect(a1[i]!).toBeLessThanOrEqual(v));
    expect(a1.filter((v, i) => a0[i] === 0 && v > 0)).toHaveLength(0);
    // Colour is untouched: the ink keeps its hue.
    expect(after.filter((_, i) => i % 4 === 2).every((v) => v === 168)).toBe(true);
  });

  it('looks worn when used a lot and nearly solid when clean', () => {
    const design = alphas(flat());
    const mean = (wear: number) => {
      const px = flat();
      inkify(px, 120, 80, { seed: 11, wear });
      const inside = alphas(px).filter((_, i) => design[i] === 255);
      return inside.reduce((s, v) => s + v, 0) / inside.length;
    };
    expect(mean(0)).toBeGreaterThan(240);
    expect(mean(1)).toBeLessThan(mean(0.3));
  });

  it('rng is seeded and stays in [0, 1)', () => {
    const r = rng(42);
    const xs = Array.from({ length: 1000 }, r);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(rng(42)()).toBe(xs[0]);
  });
});

describe('stamp designs', () => {
  it('offers two extra blue inks and preserves optional edge roughness', () => {
    expect(INKS.map((ink) => ink.name)).toEqual(expect.arrayContaining(['Blue', 'Navy blue', 'Sky blue']));
    expect(cleanDesign({ id: 'rough', shape: 'round', edgeWear: 0.8 })?.edgeWear).toBe(0.8);
    expect(cleanDesign({ id: 'old', shape: 'round' })?.edgeWear).toBeUndefined();
  });
  it('prints dates and numbers the way office stamps do', () => {
    expect(stampDate(new Date(2026, 9, 6))).toBe('06 OCT 2026');
    expect(stampNumber(124)).toBe('No. 000124');
  });

  it('every template makes a usable stamp', () => {
    for (const t of TEMPLATES) {
      const d = newStamp(t.design);
      expect(cleanDesign(d)).toEqual(d);
    }
  });

  it('repairs or refuses a damaged saved stamp', () => {
    expect(cleanDesign({ id: 'x', shape: 'triangle' })).toBeUndefined();
    expect(cleanDesign(null)).toBeUndefined();
    const d = cleanDesign({ id: 'x', shape: 'rect', ink: 'red', top: 'A'.repeat(500), sizeMm: 9000, wear: -2, next: 'x' })!;
    expect(d.ink).toMatch(/^#[0-9a-f]{6}$/i);
    expect(d.top).toHaveLength(60);
    expect(d.sizeMm).toBe(120);
    expect(d.wear).toBe(0);
    expect(d.next).toBe(1);
  });
});

describe('stamps in the exported PDF', () => {
  it('blend into the page (multiply), so the text underneath shows through the ink', async () => {
    const src = await (async () => {
      const d = await PDFDocument.create();
      d.addPage([400, 600]);
      return d.save();
    })();
    const s = appendPages({ pages: [], annots: {} }, 0, 1);
    const stamp = `data:image/png;base64,${Buffer.from(png(40, 40)).toString('base64')}`;
    const out = await buildPdf(
      [src],
      upsertAnnot(s, s.pages[0]!.id, { id: 'st', kind: 'image', x: 0.5, y: 0.5, w: 0.2, h: 0.1, src: stamp, rot: 0, color: '#000000', blend: 'multiply' }),
    );
    const res = (await PDFDocument.load(out)).getPage(0).node.Resources()!;
    const gs = res.lookup(PDFName.of('ExtGState'), PDFDict);
    expect(gs.keys().map((k) => String(gs.lookup(k, PDFDict).get(PDFName.of('BM'))))).toContain('/Multiply');
  });
});
