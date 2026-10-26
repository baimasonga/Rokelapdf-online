// The editor's document model. It is plain data so edits can be undone, saved and tested without a browser.
//
// Coordinates: annotations live in *page space* — normalized [0,1] coordinates of the unrotated visible page (CropBox),
// origin at its top-left corner. The screen shows the page rotated by its total rotation (the source's /Rotate plus
// any rotation added in the editor); `toDisplay`/`toPage` convert between page space and the displayed page.

export type Rotation = 0 | 90 | 180 | 270;
export const norm = (deg: number): Rotation => ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Rotation;

export interface PageRef {
  id: string;
  /** Index into the editor's source PDFs. */
  src: number;
  /** Zero-based page index within that source. */
  index: number;
  /** Rotation added in the editor (clockwise). */
  rotation: Rotation;
}

interface Base {
  id: string;
  color: string; // #rrggbb
}
export interface TextAnnot extends Base {
  kind: 'text';
  /** Page-space point that was the text's top-left corner on screen when it was placed. */
  x: number;
  y: number;
  text: string;
  /** Font size in PDF points. */
  size: number;
  /** Total page rotation when the text was placed; the text stays upright relative to that view. */
  rot: Rotation;
}
export interface BoxAnnot extends Base {
  kind: 'highlight' | 'rect' | 'whiteout' | 'redact';
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface InkAnnot extends Base {
  kind: 'ink';
  points: Array<[number, number]>;
  /** Stroke width in PDF points. */
  width: number;
}
/**
 * A picture placed on the page (a signature or a stamp). The box is in page space; the picture is upright in the view
 * it was placed in. Stamps blend with the page (`multiply`), so printed text shows through the ink as it does on paper.
 */
export interface ImageAnnot extends Base {
  kind: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  /** PNG data URL, created on this device. */
  src: string;
  rot: Rotation;
  blend?: 'multiply';
}
/** A fillable form field (AcroForm widget) added to the page. */
export interface FieldAnnot extends Base {
  kind: 'field';
  field: 'text' | 'checkbox';
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Annot = TextAnnot | BoxAnnot | InkAnnot | ImageAnnot | FieldAnnot;

export interface EditorState {
  pages: PageRef[];
  /** Annotations by page id. */
  annots: Record<string, Annot[]>;
}

export interface Pt {
  u: number;
  v: number;
}

/** Page space → displayed page (both normalized, top-left origin) for a total clockwise rotation. */
export function toDisplay(px: number, py: number, r: Rotation): Pt {
  switch (r) {
    case 0:
      return { u: px, v: py };
    case 90:
      return { u: 1 - py, v: px };
    case 180:
      return { u: 1 - px, v: 1 - py };
    case 270:
      return { u: py, v: 1 - px };
  }
}

/** Displayed page → page space. */
export function toPage(u: number, v: number, r: Rotation): { x: number; y: number } {
  switch (r) {
    case 0:
      return { x: u, y: v };
    case 90:
      return { x: v, y: 1 - u };
    case 180:
      return { x: 1 - u, y: 1 - v };
    case 270:
      return { x: 1 - v, y: u };
  }
}

/** Displayed size of a page whose unrotated size is w × h. */
export const displaySize = (w: number, h: number, r: Rotation) => (r % 180 ? { w: h, h: w } : { w, h });

/** Normalizes a box drawn between two page-space points. */
export function boxFrom(a: { x: number; y: number }, b: { x: number; y: number }) {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x1 = clamp(Math.min(a.x, b.x));
  const y1 = clamp(Math.min(a.y, b.y));
  return { x: x1, y: y1, w: clamp(Math.max(a.x, b.x)) - x1, h: clamp(Math.max(a.y, b.y)) - y1 };
}

export const LINE_HEIGHT = 1.25;
export const ASCENT = 0.8;

/** Characters the built-in Helvetica (WinAnsi) can draw; others become '?' so export never fails. */
export function drawableText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[^\n\x20-\x7e\xa0-\xff€‘’“”•–—…™]/g, '?');
}

let counter = 0;
export const newId = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---- pure edits (each returns a new state) ---------------------------------------------------------------
export function rotatePage(s: EditorState, id: string, by: 90 | -90): EditorState {
  return { ...s, pages: s.pages.map((p) => (p.id === id ? { ...p, rotation: norm(p.rotation + by) } : p)) };
}
export function deletePage(s: EditorState, id: string): EditorState {
  const annots = { ...s.annots };
  delete annots[id];
  return { pages: s.pages.filter((p) => p.id !== id), annots };
}
export function movePage(s: EditorState, id: string, to: number): EditorState {
  const from = s.pages.findIndex((p) => p.id === id);
  if (from < 0) return s;
  const pages = [...s.pages];
  const [p] = pages.splice(from, 1);
  pages.splice(Math.max(0, Math.min(pages.length, to)), 0, p!);
  return { ...s, pages };
}
export function appendPages(s: EditorState, src: number, count: number, at = s.pages.length): EditorState {
  const added: PageRef[] = Array.from({ length: count }, (_, index) => ({ id: newId('p'), src, index, rotation: 0 }));
  const pages = [...s.pages];
  pages.splice(at, 0, ...added);
  return { ...s, pages };
}
export function upsertAnnot(s: EditorState, pageId: string, a: Annot): EditorState {
  const list = s.annots[pageId] ?? [];
  const i = list.findIndex((x) => x.id === a.id);
  return { ...s, annots: { ...s.annots, [pageId]: i < 0 ? [...list, a] : list.map((x) => (x.id === a.id ? a : x)) } };
}
export function removeAnnot(s: EditorState, pageId: string, annotId: string): EditorState {
  return { ...s, annots: { ...s.annots, [pageId]: (s.annots[pageId] ?? []).filter((x) => x.id !== annotId) } };
}
/** Moves an annotation by a page-space delta, keeping it on the page. */
export function moveAnnot(a: Annot, dx: number, dy: number): Annot {
  const c = (n: number) => Math.min(1, Math.max(0, n));
  if (a.kind === 'ink') return { ...a, points: a.points.map(([x, y]) => [c(x + dx), c(y + dy)] as [number, number]) };
  if (a.kind === 'text') return { ...a, x: c(a.x + dx), y: c(a.y + dy) };
  // Boxes keep their size and stay entirely on the page.
  return { ...a, x: Math.min(1 - a.w, Math.max(0, a.x + dx)), y: Math.min(1 - a.h, Math.max(0, a.y + dy)) };
}

/** Field names must be unique in a PDF form; returns `name`, or `name 2`, `name 3`… if it is taken. */
export function uniqueFieldName(s: EditorState, name: string, except?: string): string {
  const taken = new Set(
    Object.values(s.annots)
      .flat()
      .filter((a): a is FieldAnnot => a.kind === 'field' && a.id !== except)
      .map((a) => a.name),
  );
  const base =
    name
      .trim()
      .replace(/[.\s]+/g, ' ')
      .slice(0, 60) || 'Field';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}
