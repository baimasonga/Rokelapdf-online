import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { seamStampDocument, stampDocument } from '@/lib/stamp/batch';
import type { Impression } from '@/lib/stamp/render';
import { png } from './png';

// "Stamp many PDFs" (src/lib/stamp/batch.ts): the same stamp in the same place on the chosen pages of each file.

const dataUrl = `data:image/png;base64,${Buffer.from(png(40, 20)).toString('base64')}`;
/** A 113 pt (40 mm) wide, 2:1 stamp. */
const impression = (): Impression => ({ src: dataUrl, aspect: 2, widthPt: 113.4 });

async function threePages(rotateSecond = false) {
  const d = await PDFDocument.create();
  for (let i = 0; i < 3; i++) d.addPage([595.28, 841.89]);
  if (rotateSecond) d.getPage(1).setRotation(degrees(90));
  return d.save();
}

/** Where pdf.js draws each image on each page, as shown: [x, y, width, height] in points from the top-left. */
async function stampsShown(bytes: Uint8Array) {
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const out: Array<Array<[number, number, number, number]>> = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const boxes: Array<[number, number, number, number]> = [];
    // Track the current transformation through save/restore to find each image's unit square on the shown page.
    let m = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    const mul = (a: number[], b: number[]) => [
      a[0]! * b[0]! + a[2]! * b[1]!,
      a[1]! * b[0]! + a[3]! * b[1]!,
      a[0]! * b[2]! + a[2]! * b[3]!,
      a[1]! * b[2]! + a[3]! * b[3]!,
      a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
      a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
    ];
    ops.fnArray.forEach((fn, i) => {
      if (fn === OPS.save) stack.push(m);
      else if (fn === OPS.restore) m = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) m = mul(m, ops.argsArray[i] as number[]);
      else if (fn === OPS.paintImageXObject) {
        const corners = [
          [0, 0],
          [1, 1],
        ].map(([x, y]) => vp.convertToViewportPoint(m[0]! * x! + m[2]! * y! + m[4]!, m[1]! * x! + m[3]! * y! + m[5]!));
        const [[x1, y1], [x2, y2]] = corners as [[number, number], [number, number]];
        boxes.push([Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)]);
      }
    });
    out.push(boxes);
  }
  return out;
}

describe('stamping many PDFs', () => {
  it('stamps only the first, only the last, or every page, a fresh impression each time', async () => {
    const calls: number[] = [];
    const impress = (i: number) => (calls.push(i), impression());
    const first = await stampsShown(await stampDocument(await threePages(), { place: 'bottom-right', pages: 'first', marginMm: 15 }, impress));
    expect(first.map((p) => p.length)).toEqual([1, 0, 0]);
    const last = await stampsShown(await stampDocument(await threePages(), { place: 'bottom-right', pages: 'last', marginMm: 15 }, impress));
    expect(last.map((p) => p.length)).toEqual([0, 0, 1]);
    calls.length = 0;
    const all = await stampsShown(await stampDocument(await threePages(), { place: 'bottom-right', pages: 'all', marginMm: 15 }, impress));
    expect(all.map((p) => p.length)).toEqual([1, 1, 1]);
    expect(calls).toEqual([0, 1, 2]);
  });

  it('puts the stamp at its size, the margin from the chosen edges, upright on rotated pages too', async () => {
    const m = 15 * (72 / 25.4);
    for (const [place, at] of [
      ['bottom-right', (W: number, H: number) => [W - m - 113.4, H - m - 56.7]],
      ['top-left', () => [m, m]],
      ['center', (W: number, H: number) => [(W - 113.4) / 2, (H - 56.7) / 2]],
    ] as const) {
      const pages = await stampsShown(await stampDocument(await threePages(true), { place, pages: 'all', marginMm: 15 }, impression));
      pages.forEach(([box], i) => {
        // Page 2 is turned a quarter: shown landscape.
        const [W, H] = i === 1 ? [841.89, 595.28] : [595.28, 841.89];
        const [x, y] = at(W, H);
        expect(box![0], `${place} page ${i + 1} x`).toBeCloseTo(x, 0);
        expect(box![1], `${place} page ${i + 1} y`).toBeCloseTo(y, 0);
        expect(box![2], `${place} page ${i + 1} width`).toBeCloseTo(113.4, 0);
        expect(box![3], `${place} page ${i + 1} height`).toBeCloseTo(56.7, 0);
      });
    }
  });

  it('keeps a stamp bigger than the page on the page', async () => {
    const d = await PDFDocument.create();
    d.addPage([100, 100]);
    const [[box]] = await stampsShown(await stampDocument(await d.save(), { place: 'bottom-right', pages: 'all', marginMm: 30 }, impression));
    expect(box![0]).toBeGreaterThanOrEqual(0);
    expect(box![0] + box![2]).toBeLessThanOrEqual(100.5);
  });
});

describe('the seam stamp', () => {
  /** A 2:1, 113 pt wide seal cut into n strips. */
  const strips = async (n: number): Promise<Impression[]> => Array.from({ length: n }, () => ({ src: dataUrl, aspect: 113.4 / n / 56.7, widthPt: 113.4 / n }));

  it('puts one strip on each page, flush with the right edge, at the same height, upright on rotated pages', async () => {
    const pages = await stampsShown(await seamStampDocument(await threePages(true), 0.5, strips));
    pages.forEach(([box, extra], i) => {
      const [W, H] = i === 1 ? [841.89, 595.28] : [595.28, 841.89];
      expect(extra, `page ${i + 1}: one strip`).toBeUndefined();
      expect(box![0] + box![2], `page ${i + 1} right edge`).toBeCloseTo(W, 0);
      expect(box![2], `page ${i + 1} strip width`).toBeCloseTo(113.4 / 3, 0);
      expect(box![1], `page ${i + 1} height on the page`).toBeCloseTo((H - 56.7) / 2, 0);
    });
  });

  it('needs at least two pages', async () => {
    const d = await PDFDocument.create();
    d.addPage();
    await expect(seamStampDocument(await d.save(), 0.5, strips)).rejects.toThrow(/two pages/);
  });
});
