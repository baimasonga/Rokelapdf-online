import { PDFDocument } from 'pdf-lib';
import { buildPdf } from '../editor/export';
import { norm } from '../editor/model';
import { overlayEdits, type OverlayItem, type ShownPage } from '../editor/overlay';
import type { Impression } from './render';

// Stamping many PDFs at once (the "Stamp many PDFs" tool): the same stamp, in the same place, on the chosen pages of
// every file, a fresh impression each time, like stamping a pile of papers by hand. Drawn by the editor's export, so
// rotated pages come out upright and the ink blends with the page.

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

/**
 * Stamps one PDF. `impress(i)` gives the impression for the i-th stamp in this file (a fresh one each time, with the
 * file's number when the stamp is numbered); it is injected so this runs in tests without a canvas.
 */
export async function stampDocument(bytes: Uint8Array, o: BatchStamp, impress: (i: number) => Impression): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const n = doc.getPageCount();
  if (!n) throw new Error('This PDF has no pages.');
  const shown: ShownPage[] = doc.getPages().map((p) => {
    const box = p.getCropBox();
    const rotation = norm(p.getRotation().angle);
    return { rotation, shownWidth: rotation % 180 ? box.height : box.width };
  });
  const targets = o.pages === 'first' ? [0] : o.pages === 'last' ? [n - 1] : Array.from({ length: n }, (_, i) => i);
  const items: OverlayItem[] = targets.map((page, i) => {
    const p = doc.getPage(page);
    const box = p.getCropBox();
    const turned = shown[page]!.rotation % 180 !== 0;
    const W = turned ? box.height : box.width;
    const H = turned ? box.width : box.height;
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
