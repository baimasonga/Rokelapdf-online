import { useEffect, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildPdf } from '@/lib/editor/export';
import { norm, type Rotation } from '@/lib/editor/model';
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

export function Pages({ docs, sheets, onChange }: { docs: readonly PDFDocumentProxy[]; sheets: Sheet[]; onChange: (next: Sheet[]) => void }) {
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= sheets.length) return;
    const next = [...sheets];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <main className="pages">
      {sheets.map((s, i) => (
        <figure key={s.key} className="thumb">
          <div className="thumb-img">
            <Thumb doc={docs[s.src]!} index={s.index} rotation={s.rotation} />
          </div>
          <figcaption>
            <span className="num">{i + 1}</span>
            <span className="tbtns">
              <button aria-label={`Move page ${i + 1} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>
                ‹
              </button>
              <button
                aria-label={`Rotate page ${i + 1}`}
                onClick={() => onChange(sheets.map((x) => (x.key === s.key ? { ...x, rotation: norm(x.rotation + 90) } : x)))}
              >
                ↻
              </button>
              <button aria-label={`Delete page ${i + 1}`} disabled={sheets.length === 1} onClick={() => onChange(sheets.filter((x) => x.key !== s.key))}>
                ✕
              </button>
              <button aria-label={`Move page ${i + 1} later`} disabled={i === sheets.length - 1} onClick={() => move(i, 1)}>
                ›
              </button>
            </span>
          </figcaption>
        </figure>
      ))}
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
