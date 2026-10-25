import { useEffect, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildPdf } from '@/lib/editor/export';
import { norm, type Rotation } from '@/lib/editor/model';
import { Check } from 'lucide-react';
import { renderPage } from './pdf';

// Organizing pages on the phone: reorder, rotate, delete, and add pages from other PDFs. The result is built on the
// device with the web editor's export.

export interface Sheet {
  key: number;
  /** Index into `sources`. */
  src: number;
  /** Zero-based page index in that source. */
  index: number;
  /** Rotation added here (clockwise). */
  rotation: Rotation;
}

let keys = 0;
export const sheetsOf = (src: number, count: number): Sheet[] => Array.from({ length: count }, (_, index) => ({ key: keys++, src, index, rotation: 0 }));

/** Builds the reorganized PDF. */
export function organize(sources: Uint8Array[], sheets: readonly Sheet[]): Promise<Uint8Array> {
  return buildPdf(sources, { pages: sheets.map((s) => ({ id: `k${s.key}`, src: s.src, index: s.index, rotation: s.rotation })), annots: {} });
}

/** Moves the selected pages one place earlier (-1) or later (+1), keeping their order. */
export function moveSelected(sheets: Sheet[], selected: ReadonlySet<number>, by: -1 | 1): Sheet[] {
  const next = [...sheets];
  const order = by < 0 ? next.map((_, i) => i) : next.map((_, i) => next.length - 1 - i);
  for (const i of order) {
    const j = i + by;
    if (!selected.has(next[i]!.key) || j < 0 || j >= next.length || selected.has(next[j]!.key)) continue;
    [next[i], next[j]] = [next[j]!, next[i]!];
  }
  return next;
}

/** Page thumbnails; tap to select, then act on the selection from the bottom bar. */
export function Pages({
  docs,
  sheets,
  selected,
  onToggle,
}: {
  docs: readonly PDFDocumentProxy[];
  sheets: Sheet[];
  selected: ReadonlySet<number>;
  onToggle: (key: number) => void;
}) {
  return (
    <main className="pages">
      {sheets.map((s, i) => {
        const on = selected.has(s.key);
        return (
          <button key={s.key} className={`thumb${on ? ' on' : ''}`} aria-pressed={on} aria-label={`Page ${i + 1}`} onClick={() => onToggle(s.key)}>
            <span className="thumb-img">
              <Thumb doc={docs[s.src]!} index={s.index} rotation={s.rotation} />
              {on ? (
                <span className="thumb-check" aria-hidden="true">
                  <Check size={16} strokeWidth={3} />
                </span>
              ) : null}
            </span>
            <span className="num">{i + 1}</span>
          </button>
        );
      })}
    </main>
  );
}

function Thumb({ doc, index, rotation }: { doc: PDFDocumentProxy; index: number; rotation: Rotation }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        if (live) void renderPage(doc, index + 1, el, 150).catch(() => undefined);
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [doc, index]);
  return <canvas ref={canvas} style={{ transform: `rotate(${rotation}deg)` }} aria-hidden="true" />;
}
