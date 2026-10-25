'use client';
import type { PaidFeature } from '@/lib/licensing';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ArrowLeft, ArrowRight, CheckCircle2, Download, FilePen, FilePlus, Loader2, Lock, Plus, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { closePdf, openPdf } from '@/components/editor/pdfjs';
import { putHandoff } from '@/lib/client/handoff';
import { fmtBytes } from '@/lib/client/format';
import { organizePdf, type PagePlan } from '@/lib/tools/ops';
import { Thumb } from './page-picker';

// "Organize pages": every page as a card you can drag into a new order, turn, delete or select; blank pages and the
// pages of more PDFs can be added. Runs in the browser; the result is built with pdf-lib.

type Rot = 0 | 90 | 180 | 270;
interface Card {
  key: string;
  src: number;
  index: number;
  rotate: Rot;
  blank?: boolean;
}
let seq = 0;
const key = () => `c${++seq}`;
const turn = (r: Rot, by: 90 | -90) => ((((r + by) % 360) + 360) % 360) as Rot;

export function Organizer({
  file,
  onReset,
  require,
}: {
  file: { name: string; bytes: Uint8Array };
  onReset: () => void;
  /** Adding pages from another PDF is merging, a paid tool (src/lib/licensing.ts). */
  require: (f: PaidFeature) => boolean | Promise<boolean>;
}) {
  const router = useRouter();
  const [sources, setSources] = useState<Uint8Array[]>([file.bytes]);
  const [docs, setDocs] = useState<PDFDocumentProxy[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string>();
  const [dropAt, setDropAt] = useState<{ key: string; after: boolean }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ url: string; name: string; bytes: Uint8Array }>();
  const addRef = useRef<HTMLInputElement>(null);
  const base = file.name.replace(/\.pdf$/i, '') || 'document';

  async function addSource(bytes: Uint8Array) {
    const doc = await openPdf(bytes);
    const srcIndex = sources.length;
    const fresh: Card[] = Array.from({ length: doc.numPages }, (_, i) => ({ key: key(), src: srcIndex, index: i, rotate: 0 as Rot }));
    setSources((xs) => [...xs, bytes]);
    setDocs((xs) => [...xs, doc]);
    setCards((xs) => [...xs, ...fresh]);
  }

  useEffect(() => {
    let live = true;
    let opened: PDFDocumentProxy | undefined;
    openPdf(file.bytes).then(
      (doc) => {
        opened = doc;
        if (!live) return void closePdf(doc);
        setDocs([doc]);
        setCards(Array.from({ length: doc.numPages }, (_, i) => ({ key: key(), src: 0, index: i, rotate: 0 as Rot })));
      },
      () => setError('This PDF could not be opened.'),
    );
    return () => {
      live = false;
      void closePdf(opened);
    };
  }, [file.bytes]);
  useEffect(() => () => result && URL.revokeObjectURL(result.url), [result]);

  const update = (fn: (c: Card) => Card, keys: Set<string>) => setCards((xs) => xs.map((c) => (keys.has(c.key) ? fn(c) : c)));
  const remove = (keys: Set<string>) => {
    setCards((xs) => xs.filter((c) => !keys.has(c.key)));
    setSelected(new Set());
  };
  const move = (k: string, by: -1 | 1) =>
    setCards((xs) => {
      const i = xs.findIndex((c) => c.key === k);
      const j = i + by;
      if (i < 0 || j < 0 || j >= xs.length) return xs;
      const next = xs.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const insertBlank = () =>
    setCards((xs) => {
      const lastSel = xs.reduce((at, c, i) => (selected.has(c.key) ? i : at), -1);
      const at = lastSel >= 0 ? lastSel + 1 : xs.length;
      return [...xs.slice(0, at), { key: key(), src: -1, index: 0, rotate: 0, blank: true }, ...xs.slice(at)];
    });

  // Drag and drop: the card is placed before or after the one under the pointer.
  const onDragOver = (e: DragEvent, k: string) => {
    if (!drag) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropAt({ key: k, after: e.clientX > r.left + r.width / 2 });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (drag && dropAt && drag !== dropAt.key)
      setCards((xs) => {
        const moving = xs.find((c) => c.key === drag)!;
        const rest = xs.filter((c) => c.key !== drag);
        const at = rest.findIndex((c) => c.key === dropAt.key) + (dropAt.after ? 1 : 0);
        return [...rest.slice(0, at), moving, ...rest.slice(at)];
      });
    setDrag(undefined);
    setDropAt(undefined);
  };

  async function build() {
    setError(undefined);
    setBusy('Building your PDF…');
    try {
      const plan: PagePlan[] = cards.map((c) => (c.blank ? { blank: true } : { src: c.src, index: c.index, rotate: c.rotate }));
      const bytes = await organizePdf(sources, plan);
      setResult({ url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' })), name: `${base}-organized.pdf`, bytes });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  if (result)
    return (
      <div className="tool-run">
        <section className="results done" aria-live="polite">
          <span className="done-check" aria-hidden="true">
            <CheckCircle2 size={44} />
          </span>
          <h2>Done! Your file is ready</h2>
          <a href={result.url} download={result.name} className="button primary xl">
            <Download size={22} aria-hidden="true" /> Download <span className="sr-only">{result.name}</span>
          </a>
          <p className="done-file">
            {result.name} · {cards.length} page{cards.length === 1 ? '' : 's'} · {fmtBytes(result.bytes.length)}
          </p>
          <div className="done-actions">
            <button
              type="button"
              className="button"
              onClick={async () => {
                await putHandoff(result.bytes, result.name);
                router.push('/edit?handoff=1');
              }}
            >
              <FilePen size={16} aria-hidden="true" /> Edit in the editor
            </button>
            <button type="button" className="button" onClick={() => setResult(undefined)}>
              <ArrowLeft size={16} aria-hidden="true" /> Keep organizing
            </button>
            <button type="button" className="button ghost" onClick={onReset}>
              <RotateCcw size={16} aria-hidden="true" /> Start over
            </button>
          </div>
        </section>
      </div>
    );

  const sel = selected.size;
  return (
    <div className="tool-run">
      <div className="tool-work">
        <div className="tool-main">
          <div className="org-bar" role="toolbar" aria-label="Pages">
            <span className="muted">
              {cards.length} page{cards.length === 1 ? '' : 's'}
              {sel ? ` · ${sel} selected` : ' · drag to reorder, click to select'}
            </span>
            <span className="org-bar-actions">
              <button type="button" className="button ghost" disabled={!sel} onClick={() => update((c) => ({ ...c, rotate: turn(c.rotate, -90) }), selected)}>
                <RotateCcw size={16} aria-hidden="true" /> Left
              </button>
              <button type="button" className="button ghost" disabled={!sel} onClick={() => update((c) => ({ ...c, rotate: turn(c.rotate, 90) }), selected)}>
                <RotateCw size={16} aria-hidden="true" /> Right
              </button>
              <button type="button" className="button ghost danger-text" disabled={!sel || sel === cards.length} onClick={() => remove(selected)}>
                <Trash2 size={16} aria-hidden="true" /> Delete
              </button>
            </span>
          </div>
          {!docs.length && !error && <p className="muted">Loading pages…</p>}
          <ul className="org-grid" aria-label="Pages in order" onDragOver={(e) => drag && e.preventDefault()} onDrop={onDrop}>
            {cards.map((c, i) => {
              const on = selected.has(c.key);
              const doc = c.blank ? undefined : docs[c.src];
              return (
                <li
                  key={c.key}
                  className={`org-card${on ? ' on' : ''}${drag === c.key ? ' dragging' : ''}${dropAt?.key === c.key ? (dropAt.after ? ' drop-after' : ' drop-before') : ''}`}
                  draggable
                  onDragStart={(e) => {
                    setDrag(c.key);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDrag(undefined);
                    setDropAt(undefined);
                  }}
                  onDragOver={(e) => onDragOver(e, c.key)}
                >
                  <button
                    type="button"
                    className="org-page"
                    aria-pressed={on}
                    aria-label={`Page ${i + 1}${c.blank ? ' (blank)' : ''}`}
                    onClick={() => toggle(c.key)}
                  >
                    <span className="org-art" style={{ transform: c.rotate ? `rotate(${c.rotate}deg)` : undefined }}>
                      {doc ? <Thumb doc={doc} index={c.index} /> : <span className="org-blank">Blank</span>}
                    </span>
                  </button>
                  <span className="org-num">{i + 1}</span>
                  <span className="org-tools">
                    <button type="button" className="icon-button" aria-label={`Move page ${i + 1} earlier`} disabled={i === 0} onClick={() => move(c.key, -1)}>
                      <ArrowLeft size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Rotate page ${i + 1}`}
                      onClick={() => update((x) => ({ ...x, rotate: turn(x.rotate, 90) }), new Set([c.key]))}
                    >
                      <RotateCw size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete page ${i + 1}`}
                      disabled={cards.length === 1}
                      onClick={() => remove(new Set([c.key]))}
                    >
                      <Trash2 size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move page ${i + 1} later`}
                      disabled={i === cards.length - 1}
                      onClick={() => move(c.key, 1)}
                    >
                      <ArrowRight size={15} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <aside className="tool-side" aria-label="Options">
          <h2>Organize pages</h2>
          <div className="tool-options">
            <button type="button" className="button wide" onClick={() => addRef.current?.click()}>
              <Plus size={16} aria-hidden="true" /> Add another PDF
            </button>
            <button type="button" className="button wide" onClick={insertBlank}>
              <FilePlus size={16} aria-hidden="true" /> Add a blank page{sel ? ' after selection' : ''}
            </button>
            <button
              type="button"
              className="button ghost wide"
              onClick={() => setSelected(sel === cards.length ? new Set() : new Set(cards.map((c) => c.key)))}
            >
              {sel === cards.length && sel ? 'Clear selection' : 'Select all pages'}
            </button>
            <input
              ref={addRef}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              data-testid="organize-add"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f || !(await require('merge'))) return;
                try {
                  await addSource(new Uint8Array(await f.arrayBuffer()));
                } catch {
                  setError(`“${f.name}” could not be opened as a PDF.`);
                }
              }}
            />
          </div>
          {error && (
            <p className="tool-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="button primary xl wide" disabled={!cards.length || !!busy} onClick={() => void build()}>
            {busy ? (
              <>
                <Loader2 size={20} className="spin" aria-hidden="true" /> {busy}
              </>
            ) : (
              <>
                Organize PDF <ArrowRight size={20} aria-hidden="true" />
              </>
            )}
          </button>
          <p className="bigdrop-note">
            <Lock size={13} aria-hidden="true" /> Processed in your browser
          </p>
        </aside>
      </div>
    </div>
  );
}
