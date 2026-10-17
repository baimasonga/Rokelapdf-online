'use client';
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Check } from 'lucide-react';
import { openPdf } from '@/components/editor/pdfjs';

/** One lazily rendered page thumbnail. */
function Thumb({ doc, index }: { doc: PDFDocumentProxy; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let done = false;
    const io = new IntersectionObserver(
      async ([e]) => {
        if (!e?.isIntersecting || done) return;
        done = true;
        io.disconnect();
        const page = await doc.getPage(index + 1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (140 / Math.max(base.width, base.height)) * Math.min(window.devicePixelRatio || 1, 2) });
        el.width = Math.floor(vp.width);
        el.height = Math.floor(vp.height);
        await page.render({ canvas: el, viewport: vp }).promise.catch(() => undefined);
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [doc, index]);
  return <canvas ref={ref} className="picker-canvas" aria-hidden="true" />;
}

/**
 * Page thumbnails for choosing pages by clicking. `selected` holds zero-based indices. Without `onToggle` the
 * thumbnails are only a preview.
 */
export function PagePicker({
  bytes,
  selected,
  onToggle,
  onCount,
  mark = 'check',
}: {
  bytes: Uint8Array;
  selected?: Set<number>;
  onToggle?: (i: number) => void;
  onCount?: (n: number) => void;
  mark?: 'check' | 'remove';
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let d: PDFDocumentProxy | undefined;
    let live = true;
    openPdf(bytes).then(
      (x) => {
        d = x;
        if (!live) return void x.destroy();
        setDoc(x);
        onCount?.(x.numPages);
      },
      () => setError('This file could not be previewed.'),
    );
    return () => {
      live = false;
      void d?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);
  if (error) return <p className="muted">{error}</p>;
  if (!doc) return <p className="muted">Loading pages…</p>;
  return (
    <div className="picker" role="group" aria-label="Pages">
      {Array.from({ length: doc.numPages }, (_, i) => {
        const on = selected?.has(i) ?? false;
        return (
          <button
            key={i}
            type="button"
            className={`picker-page${on ? ` on ${mark}` : ''}`}
            aria-pressed={onToggle ? on : undefined}
            aria-label={`Page ${i + 1}`}
            disabled={!onToggle}
            onClick={() => onToggle?.(i)}
          >
            <Thumb doc={doc} index={i} />
            {on && (
              <span className="picker-mark" aria-hidden="true">
                <Check size={14} />
              </span>
            )}
            <span className="picker-num">{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Converts a selection to a compact range string ("1-3, 5"). */
export function toRanges(sel: Set<number>): string {
  const xs = [...sel].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < xs.length;) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j]! + 1) j++;
    out.push(i === j ? `${xs[i]! + 1}` : `${xs[i]! + 1}-${xs[j]! + 1}`);
    i = j + 1;
  }
  return out.join(', ');
}
