import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { isPdf, native, onIncoming, scanDocument, sharePdf, takeIncoming, type PdfFile } from './native';
import { openPdf, renderPage, type OpenPdf } from './pdf';

type Screen = { k: 'home' } | { k: 'view'; file: PdfFile; pdf: OpenPdf };

export function App() {
  const [screen, setScreen] = useState<Screen>({ k: 'home' });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);

  const show = useCallback(async (file: PdfFile) => {
    setError(undefined);
    const pdf = await openPdf(file.bytes);
    setScreen((old) => {
      if (old.k === 'view') void old.pdf.close();
      return { k: 'view', file, pdf };
    });
  }, []);
  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message || 'Something went wrong.');
    } finally {
      setBusy(undefined);
    }
  }, []);

  // A PDF opened from WhatsApp, Files or email ("Open with" / "Share") — at launch or while running.
  useEffect(() => {
    const receive = () =>
      void run('Opening…', async () => {
        const f = await takeIncoming();
        if (f) await show(f);
      });
    receive();
    const sub = onIncoming(receive);
    return () => void sub?.then((h) => h.remove());
  }, [run, show]);

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    void run('Opening…', async () => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (!isPdf(bytes)) throw new Error('That file is not a PDF.');
      await show({ name: f.name, bytes });
    });
  };

  return (
    <div className="app">
      <header className="bar">
        {screen.k === 'view' ? (
          <button className="back" onClick={() => setScreen({ k: 'home' })} aria-label="Back">
            ‹
          </button>
        ) : null}
        <h1>{screen.k === 'view' ? screen.file.name : 'Rokela PDF'}</h1>
        {screen.k === 'view' ? (
          <button className="action" onClick={() => void run('Preparing…', () => sharePdf(screen.file))}>
            Share
          </button>
        ) : null}
      </header>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {busy ? <p className="busy">{busy}</p> : null}
      <input ref={picker} type="file" accept="application/pdf,.pdf" hidden onChange={pick} />
      {screen.k === 'home' ? (
        <main className="home">
          <button
            className="tile primary"
            disabled={!!busy}
            onClick={() =>
              void run('Opening the scanner…', async () => {
                const f = await scanDocument();
                if (f) await show(f);
              })
            }
          >
            <strong>Scan a document</strong>
            <span>Camera with edge detection and clean-up. Saves as PDF.</span>
          </button>
          <button className="tile" disabled={!!busy} onClick={() => picker.current?.click()}>
            <strong>Open a PDF</strong>
            <span>From your phone, or use “Open with Rokela PDF” in WhatsApp and Files.</span>
          </button>
          <div className="tile soon" aria-disabled="true">
            <strong>Sign a PDF</strong>
            <span>Coming next.</span>
          </div>
          <div className="tile soon" aria-disabled="true">
            <strong>Word ⇄ PDF</strong>
            <span>Coming next (needs internet).</span>
          </div>
          {!native ? <p className="note">Preview in a browser: scanning and “Open with” need the Android app.</p> : null}
        </main>
      ) : (
        <Viewer doc={screen.pdf.doc} />
      )}
    </div>
  );
}

/** Renders pages as they scroll into view, so long PDFs stay light on memory. */
function Viewer({ doc }: { doc: PDFDocumentProxy }) {
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  return (
    <main className="viewer">
      <p className="meta">
        {doc.numPages} page{doc.numPages === 1 ? '' : 's'}
      </p>
      {pages.map((n) => (
        <Page key={n} doc={doc} n={n} />
      ))}
    </main>
  );
}

function Page({ doc, n }: { doc: PDFDocumentProxy; n: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || done) return;
        io.disconnect();
        void renderPage(doc, n, el, Math.min(el.parentElement!.clientWidth, 900)).then(() => setDone(true));
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [doc, n, done]);
  return (
    <figure className="page">
      <canvas ref={canvas} aria-label={`Page ${n}`} />
    </figure>
  );
}
