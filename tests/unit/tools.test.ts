import { png } from './png';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  addBlankPages,
  addPageNumbers,
  addWatermark,
  cropPages,
  deletePages,
  extractPages,
  fillForm,
  flattenPdf,
  imagesToPdf,
  insertPdf,
  listFormFields,
  mergePdfs,
  pageLabel,
  parseRanges,
  reorderPages,
  rotatePages,
  splitPdf,
  organizePdf,
} from '@/lib/tools/ops';

const FONTS = `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`;

/** A PDF whose pages say "P1", "P2", … so page order can be checked by reading the text back. */
async function numbered(n: number, opts: { size?: [number, number]; rotate?: number; tag?: string } = {}) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = d.addPage(opts.size ?? [400, 600]);
    p.drawText(`${opts.tag ?? 'P'}${i}`, { x: 40, y: 500, size: 20, font: f });
    if (opts.rotate) p.setRotation(degrees(opts.rotate));
  }
  return d.save();
}

/** Text on each page as pdf.js reads it, plus where each run sits on the page as displayed (0–1). */
async function read(bytes: Uint8Array) {
  const doc = await getDocument({ data: bytes.slice(), standardFontDataUrl: FONTS }).promise;
  const pages: Array<{ text: string; runs: Array<{ str: string; u: number; v: number; angle: number }>; w: number; h: number }> = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const items = (await page.getTextContent()).items as Array<{ str: string; transform: number[] }>;
    pages.push({
      text: items.map((i) => i.str).join(' '),
      w: vp.width,
      h: vp.height,
      runs: items.map((it) => {
        const [a, b, , , e, f] = it.transform as [number, number, number, number, number, number];
        const [x, y] = vp.convertToViewportPoint(e, f);
        const [x2, y2] = vp.convertToViewportPoint(e + a, f + b);
        return { str: it.str, u: x / vp.width, v: y / vp.height, angle: Math.round((Math.atan2(-(y2 - y), x2 - x) * 180) / Math.PI) + 0 };
      }),
    });
  }
  return pages;
}
const texts = async (b: Uint8Array) => (await read(b)).map((p) => p.text.trim());

describe('page ranges', () => {
  it('parses lists, ranges and open-ended ranges into sorted unique indices', () => {
    expect(parseRanges('1-3, 5, 8-', 10)).toEqual([0, 1, 2, 4, 7, 8, 9]);
    expect(parseRanges('3,1,3', 5)).toEqual([0, 2]);
    expect(parseRanges('-2', 5)).toEqual([0, 1]);
  });
  it('explains mistakes in plain words', () => {
    expect(() => parseRanges('', 3)).toThrow(/Enter the pages/);
    expect(() => parseRanges('4', 3)).toThrow(/Page 4 does not exist; this PDF has 3 pages/);
    expect(() => parseRanges('3-1', 3)).toThrow(/goes backwards/);
    expect(() => parseRanges('a', 3)).toThrow(/not a page or range/);
  });
});

describe('organize tools', () => {
  it('merges files in order', async () => {
    const out = await mergePdfs([await numbered(2, { tag: 'A' }), await numbered(1, { tag: 'B' })]);
    expect(await texts(out)).toEqual(['A1', 'A2', 'B1']);
    await expect(mergePdfs([await numbered(1)])).rejects.toThrow(/at least two/);
  });

  it('splits by ranges, every N pages, or into single pages, with descriptive names', async () => {
    const src = await numbered(5);
    const byRanges = await splitPdf(src, { kind: 'ranges', spec: '1-2, 4-5' }, 'doc');
    expect(byRanges.map((f) => f.name)).toEqual(['doc-pages-1-2.pdf', 'doc-pages-4-5.pdf']);
    expect(await texts(byRanges[1]!.bytes)).toEqual(['P4', 'P5']);
    const every = await splitPdf(src, { kind: 'every', n: 2 });
    expect(every.length).toBe(3);
    expect(await texts(every[2]!.bytes)).toEqual(['P5']);
    expect((await splitPdf(src, { kind: 'each' })).length).toBe(5);
    await expect(splitPdf(src, { kind: 'ranges', spec: '1-5' })).rejects.toThrow(/same document/);
  });

  it('extracts and deletes pages, but never deletes every page', async () => {
    const src = await numbered(4);
    expect(await texts(await extractPages(src, '2,4'))).toEqual(['P2', 'P4']);
    expect(await texts(await deletePages(src, '1,3'))).toEqual(['P2', 'P4']);
    await expect(deletePages(src, '1-4')).rejects.toThrow(/every page/);
  });

  it('rotates selected pages on top of their existing rotation', async () => {
    const src = await numbered(3, { rotate: 90 });
    const out = await PDFDocument.load(await rotatePages(src, 270, '2-3'));
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([90, 0, 0]);
  });

  it('reorders pages and rejects incomplete orders', async () => {
    const src = await numbered(3);
    expect(await texts(await reorderPages(src, [2, 0, 1]))).toEqual(['P3', 'P1', 'P2']);
    await expect(reorderPages(src, [0, 0, 1])).rejects.toThrow(/incomplete/);
  });

  it('inserts blank pages and other PDFs at a position', async () => {
    const src = await numbered(2);
    const blank = await PDFDocument.load(await addBlankPages(src, { after: 1, count: 2, size: 'A4' }));
    expect(blank.getPageCount()).toBe(4);
    expect(Math.round(blank.getPage(1).getWidth())).toBe(595);
    expect(await texts(await insertPdf(src, await numbered(1, { tag: 'X' }), 0))).toEqual(['X1', 'P1', 'P2']);
    await expect(addBlankPages(src, { after: 5, count: 1, size: 'same' })).rejects.toThrow(/between 0 and 2/);
  });

  it('crops what the reader sees as the top, even on a rotated page', async () => {
    const plain = await PDFDocument.load(await cropPages(await numbered(1), { top: 10, right: 0, bottom: 0, left: 20 }));
    expect(plain.getPage(0).getCropBox()).toEqual({ x: 80, y: 0, width: 320, height: 540 });
    // Rotated 90° clockwise: the displayed top is the unrotated left edge.
    const turned = await PDFDocument.load(await cropPages(await numbered(1, { rotate: 90 }), { top: 10, right: 0, bottom: 0, left: 0 }));
    expect(turned.getPage(0).getCropBox()).toEqual({ x: 40, y: 0, width: 360, height: 600 });
    await expect(cropPages(await numbered(1), { top: 0, right: 0, bottom: 0, left: 0 })).rejects.toThrow(/at least one margin/);
  });
});

describe('stamping text', () => {
  it('centres a watermark on every page, upright relative to the reader, whatever the page rotation', async () => {
    for (const rotate of [0, 90, 180, 270]) {
      const out = await addWatermark(await numbered(1, { rotate }), { text: 'CONFIDENTIAL', fontSize: 40, opacity: 0.3, color: '#1d4ed8', layout: 'center' });
      const [page] = await read(out);
      const run = page!.runs.find((r) => r.str === 'CONFIDENTIAL')!;
      expect(run.angle).toBe(0);
      // The run starts left of centre by half its width and sits near the vertical middle.
      expect(run.v).toBeGreaterThan(0.45);
      expect(run.v).toBeLessThan(0.6);
      expect(run.u).toBeLessThan(0.5);
    }
  });

  it('draws a diagonal watermark along the page diagonal', async () => {
    const out = await addWatermark(await numbered(1, { size: [600, 600] }), {
      text: 'DRAFT',
      fontSize: 60,
      opacity: 0.2,
      color: '#d97706',
      layout: 'diagonal',
    });
    const run = (await read(out))[0]!.runs.find((r) => r.str === 'DRAFT')!;
    expect(run.angle).toBe(45);
  });

  it('numbers pages in the chosen corner and format, optionally skipping the cover', async () => {
    const out = await addPageNumbers(await numbered(3, { rotate: 90 }), {
      position: 'bottom-right',
      format: 'page-n-of-total',
      start: 1,
      fontSize: 10,
      margin: 24,
      skipFirst: true,
    });
    const pages = await read(out);
    expect(pages[0]!.text).not.toMatch(/Page/);
    const run = pages[2]!.runs.find((r) => r.str.startsWith('Page'))!;
    expect(run.str).toBe('Page 2 of 2');
    expect(run.angle).toBe(0);
    expect(run.u).toBeGreaterThan(0.7);
    expect(run.v).toBeGreaterThan(0.9);
    expect(pageLabel('n-of-total', 3, 9)).toBe('3 / 9');
  });

  it('rejects empty or unreasonable settings', async () => {
    const src = await numbered(1);
    await expect(addWatermark(src, { text: '  ', fontSize: 40, opacity: 0.3, color: '#000000', layout: 'center' })).rejects.toThrow(/Enter the watermark/);
    await expect(addWatermark(src, { text: 'X', fontSize: 40, opacity: 0, color: '#000000', layout: 'center' })).rejects.toThrow(/opacity/);
    await expect(addPageNumbers(src, { position: 'top-left', format: 'n', start: 1, fontSize: 100, margin: 24, skipFirst: false })).rejects.toThrow(/size/);
  });
});

describe('forms', () => {
  async function formPdf() {
    const d = await PDFDocument.create();
    const page = d.addPage([400, 400]);
    const form = d.getForm();
    form.createTextField('name').addToPage(page, { x: 20, y: 300, width: 200, height: 24 });
    form.createCheckBox('agree').addToPage(page, { x: 20, y: 250, width: 16, height: 16 });
    const dd = form.createDropdown('country');
    dd.addOptions(['Sierra Leone', 'Ghana']);
    dd.addToPage(page, { x: 20, y: 200, width: 200, height: 24 });
    return d.save();
  }

  it('lists fillable fields with their types and options', async () => {
    const fields = await listFormFields(await formPdf());
    expect(fields.map((f) => [f.name, f.type])).toEqual([
      ['name', 'text'],
      ['agree', 'checkbox'],
      ['country', 'dropdown'],
    ]);
    expect(fields[2]!.options).toEqual(['Sierra Leone', 'Ghana']);
  });

  it('fills fields, ignores unknown options, and can flatten so values become page text', async () => {
    const filled = await fillForm(await formPdf(), { name: 'Aminata Kamara', agree: true, country: 'Ghana', unknown: 'x' });
    const f = await listFormFields(filled);
    expect(f.find((x) => x.name === 'name')!.value).toBe('Aminata Kamara');
    expect(f.find((x) => x.name === 'agree')!.value).toBe(true);
    expect(f.find((x) => x.name === 'country')!.value).toBe('Ghana');
    const flat = await fillForm(await formPdf(), { name: 'Aminata Kamara' }, true);
    expect(await listFormFields(flat)).toEqual([]);
    expect((await read(flat))[0]!.text).toContain('Aminata Kamara');
  });

  it('flattens forms and reports when there was nothing to flatten', async () => {
    expect((await flattenPdf(await formPdf())).fields).toBe(3);
    expect((await flattenPdf(await numbered(1))).fields).toBe(0);
    await expect(fillForm(await numbered(1), { a: 'b' })).rejects.toThrow(/no fillable fields/);
  });
});

describe('images to PDF', () => {
  it('makes one page per image, fitted or on A4 with automatic orientation', async () => {
    const fit = await PDFDocument.load(await imagesToPdf([{ bytes: png(300, 200), type: 'image/png' }], { pageSize: 'fit', orientation: 'auto', margin: 10 }));
    expect([fit.getPage(0).getWidth(), fit.getPage(0).getHeight()]).toEqual([320, 220]);
    const a4 = await PDFDocument.load(
      await imagesToPdf(
        [
          { bytes: png(300, 200), type: 'image/png' },
          { bytes: png(200, 300), type: 'image/png' },
        ],
        { pageSize: 'A4', orientation: 'auto', margin: 20 },
      ),
    );
    expect(a4.getPages().map((p) => Math.round(p.getWidth()))).toEqual([842, 595]);
  });

  it('rejects files that are not images', async () => {
    await expect(imagesToPdf([{ bytes: new Uint8Array([1, 2, 3]), type: 'image/png' }], { pageSize: 'fit', orientation: 'auto', margin: 0 })).rejects.toThrow(
      /could not be read/,
    );
    await expect(imagesToPdf([], { pageSize: 'fit', orientation: 'auto', margin: 0 })).rejects.toThrow(/at least one image/);
  });
});

describe('every tool refuses unreadable or encrypted input', () => {
  it('reports a readable error', async () => {
    const junk = new TextEncoder().encode('not a pdf');
    await expect(rotatePages(junk, 90)).rejects.toThrow(/not a readable PDF/);
    await expect(mergePdfs([junk, junk])).rejects.toThrow(/not a readable PDF/);
  });
});

describe('download-all archive paths', () => {
  it('keeps folders, removes unsafe segments and numbers duplicates', async () => {
    const { archivePaths } = await import('@/lib/client/zip-download');
    expect(
      archivePaths([
        { name: 'a.pdf', folderPath: '' },
        { name: 'a.pdf', folderPath: '' },
        { name: 'A.PDF', folderPath: '' },
        { name: 'plan.pdf', folderPath: 'site/../drawings' },
        { name: 'x:y.txt', folderPath: '/abs' },
        { name: 'noext', folderPath: '' },
        { name: 'noext', folderPath: '' },
      ]),
    ).toEqual(['a.pdf', 'a (2).pdf', 'A (3).PDF', 'site/drawings/plan.pdf', 'abs/x_y.txt', 'noext', 'noext (2)']);
  });
});

describe('organize pages', () => {
  it('builds a new order from several PDFs with rotation and blank pages', async () => {
    const a = await numbered(3, { tag: 'A', rotate: 90 });
    const b = await numbered(1, { tag: 'B', size: [350, 620] });
    const out = await organizePdf(
      [a, b],
      [{ src: 1, index: 0, rotate: 90 }, { blank: true }, { src: 0, index: 2, rotate: 0 }, { src: 0, index: 0, rotate: 270 }],
    );
    const pages = await read(out);
    expect(pages.map((p) => p.text)).toEqual(['B1', '', 'A3', 'A1']);
    const doc = await PDFDocument.load(out);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 0, 90, 0]); // A1 was at 90°, +270° = 0°
    expect([doc.getPage(1).getWidth(), doc.getPage(1).getHeight()]).toEqual([350, 620]); // blank sized like the page before
  });

  it('refuses empty results, pages that do not exist and odd rotations', async () => {
    const a = await numbered(2);
    await expect(organizePdf([a], [])).rejects.toThrow(/at least one page/);
    await expect(organizePdf([a], [{ src: 0, index: 5, rotate: 0 }])).rejects.toThrow(/no longer exists/);
    await expect(organizePdf([a], [{ src: 1, index: 0, rotate: 0 }])).rejects.toThrow(/no longer exists/);
    await expect(organizePdf([a], [{ src: 0, index: 0, rotate: 45 as 90 }])).rejects.toThrow(/quarter turns/);
  });
});
