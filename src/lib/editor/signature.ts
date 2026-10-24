import { EditorError } from './export';
import { boxFrom, toPage, type EditorState, type Rotation } from './model';

// Signature images made on this device (drawn, typed or from a photo). Shared by the web editor and the Android app.
// The result is a trimmed PNG data URL with a transparent background; it is never uploaded.

export interface SignatureImage {
  src: string;
  /** Width / height. */
  aspect: number;
}

const MAX_OUT = 900;

/** Crops to the drawn pixels (plus a little padding) and limits the size; undefined when nothing is drawn. */
export function trimSignature(src: HTMLCanvasElement): SignatureImage | undefined {
  const ctx = src.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, src.width, src.height);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3]! > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return undefined;
  const pad = 4;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const k = Math.min(1, MAX_OUT / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * k));
  out.height = Math.max(1, Math.round(h * k));
  out.getContext('2d')!.drawImage(src, x0, y0, w, h, 0, 0, out.width, out.height);
  return { src: out.toDataURL('image/png'), aspect: out.width / out.height };
}

/** Renders a typed name in a handwriting-style font; undefined for an empty name. */
export function typedSignature(name: string, font: string, ink: string): SignatureImage | undefined {
  const text = name.trim().slice(0, 60);
  if (!text) return undefined;
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 260;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = ink;
  ctx.textBaseline = 'middle';
  let size = 120;
  do {
    ctx.font = `${size}px ${font}`;
    size -= 6;
  } while (ctx.measureText(text).width > c.width - 40 && size > 30);
  ctx.fillText(text, 20, c.height / 2);
  return trimSignature(c);
}

/** A signature placed on a page as shown on screen: normalized to the displayed (rotated) page, top-left origin. */
export interface Placement {
  /** Zero-based page index. */
  page: number;
  u: number;
  v: number;
  w: number;
  h: number;
  src: string;
}

/**
 * The editor state that signs every page of one source document as placed. `rotations` are the pages' own
 * rotations (/Rotate), which is how they were shown when the signatures were placed.
 */
export function signatureEdits(rotations: readonly Rotation[], placements: readonly Placement[]): EditorState {
  const pages = rotations.map((_, index) => ({ id: `p${index}`, src: 0, index, rotation: 0 as Rotation }));
  const annots: EditorState['annots'] = {};
  placements.forEach((p, i) => {
    const page = pages[p.page];
    const r = rotations[p.page];
    if (!page || r === undefined) throw new EditorError('A signature is on a page that does not exist.');
    const box = boxFrom(toPage(p.u, p.v, r), toPage(p.u + p.w, p.v + p.h, r));
    (annots[page.id] ??= []).push({ kind: 'image', id: `s${i}`, color: '#000000', ...box, src: p.src, rot: r });
  });
  return { pages, annots };
}
