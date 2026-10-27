import { PDFDocument } from 'pdf-lib';
import { buildPdf } from '../editor/export';
import { norm } from '../editor/model';
import { overlayEdits, type OverlayItem } from '../editor/overlay';
import type { Impression } from './render';

// Stamping many PDFs at once (the "Stamp many PDFs" tool): the same stamp, in the same place, on the chosen pages of
// every file, a fresh impression each time, like stamping a pile of papers by hand; and the seam stamp across the edges
// of every page. Drawn by the editor's export, so rotated pages come out upright and the ink blends with the page.

export type StampPlace = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center';
export type StampPages = 'first' | 'last' | 'all';
export const PLACES: Array<[StampPlace, string]> = [
  ['top-left', 'Top left'],
  ['top-right', 'Top right'],
  ['center', 'Centre'],
  ['bottom-left', 'Bottom left'],
  ['bottom-right', 'Bottom right'],
];

export interface BatchStamp {
  place: StampPlace;
  pages: StampPages;
  /** Distance from the page edges, in millimetres. */
  marginMm: number;
}

const MM = 72 / 25.4;

/** Each page as shown: its rotation, and its width and height in points once turned upright. */
function shownPages(doc: PDFDocument) {
  return doc.getPages().map((p) => {
    const box = p.getCropBox();
    const rotation = norm(p.getRotation().angle);
    const turned = rotation % 180 !== 0;
    return { rotation, shownWidth: turned ? box.height : box.width, W: turned ? box.height : box.width, H: turned ? box.width : box.height };
  });
}

/**
 * A seam stamp: one impression cut into a strip per page, each strip flush with the right edge of its page, at the same
 * height on every page (`at`: 0 top … 1 bottom), so the seal is whole only when the pages are fanned out together.
 * `slices` are the strips, left to right (render.ts sliceImpression in the browser).
 */
export async function seamStampDocument(bytes: Uint8Array, at: number, slices: (n: number) => Promise<Impression[]>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const n = doc.getPageCount();
  if (n < 2) throw new Error('A seam stamp needs at least two pages.');
  const strips = await slices(n);
  const shown = shownPages(doc);
  const items: OverlayItem[] = strips.map((s, page) => {
    const { W, H } = shown[page]!;
    const w = Math.min(s.widthPt, W);
    const h = w / s.aspect;
    const y = Math.min(Math.max(0, at), 1) * Math.max(0, H - h);
    return { kind: 'image', page, u: (W - w) / W, v: y / H, w: w / W, h: Math.min(1, h / H), src: s.src, color: '#000000', blend: 'multiply' };
  });
  return buildPdf([bytes], overlayEdits(shown, items));
}

/**
 * Stamps one PDF. `impress(i)` gives the impression for the i-th stamp in this file (a fresh one each time, with the
 * file's number when the stamp is numbered); it is injected so this runs in tests without a canvas.
 */
export async function stampDocument(bytes: Uint8Array, o: BatchStamp, impress: (i: number) => Impression): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const n = doc.getPageCount();
  if (!n) throw new Error('This PDF has no pages.');
  const shown = shownPages(doc);
  const targets = o.pages === 'first' ? [0] : o.pages === 'last' ? [n - 1] : Array.from({ length: n }, (_, i) => i);
  const items: OverlayItem[] = targets.map((page, i) => {
    const { W, H } = shown[page]!;
    const imp = impress(i);
    // Never larger than the page, and the margin never pushes it off the page.
    const w = Math.min(imp.widthPt, W * 0.9);
    const h = w / imp.aspect;
    const m = Math.min(Math.max(0, o.marginMm) * MM, (W - w) / 2, Math.max(0, (H - h) / 2));
    const x = o.place.endsWith('left') ? m : o.place.endsWith('right') ? W - m - w : (W - w) / 2;
    const y = o.place.startsWith('top') ? m : o.place.startsWith('bottom') ? H - m - h : (H - h) / 2;
    return { kind: 'image', page, u: x / W, v: Math.max(0, y / H), w: w / W, h: Math.min(1, h / H), src: imp.src, color: '#000000', blend: 'multiply' };
  });
  return buildPdf([bytes], overlayEdits(shown, items));
}
