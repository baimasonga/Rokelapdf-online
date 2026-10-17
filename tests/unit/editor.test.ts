import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdf, blankPdf, dataUrlBytes, loadSource } from '@/lib/editor/export';
import { png } from './png';
import {
  appendPages,
  boxFrom,
  deletePage,
  drawableText,
  movePage,
  norm,
  rotatePage,
  toDisplay,
  toPage,
  uniqueFieldName,
  upsertAnnot,
  type EditorState,
  type Rotation,
} from '@/lib/editor/model';

async function source(sizes: Array<[number, number]>, rotate = 0, classic = false): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (const s of sizes) d.addPage(s).setRotation(degrees(rotate));
  return d.save({ useObjectStreams: !classic });
}
const FONTS = `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`;
const initial = (n: number, src = 0): EditorState => appendPages({ pages: [], annots: {} }, src, n);

/** Where pdf.js (an independent renderer) shows each text run: viewport position normalized to the shown page. */
async function textOnScreen(bytes: Uint8Array) {
  const doc = await getDocument({ data: bytes.slice(), useSystemFonts: false, standardFontDataUrl: FONTS }).promise;
  const out: Array<{ page: number; str: string; u: number; v: number; upright: boolean }> = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    for (const it of tc.items as Array<{ str: string; transform: number[] }>) {
      const [a, b, , , e, f] = it.transform as [number, number, number, number, number, number];
      const [x, y] = vp.convertToViewportPoint(e, f);
      // Direction of the baseline on screen: map a point a little along the text direction.
      const [x2, y2] = vp.convertToViewportPoint(e + a, f + b);
      out.push({ page: n, str: it.str, u: x / vp.width, v: y / vp.height, upright: x2 - x > 0 && Math.abs(y2 - y) < 1e-6 * vp.width + 0.01 });
    }
  }
  return out;
}

describe('editor coordinate mapping', () => {
  it('toPage inverts toDisplay for every rotation', () => {
    for (const r of [0, 90, 180, 270] as Rotation[])
      for (const [x, y] of [
        [0.1, 0.2],
        [0.9, 0.05],
        [0.5, 0.5],
      ] as const) {
        const d = toDisplay(x, y, r);
        const p = toPage(d.u, d.v, r);
        expect(p.x).toBeCloseTo(x, 10);
        expect(p.y).toBeCloseTo(y, 10);
      }
  });

  it('a rotated page shows the unrotated top-left corner where PDF viewers do', () => {
    // Rotating 90° clockwise moves the original top-left corner to the top-right.
    expect(toDisplay(0, 0, 90)).toEqual({ u: 1, v: 0 });
    expect(toDisplay(0, 0, 180)).toEqual({ u: 1, v: 1 });
    expect(toDisplay(0, 0, 270)).toEqual({ u: 0, v: 1 });
  });

  it('boxes are normalized and clamped to the page', () => {
    expect(boxFrom({ x: 0.8, y: 0.9 }, { x: 0.2, y: 1.4 })).toEqual({ x: 0.2, y: 0.9, w: 0.6000000000000001, h: 0.09999999999999998 });
  });

  it('replaces characters the built-in font cannot draw', () => {
    expect(drawableText('Héllo — “ok” 你好\r\nline')).toBe('Héllo — “ok” ??\nline');
  });
});

describe('editor page operations and export', () => {
  it('reorders, deletes, rotates and merges pages', async () => {
    const a = await source([
      [300, 400],
      [310, 410],
      [320, 420],
    ]);
    const b = await source([[500, 200]], 90);
    let s = initial(3);
    s = movePage(s, s.pages[2]!.id, 0); // 3,1,2
    s = deletePage(s, s.pages[2]!.id); // 3,1
    s = rotatePage(s, s.pages[1]!.id, 90);
    s = appendPages(s, 1, 1); // + b1 (already rotated 90 in its source)
    s = rotatePage(s, s.pages[2]!.id, -90);
    const out = await PDFDocument.load(await buildPdf([a, b], s, { title: 'Merged' }));
    expect(out.getPageCount()).toBe(3);
    expect(out.getPages().map((p) => [p.getWidth(), p.getHeight(), p.getRotation().angle])).toEqual([
      [320, 420, 0],
      [300, 400, 90],
      [500, 200, 0],
    ]);
    expect(out.getTitle()).toBe('Merged');
  });

  it('places text where it was typed and upright, on every rotation', async () => {
    const src = await source([[400, 600]]);
    for (const r of [0, 90, 180, 270] as Rotation[]) {
      let s = initial(1);
      const id = s.pages[0]!.id;
      s = rotatePage(s, id, 90);
      for (let i = 1; i < r / 90; i++) s = rotatePage(s, id, 90);
      if (r === 0) s = rotatePage(s, id, -90);
      // The user clicked at 20% from the left and 10% from the top of the page as shown.
      const at = toPage(0.2, 0.1, r);
      s = upsertAnnot(s, id, { id: 't', kind: 'text', x: at.x, y: at.y, text: 'Hello', size: 12, color: '#112233', rot: r });
      const [t] = await textOnScreen(await buildPdf([src], s));
      expect(t).toBeDefined();
      expect(t!.str).toBe('Hello');
      expect(t!.upright).toBe(true);
      expect(t!.u).toBeCloseTo(0.2, 2);
      // Baseline sits just below the click point (ascent of a 12pt font on the shown page height).
      const shownH = r % 180 ? 400 : 600;
      expect(t!.v).toBeCloseTo(0.1 + (12 * 0.8) / shownH, 2);
    }
  });

  it('draws highlights, boxes, whiteout and ink into the page content', async () => {
    const src = await source([[400, 600]]);
    let s = initial(1);
    const id = s.pages[0]!.id;
    s = upsertAnnot(s, id, { id: 'h', kind: 'highlight', x: 0.1, y: 0.1, w: 0.5, h: 0.05, color: '#ffeb3b' });
    s = upsertAnnot(s, id, { id: 'w', kind: 'whiteout', x: 0.1, y: 0.3, w: 0.2, h: 0.05, color: '#ffffff' });
    s = upsertAnnot(s, id, { id: 'r', kind: 'rect', x: 0.1, y: 0.5, w: 0.2, h: 0.1, color: '#d32f2f' });
    s = upsertAnnot(s, id, {
      id: 'i',
      kind: 'ink',
      points: [
        [0.1, 0.8],
        [0.2, 0.85],
        [0.3, 0.8],
      ],
      width: 2,
      color: '#1565c0',
    });
    const before = (await buildPdf([src], initial(1))).length;
    const bytes = await buildPdf([src], s);
    expect(bytes.length).toBeGreaterThan(before);
    const doc = await getDocument({ data: bytes.slice() }).promise;
    const ops = await (await doc.getPage(1)).getOperatorList();
    expect(ops.fnArray.length).toBeGreaterThan(5);
  });

  it('refuses encrypted PDFs instead of producing a broken file', async () => {
    const plain = new TextDecoder('latin1').decode(await source([[100, 100]], 0, true));
    const tampered = plain.replace('trailer\n<<', 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>');
    expect(tampered).not.toBe(plain);
    await expect(loadSource(Uint8Array.from(tampered, (c) => c.charCodeAt(0)))).rejects.toThrow(/password-protected.*Unlock PDF/);
    await expect(loadSource(new TextEncoder().encode('not a pdf'))).rejects.toThrow(/not a readable PDF/);
  });

  it('inserts blank pages and refuses to export an empty document', async () => {
    const blank = await blankPdf(200, 300);
    const out = await PDFDocument.load(await buildPdf([blank], initial(1)));
    expect([out.getPage(0).getWidth(), out.getPage(0).getHeight()]).toEqual([200, 300]);
    await expect(buildPdf([blank], { pages: [], annots: {} })).rejects.toThrow(/no pages/);
  });
});

describe('editor export with a cropped page', () => {
  it('positions annotations relative to the visible (cropped) area', async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([600, 800]);
    p.setCropBox(100, 100, 400, 600);
    const src = await d.save();
    let s = initial(1);
    s = upsertAnnot(s, s.pages[0]!.id, { id: 't', kind: 'text', x: 0.5, y: 0.5, text: 'Mid', size: 10, color: '#000000', rot: 0 });
    const [t] = await textOnScreen(await buildPdf([src], s));
    expect(t!.u).toBeCloseTo(0.5, 2);
    expect(t!.v).toBeCloseTo(0.5 + 8 / 600, 2);
  });
});

describe('editor signatures and form fields', () => {
  const sig = () => `data:image/png;base64,${Buffer.from(png(40, 20)).toString('base64')}`;

  /** Screen positions (normalized to the shown page) of the image's top-left and bottom-right corners. */
  async function imageOnScreen(bytes: Uint8Array) {
    const doc = await getDocument({ data: bytes.slice() }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const mul = (m: number[], n: number[]) => [
      m[0]! * n[0]! + m[2]! * n[1]!,
      m[1]! * n[0]! + m[3]! * n[1]!,
      m[0]! * n[2]! + m[2]! * n[3]!,
      m[1]! * n[2]! + m[3]! * n[3]!,
      m[0]! * n[4]! + m[2]! * n[5]! + m[4]!,
      m[1]! * n[4]! + m[3]! * n[5]! + m[5]!,
    ];
    const stack: number[][] = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, ops.argsArray[i] as number[]);
      else if (fn === OPS.paintImageXObject) {
        const at = (x: number, y: number) => {
          const [ux, uy] = [ctm[0]! * x + ctm[2]! * y + ctm[4]!, ctm[1]! * x + ctm[3]! * y + ctm[5]!];
          const [sx, sy] = vp.convertToViewportPoint(ux, uy);
          return { u: sx / vp.width, v: sy / vp.height };
        };
        // Image space: (0,1) is the picture's top-left, (1,0) its bottom-right.
        return { topLeft: at(0, 1), bottomRight: at(1, 0) };
      }
    }
    return undefined;
  }

  it('places a signature upright over the box it was dropped in, on every rotation', async () => {
    for (const base of [0, 90] as Rotation[]) {
      const src = await source([[400, 600]], base);
      for (const added of [0, 90, 180, 270] as Rotation[]) {
        let s = initial(1);
        const id = s.pages[0]!.id;
        for (let i = 0; i < added / 90; i++) s = rotatePage(s, id, 90);
        const r = norm(base + added);
        // Dropped at 20%–50% across and 10%–20% down the page as shown.
        const box = boxFrom(toPage(0.2, 0.1, r), toPage(0.5, 0.2, r));
        s = upsertAnnot(s, id, { id: 'g', kind: 'image', ...box, src: sig(), rot: r, color: '#000000' });
        const img = await imageOnScreen(await buildPdf([src], s));
        expect(img, `rotation ${r}`).toBeDefined();
        expect(img!.topLeft.u).toBeCloseTo(0.2, 3);
        expect(img!.topLeft.v).toBeCloseTo(0.1, 3);
        expect(img!.bottomRight.u).toBeCloseTo(0.5, 3);
        expect(img!.bottomRight.v).toBeCloseTo(0.2, 3);
      }
    }
  });

  it('embeds a signature placed several times only once', async () => {
    const src = await source([
      [400, 600],
      [400, 600],
    ]);
    let s = initial(2);
    const one = await buildPdf(
      [src],
      upsertAnnot(s, s.pages[0]!.id, { id: 'a', kind: 'image', x: 0.1, y: 0.1, w: 0.2, h: 0.1, src: sig(), rot: 0, color: '#000' }),
    );
    s = upsertAnnot(s, s.pages[0]!.id, { id: 'a', kind: 'image', x: 0.1, y: 0.1, w: 0.2, h: 0.1, src: sig(), rot: 0, color: '#000' });
    s = upsertAnnot(s, s.pages[1]!.id, { id: 'b', kind: 'image', x: 0.5, y: 0.5, w: 0.2, h: 0.1, src: sig(), rot: 0, color: '#000' });
    const two = await buildPdf([src], s);
    expect(two.length - one.length).toBeLessThan(200);
  });

  it('refuses a damaged signature image instead of exporting a broken file', async () => {
    expect(() => dataUrlBytes('javascript:alert(1)')).toThrow(/damaged/);
    expect(dataUrlBytes(sig()).type).toBe('png');
    const src = await source([[400, 600]]);
    const s = initial(1);
    const bad = upsertAnnot(s, s.pages[0]!.id, {
      id: 'x',
      kind: 'image',
      x: 0,
      y: 0,
      w: 0.1,
      h: 0.1,
      src: 'data:image/png;base64,AAAA',
      rot: 0,
      color: '#000',
    });
    await expect(buildPdf([src], bad)).rejects.toThrow(/damaged/);
  });

  it('adds fillable text fields and checkboxes where they were drawn, with unique names', async () => {
    for (const r of [0, 90] as Rotation[]) {
      const src = await source([[400, 600]], r);
      let s = initial(1);
      const id = s.pages[0]!.id;
      s = upsertAnnot(s, id, { id: 'f1', kind: 'field', field: 'text', name: 'Full name', x: 0.1, y: 0.1, w: 0.5, h: 0.05, color: '#1d4ed8' });
      s = upsertAnnot(s, id, {
        id: 'f2',
        kind: 'field',
        field: 'checkbox',
        name: uniqueFieldName(s, 'Full name'),
        x: 0.1,
        y: 0.3,
        w: 0.05,
        h: 0.04,
        color: '#1d4ed8',
      });
      expect(uniqueFieldName(s, 'Full name')).toBe('Full name 3');
      expect(uniqueFieldName(s, 'Full name', 'f1')).toBe('Full name');
      const out = await PDFDocument.load(await buildPdf([src], s));
      const fields = out.getForm().getFields();
      expect(fields.map((f) => [f.getName(), f.constructor.name])).toEqual([
        ['Full name', 'PDFTextField'],
        ['Full name 2', 'PDFCheckBox'],
      ]);
      // The widget covers the drawn box (page space → points, bottom-left origin), within the border width.
      const rect = fields[0]!.acroField.getWidgets()[0]!.getRectangle();
      const near = (a: number, b: number) => expect(Math.abs(a - b), `${a} vs ${b} at rotation ${r}`).toBeLessThanOrEqual(1);
      near(rect.x, 40);
      near(rect.y, 600 * (1 - 0.15));
      near(rect.width, 200);
      near(rect.height, 30);
    }
  });
});
