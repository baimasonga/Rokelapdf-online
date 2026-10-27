import { useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildEditedPdf } from '@/lib/client/editor-export';
import { norm } from '@/lib/editor/model';
import { overlayEdits, type OverlayItem, type ShownPage } from '@/lib/editor/overlay';
import { Eraser, Highlighter, ImagePlus, PenTool, Stamp, Type, type LucideIcon } from 'lucide-react';
import type { StampDesign } from '@/lib/stamp/design';
import { renderStamp } from '@/lib/stamp/render';
import { Sheet } from './ui';

// Editing on the phone: text, highlights, drawing, white-out ("cover"), pictures and stamps are placed on pages as shown,
// then drawn into the PDF on the device with the web editor's export. Nothing is uploaded.

export type Tool = 'text' | 'highlight' | 'draw' | 'cover' | 'image' | 'stamp';
export type Item = OverlayItem & { id: number; aspect?: number };

export const TOOLS: Array<[Tool, string, LucideIcon]> = [
  ['text', 'Text', Type],
  ['highlight', 'Highlight', Highlighter],
  ['draw', 'Draw', PenTool],
  ['cover', 'Cover', Eraser],
  ['image', 'Image', ImagePlus],
  ['stamp', 'Stamp', Stamp],
];
export const HINTS: Record<Tool, string> = {
  text: 'Tap where the text goes. Tap text again to change it; drag to move.',
  highlight: 'Drag across the words to highlight.',
  draw: 'Draw with your finger.',
  cover: 'Drag over words to hide them. To change words, cover them, then add text on top.',
  image: 'Tap where the picture goes. Drag to move; drag the corner to resize.',
  stamp: 'Tap where to stamp. Each tap is a fresh impression; drag to move, drag the corner to resize.',
};
export const COLORS = ['#111827', '#1d4ed8', '#c62828', '#1e7d3a'];
const HIGHLIGHT = '#ffe14d';
/** CSS text sits a little lower than the exported baseline (Helvetica ascent 0.8 at line height 1.25). */
const TEXT_NUDGE = 0.17;

let nextId = 1;
export const newItemId = () => nextId++;

/** Draws every edit into the PDF and returns the edited copy. */
export async function editPdf(bytes: Uint8Array, doc: PDFDocumentProxy, items: readonly Item[]): Promise<Uint8Array> {
  const pages: ShownPage[] = await Promise.all(
    Array.from({ length: doc.numPages }, async (_, i) => {
      const page = await doc.getPage(i + 1);
      return { rotation: norm(page.rotate), shownWidth: page.getViewport({ scale: 1 }).width };
    }),
  );
  // The web editor's export: embeds Noto Sans when the text needs more than Helvetica's characters.
  return buildEditedPdf([bytes], overlayEdits(pages, items));
}

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

export interface EditState {
  tool: Tool;
  color: string;
  /** Text size as a fraction of the shown page width. */
  size: number;
  items: Item[];
  /** A picture chosen for the Image tool, waiting to be placed. */
  picture?: { src: string; aspect: number };
  /** The stamp the Stamp tool presses (src/lib/stamp), chosen in the Stamp sheet. */
  stamp?: StampDesign;
}

/** Edits on one page: draws boxes and strokes, places text and pictures, moves and resizes them. */
export function EditLayer({
  page,
  state,
  onChange,
  onText,
  widthPt,
  onStamped,
}: {
  page: number;
  state: EditState;
  /** The page's shown width in PDF points, so a stamp lands at its real size on paper. */
  widthPt?: number;
  /** A numbered stamp was pressed: its next number went up. */
  onStamped?: (d: StampDesign) => void;
  onChange: (fn: (items: Item[]) => Item[]) => void;
  /** Ask for text at a point (new) or for an existing text item. */
  onText: (at: { page: number; u: number; v: number } | Item) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [draft, setDraftState] = useState<Item>();
  // The item being drawn lives in a ref too: a quick swipe can lift the finger before React re-renders.
  const draftRef = useRef<Item>(undefined);
  const setDraft = (d: Item | undefined) => {
    draftRef.current = d;
    setDraftState(d);
  };
  const start = useRef<{ u: number; v: number }>(undefined);
  const drag = useRef<{ id: number; kind: 'move' | 'size'; x: number; y: number }>(undefined);
  /** Set when a press turned into a drag, so the click that follows does not open the text sheet. */
  const moved = useRef(false);
  const rect = () => layer.current!.getBoundingClientRect();
  const at = (e: { clientX: number; clientY: number }) => {
    const r = rect();
    return { u: clamp((e.clientX - r.left) / r.width), v: clamp((e.clientY - r.top) / r.height) };
  };
  const drawing = state.tool === 'draw' || state.tool === 'highlight' || state.tool === 'cover';

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drawing || e.target !== layer.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    start.current = p;
    const base = { id: newItemId(), page };
    if (state.tool === 'draw') setDraft({ ...base, kind: 'ink', points: [[p.u, p.v]], width: 0.004, color: state.color });
    else
      setDraft({
        ...base,
        kind: state.tool === 'cover' ? 'whiteout' : 'highlight',
        u: p.u,
        v: p.v,
        w: 0,
        h: 0,
        color: state.tool === 'cover' ? '#ffffff' : HIGHLIGHT,
      });
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const draft = draftRef.current;
    if (!draft || !start.current) return;
    const p = at(e);
    if (draft.kind === 'ink') setDraft({ ...draft, points: [...draft.points, [p.u, p.v]] });
    else if (draft.kind === 'highlight' || draft.kind === 'whiteout') {
      const s = start.current;
      setDraft({ ...draft, u: Math.min(s.u, p.u), v: Math.min(s.v, p.v), w: Math.abs(p.u - s.u), h: Math.abs(p.v - s.v) });
    }
  };
  const up = () => {
    const d = draftRef.current;
    setDraft(undefined);
    start.current = undefined;
    if (!d) return;
    const big = d.kind === 'ink' ? d.points.length > 1 : (d.kind === 'highlight' || d.kind === 'whiteout') && d.w > 0.01 && d.h > 0.005;
    if (big) onChange((items) => [...items, d]);
  };
  const tap = (e: RMouseEvent<HTMLDivElement>) => {
    if (e.target !== layer.current) return;
    const p = at(e);
    if (state.tool === 'text') onText({ page, ...p });
    else if (state.tool === 'image' && state.picture) {
      const r = rect();
      const w = 0.4;
      const h = (w * (r.width / r.height)) / state.picture.aspect;
      const u = clamp(p.u - w / 2, 0, 1 - w);
      const v = clamp(p.v - h / 2, 0, Math.max(0, 1 - h));
      const src = state.picture.src;
      onChange((items) => [...items, { id: newItemId(), page, kind: 'image', u, v, w, h, src, color: '#000000', aspect: state.picture!.aspect }]);
    } else if (state.tool === 'stamp' && state.stamp) {
      // A fresh impression every time, as with a rubber stamp, at its size on paper; its ink blends with the page.
      const d = state.stamp;
      const imp = renderStamp(d, { seed: Math.floor(Math.random() * 2 ** 31) });
      const r = rect();
      const w = clamp(imp.widthPt / (widthPt ?? 595.28), 0.06, 0.9);
      const h = (w * (r.width / r.height)) / imp.aspect;
      const u = clamp(p.u - w / 2, 0, 1 - w);
      const v = clamp(p.v - h / 2, 0, Math.max(0, 1 - h));
      onChange((items) => [
        ...items,
        { id: newItemId(), page, kind: 'image', u, v, w, h, src: imp.src, color: '#000000', aspect: imp.aspect, blend: 'multiply' },
      ]);
      if (d.numbered) onStamped?.({ ...d, next: d.next + 1 });
    }
  };

  // Moving text and pictures, resizing pictures.
  const grab = (e: RPointerEvent, id: number, kind: 'move' | 'size') => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { id, kind, x: e.clientX, y: e.clientY };
    moved.current = false;
  };
  const shift = (e: RPointerEvent) => {
    e.stopPropagation();
    const d = drag.current;
    if (!d) return;
    const r = rect();
    const du = (e.clientX - d.x) / r.width;
    const dv = (e.clientY - d.y) / r.height;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    if (Math.abs(du) + Math.abs(dv) > 0.002) moved.current = true;
    onChange((items) =>
      items.map((it) => {
        if (it.id !== d.id) return it;
        if (it.kind === 'text') return { ...it, u: clamp(it.u + du), v: clamp(it.v + dv) };
        if (it.kind !== 'image') return it;
        if (d.kind === 'move') return { ...it, u: clamp(it.u + du, 0, 1 - it.w), v: clamp(it.v + dv, 0, 1 - it.h) };
        const w = clamp(it.w + du, 0.06, 1 - it.u);
        const h = (w * (r.width / r.height)) / (it.aspect ?? 1);
        return it.v + h > 1 ? it : { ...it, w, h };
      }),
    );
  };
  const drop = () => (drag.current = undefined);

  const mine = state.items.filter((it) => it.page === page);
  const shown = draft ? [...mine, draft] : mine;
  const width = layer.current?.clientWidth ?? 360;
  return (
    <div
      ref={layer}
      className={`edit-layer${drawing ? ' drawing' : ''}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={tap}
    >
      {shown.map((it) => {
        if (it.kind === 'ink')
          return (
            <svg key={it.id} className="ink" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              <polyline
                points={it.points.map(([u, v]) => `${u},${v}`).join(' ')}
                fill="none"
                stroke={it.color}
                strokeWidth={Math.max(1.5, it.width * width)}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          );
        if (it.kind === 'highlight' || it.kind === 'whiteout')
          return (
            <div
              key={it.id}
              className={`box ${it.kind}`}
              style={{ left: `${it.u * 100}%`, top: `${it.v * 100}%`, width: `${it.w * 100}%`, height: `${it.h * 100}%` }}
            />
          );
        if (it.kind === 'text') {
          const px = it.size * width;
          return (
            <div
              key={it.id}
              className="text-item"
              style={{ left: `${it.u * 100}%`, top: `${it.v * 100}%`, fontSize: `${px}px`, marginTop: `${-TEXT_NUDGE * px}px`, color: it.color }}
              onPointerDown={(e) => grab(e, it.id, 'move')}
              onPointerMove={shift}
              onPointerUp={drop}
              onPointerCancel={drop}
              onClick={(e) => {
                e.stopPropagation();
                if (!moved.current) onText(it);
              }}
            >
              {it.text}
            </div>
          );
        }
        if (it.kind === 'image')
          return (
            <div
              key={it.id}
              className="placed"
              style={{ left: `${it.u * 100}%`, top: `${it.v * 100}%`, width: `${it.w * 100}%`, height: `${it.h * 100}%` }}
              onPointerDown={(e) => grab(e, it.id, 'move')}
              onPointerMove={shift}
              onPointerUp={drop}
              onPointerCancel={drop}
            >
              <img src={it.src} alt="" draggable={false} style={it.blend ? { mixBlendMode: 'multiply' } : undefined} />
              <button
                className="remove"
                aria-label="Remove picture"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange((items) => items.filter((x) => x.id !== it.id));
                }}
              >
                ×
              </button>
              <span
                className="resize"
                aria-hidden="true"
                onPointerDown={(e) => grab(e, it.id, 'size')}
                onPointerMove={shift}
                onPointerUp={drop}
                onPointerCancel={drop}
              />
            </div>
          );
        return null;
      })}
    </div>
  );
}

/** Asks for the words of a text item, its size and colour. */
export function TextSheet({
  initial,
  color,
  size,
  onCancel,
  onDone,
  onDelete,
}: {
  initial: string;
  color: string;
  size: number;
  onCancel: () => void;
  onDone: (text: string, color: string, size: number) => void;
  onDelete?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [c, setC] = useState(color);
  const [s, setS] = useState(size);
  return (
    <Sheet title="Add text" onClose={onCancel}>
      <textarea autoFocus rows={3} value={text} maxLength={500} placeholder="Type here" aria-label="Text" onChange={(e) => setText(e.target.value)} />
      <label className="row">
        <span className="muted">Size</span>
        <input type="range" min={0.015} max={0.08} step={0.0025} value={s} aria-label="Text size" onChange={(e) => setS(Number(e.target.value))} />
      </label>
      <div className="row">
        <span className="swatches" role="radiogroup" aria-label="Colour">
          {COLORS.map((x) => (
            <button
              key={x}
              role="radio"
              aria-checked={c === x}
              aria-label={`Colour ${x}`}
              className={`swatch${c === x ? ' on' : ''}`}
              style={{ background: x }}
              onClick={() => setC(x)}
            />
          ))}
        </span>
        <span className="actions">
          {onDelete ? (
            <button className="ghost" onClick={onDelete}>
              Delete
            </button>
          ) : null}
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={!text.trim()} onClick={() => onDone(text, c, s)}>
            Done
          </button>
        </span>
      </div>
    </Sheet>
  );
}
