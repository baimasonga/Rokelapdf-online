import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Session } from '@supabase/supabase-js';
import type { SignatureImage } from '@/lib/editor/signature';
import { DOCX_MIME, PDF_MIME, isPdf, native, onIncoming, saveFile, scanDocument, shareFile, takeIncoming, type PdfFile } from './native';
import { openPdf, renderPage, type OpenPdf } from './pdf';
import { SITE, WORD_EXTENSIONS, convert, currentSession, renamed, signIn, signOut } from './account';
import { SignLayer, SignaturePad, signPdf, type Placed } from './sign';

type View = { k: 'view'; file: PdfFile; pdf: OpenPdf; id: number };
type Screen = { k: 'home' } | View | { k: 'convert'; from?: View };
/** A converted file waiting for the person to save or share it. */
interface Ready {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

let opened = 0;
const signedName = (name: string) => `${name.replace(/\.pdf$/i, '')}-signed.pdf`;

export function App() {
  const [screen, setScreen] = useState<Screen>({ k: 'home' });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [ready, setReady] = useState<Ready>();
  const [session, setSession] = useState<Session | null>();
  const [signature, setSignature] = useState<SignatureImage>();
  const [pad, setPad] = useState(false);
  const [placed, setPlaced] = useState<Placed[]>();
  const picker = useRef<HTMLInputElement>(null);

  /** Messages belong to the screen they were shown on; clear them whenever the screen changes. */
  const clearMessages = useCallback(() => {
    setError(undefined);
    setNotice(undefined);
  }, []);

  const show = useCallback(
    async (file: PdfFile) => {
      clearMessages();
      setPlaced(undefined);
      const pdf = await openPdf(file.bytes);
      setScreen((old) => {
        if (old.k === 'view') void old.pdf.close();
        if (old.k === 'convert' && old.from) void old.from.pdf.close();
        return { k: 'view', file, pdf, id: ++opened };
      });
    },
    [clearMessages],
  );
  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
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

  const back = () => {
    clearMessages();
    setPlaced(undefined);
    if (screen.k === 'convert' && screen.from) return setScreen(screen.from);
    if (screen.k === 'view') void screen.pdf.close();
    setScreen({ k: 'home' });
  };

  const openAccount = (from?: View) => {
    clearMessages();
    setSession(undefined);
    setScreen({ k: 'convert', ...(from ? { from } : {}) });
    void currentSession().then(setSession, (e: Error) => {
      setSession(null);
      setError(e.message);
    });
  };

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

  const toWord = (v: View) =>
    run('Converting to Word… this can take a minute.', async () => {
      if (!(await currentSession())) return openAccount(v);
      const bytes = await convert('docx', v.file.name, v.file.bytes);
      const file = v.file;
      setReady({ name: renamed(file.name, 'docx'), bytes, mime: DOCX_MIME });
    });

  const startSigning = (sig: SignatureImage) => {
    setSignature(sig);
    setPad(false);
    setPlaced((old) => old ?? []);
  };
  const applySignatures = (v: View) =>
    run('Signing…', async () => {
      if (!placed?.length) throw new Error('Tap the page where your signature goes.');
      const bytes = await signPdf(v.file.bytes, v.pdf.doc, placed);
      await show({ name: signedName(v.file.name), bytes });
      setNotice('Signed. Save or share the signed copy.');
    });

  const view = screen.k === 'view' ? screen : undefined;
  const title = view ? view.file.name : screen.k === 'convert' ? 'Word ⇄ PDF' : 'Rokela PDF';

  return (
    <div className="app">
      <header className="bar">
        {screen.k !== 'home' ? (
          <button className="back" onClick={back} aria-label="Back">
            ‹
          </button>
        ) : null}
        <h1>{title}</h1>
      </header>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {busy ? <p className="busy">{busy}</p> : null}
      {ready ? (
        <div className="ready" role="status">
          <span>{ready.name} is ready.</span>
          <button
            onClick={() =>
              void run('Saving…', async () => {
                if (await saveFile(ready.name, ready.bytes, ready.mime)) setNotice(`Saved ${ready.name}.`);
              })
            }
          >
            Save
          </button>
          <button onClick={() => void run('Preparing…', () => shareFile(ready.name, ready.bytes, ready.mime))}>Share</button>
          <button className="close" aria-label="Dismiss" onClick={() => setReady(undefined)}>
            ×
          </button>
        </div>
      ) : null}
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
          <button className="tile" disabled={!!busy} onClick={() => picker.current?.click()}>
            <strong>Sign a PDF</strong>
            <span>Open the PDF, then tap Sign. Your signature stays on this phone.</span>
          </button>
          <button className="tile" disabled={!!busy} onClick={() => openAccount()}>
            <strong>Word ⇄ PDF</strong>
            <span>Convert on rokelapdf.com. Needs internet and a free account.</span>
          </button>
          {!native ? <p className="note">Preview in a browser: scanning and “Open with” need the Android app.</p> : null}
        </main>
      ) : null}

      {view ? (
        <>
          {placed ? <p className="hint">Tap the page where you want to sign. Drag to move; drag the corner to resize.</p> : null}
          <Viewer
            key={view.id}
            doc={view.pdf.doc}
            signing={
              placed && signature
                ? { placed, signature, onChange: (next) => setPlaced((old) => (typeof next === 'function' ? next(old ?? []) : next)) }
                : undefined
            }
          />
          <nav className="actions-bar">
            {placed ? (
              <>
                <button onClick={() => setPlaced(undefined)}>Cancel</button>
                <button onClick={() => setPad(true)}>New signature</button>
                <button className="primary" disabled={!!busy} onClick={() => void applySignatures(view)}>
                  Apply
                </button>
              </>
            ) : (
              <>
                <button disabled={!!busy} onClick={() => (signature ? startSigning(signature) : setPad(true))}>
                  Sign
                </button>
                <button disabled={!!busy} onClick={() => void toWord(view)}>
                  To Word
                </button>
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void run('Saving…', async () => {
                      if (await saveFile(view.file.name, view.file.bytes, PDF_MIME)) setNotice(`Saved ${view.file.name}.`);
                    })
                  }
                >
                  Save
                </button>
                <button disabled={!!busy} onClick={() => void run('Preparing…', () => shareFile(view.file.name, view.file.bytes, PDF_MIME))}>
                  Share
                </button>
              </>
            )}
          </nav>
        </>
      ) : null}

      {screen.k === 'convert' ? (
        <Convert
          session={session}
          busy={!!busy}
          onSignedIn={(s) => {
            setSession(s);
            if (screen.from) {
              setScreen(screen.from);
              void toWord(screen.from);
            }
          }}
          onSignOut={() =>
            void run('Signing out…', async () => {
              await signOut();
              setSession(null);
            })
          }
          run={run}
          onPdf={(f) => show(f)}
          onWord={(r) => setReady(r)}
        />
      ) : null}

      {pad ? <SignaturePad onCancel={() => setPad(false)} onDone={startSigning} /> : null}
    </div>
  );
}

function Convert(p: {
  session: Session | null | undefined;
  busy: boolean;
  onSignedIn: (s: Session) => void;
  onSignOut: () => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  onPdf: (f: PdfFile) => Promise<void>;
  onWord: (r: Ready) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const word = useRef<HTMLInputElement>(null);
  const pdf = useRef<HTMLInputElement>(null);

  if (p.session === undefined) return <p className="busy">Checking your account…</p>;
  if (!p.session) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void p.run('Signing in…', async () => p.onSignedIn(await signIn(email, password)));
    };
    return (
      <main className="home">
        <form className="card" onSubmit={submit}>
          <h2>Sign in to rokelapdf.com</h2>
          <p className="muted">Conversions run on Rokela PDF's servers. Files are converted and sent straight back; nothing is kept.</p>
          <label>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="primary" disabled={p.busy}>
            Sign in
          </button>
          <p className="muted">
            <a href={`${SITE}/signin?mode=signup`} target="_blank" rel="noreferrer">
              Create a free account
            </a>{' '}
            ·{' '}
            <a href={`${SITE}/signin?mode=forgot`} target="_blank" rel="noreferrer">
              Forgot password
            </a>
          </p>
        </form>
      </main>
    );
  }

  const read = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    return f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : undefined;
  };
  return (
    <main className="home">
      <p className="muted">Signed in as {p.session.user.email}.</p>
      <button className="tile primary" disabled={p.busy} onClick={() => word.current?.click()}>
        <strong>Word → PDF</strong>
        <span>Choose a .docx, .doc, .odt or .rtf file.</span>
      </button>
      <button className="tile" disabled={p.busy} onClick={() => pdf.current?.click()}>
        <strong>PDF → Word</strong>
        <span>Choose a PDF; you get an editable .docx.</span>
      </button>
      <button className="link" onClick={p.onSignOut}>
        Sign out
      </button>
      <input
        ref={word}
        type="file"
        hidden
        accept={[...WORD_EXTENSIONS.map((x) => `.${x}`), DOCX_MIME, 'application/msword'].join(',')}
        onChange={(e) =>
          void p.run('Converting to PDF… this can take a minute.', async () => {
            const f = await read(e);
            if (f) await p.onPdf({ name: renamed(f.name, 'pdf'), bytes: await convert('pdf', f.name, f.bytes) });
          })
        }
      />
      <input
        ref={pdf}
        type="file"
        hidden
        accept="application/pdf,.pdf"
        onChange={(e) =>
          void p.run('Converting to Word… this can take a minute.', async () => {
            const f = await read(e);
            if (!f) return;
            if (!isPdf(f.bytes)) throw new Error('That file is not a PDF.');
            p.onWord({ name: renamed(f.name, 'docx'), bytes: await convert('docx', f.name, f.bytes), mime: DOCX_MIME });
          })
        }
      />
    </main>
  );
}

interface Signing {
  placed: Placed[];
  signature: SignatureImage;
  onChange: (next: Placed[] | ((old: Placed[]) => Placed[])) => void;
}

/** Renders pages as they scroll into view, so long PDFs stay light on memory. */
function Viewer({ doc, signing }: { doc: PDFDocumentProxy; signing: Signing | undefined }) {
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  return (
    <main className="viewer">
      <p className="meta">
        {doc.numPages} page{doc.numPages === 1 ? '' : 's'}
      </p>
      {pages.map((n) => (
        <Page key={n} doc={doc} n={n} signing={signing} />
      ))}
    </main>
  );
}

function Page({ doc, n, signing }: { doc: PDFDocumentProxy; n: number; signing: Signing | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || done) return;
        io.disconnect();
        renderPage(doc, n, el, Math.min(el.parentElement!.clientWidth, 900)).then(
          () => setDone(true),
          () => undefined, // the document was closed mid-render
        );
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [doc, n, done]);
  return (
    <figure className="page">
      <canvas ref={canvas} aria-label={`Page ${n}`} />
      {signing && done ? <SignLayer page={n - 1} placed={signing.placed} signature={signing.signature} onChange={signing.onChange} /> : null}
    </figure>
  );
}
