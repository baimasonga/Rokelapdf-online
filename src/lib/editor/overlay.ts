import { EditorError } from './export';
import { boxFrom, toPage, type Annot, type EditorState, type Rotation } from './model';

// Edits made on pages as a screen shows them (the Android app): positions are normalized to the displayed, rotated
// page with a top-left origin. `overlayEdits` turns them into the editor model, so the web editor's export draws
// them into the PDF.

/** A page as it was shown: its own rotation (/Rotate) and its displayed width in PDF points. */
export interface ShownPage {
  rotation: Rotation;
  shownWidth: number;
}

interface Base {
  /** Zero-based page index. */
  page: number;
  color: string;
}
export type OverlayItem =
  | (Base & { kind: 'image'; u: number; v: number; w: number; h: number; src: string })
  | (Base & { kind: 'highlight' | 'whiteout'; u: number; v: number; w: number; h: number })
  | (Base & { kind: 'ink'; points: Array<[number, number]>; width: number })
  /** `u`, `v`: top-left corner of the text; `size`: font size as a fraction of the shown page width. */
  | (Base & { kind: 'text'; u: number; v: number; text: string; size: number });

const box = (u: number, v: number, w: number, h: number, r: Rotation) => boxFrom(toPage(u, v, r), toPage(u + w, v + h, r));

/** The editor state for one source document with every page kept, in order, and the overlay items drawn on it. */
export function overlayEdits(pages: readonly ShownPage[], items: readonly OverlayItem[]): EditorState {
  const refs = pages.map((_, index) => ({ id: `p${index}`, src: 0, index, rotation: 0 as Rotation }));
  const annots: EditorState['annots'] = {};
  items.forEach((it, i) => {
    const ref = refs[it.page];
    const shown = pages[it.page];
    if (!ref || !shown) throw new EditorError('An edit is on a page that does not exist.');
    const r = shown.rotation;
    const id = `o${i}`;
    let a: Annot;
    switch (it.kind) {
      case 'image':
        a = { kind: 'image', id, color: it.color, ...box(it.u, it.v, it.w, it.h, r), src: it.src, rot: r };
        break;
      case 'highlight':
      case 'whiteout':
        a = { kind: it.kind, id, color: it.color, ...box(it.u, it.v, it.w, it.h, r) };
        break;
      case 'ink':
        a = {
          kind: 'ink',
          id,
          color: it.color,
          points: it.points.map(([u, v]) => {
            const p = toPage(u, v, r);
            return [p.x, p.y] as [number, number];
          }),
          width: it.width * shown.shownWidth,
        };
        break;
      case 'text': {
        const p = toPage(it.u, it.v, r);
        a = { kind: 'text', id, color: it.color, x: p.x, y: p.y, text: it.text, size: it.size * shown.shownWidth, rot: r };
      }
    }
    (annots[ref.id] ??= []).push(a);
  });
  return { pages: refs, annots };
}
