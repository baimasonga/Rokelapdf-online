import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { App as Native } from '@capacitor/app';
import type { Session } from '@supabase/supabase-js';
import type { SignatureImage } from '@/lib/editor/signature';
import { compressPdf, fillForm, imagesToPdf, listFormFields, mergePdfs, type CompressLevel, type FormFieldInfo } from '@/lib/tools/ops';
import { protectPdf, unlockPdf } from '@/lib/tools/security';
import { browserRecoder, imageForPdf } from '@/lib/client/raster';
import { ocrPdf } from '@/lib/client/ocr';
import { MIME, PDF_MIME, isPdf, native, onIncoming, saveFile, scanDocument, shareFile, takeIncoming, type PdfFile } from './native';
import { PasswordRequired, openPdf, renderPage, type OpenPdf } from './pdf';
import { OFFICE_EXTENSIONS, SITE, convert, currentSession, renamed, signIn, signOut, type Target } from './account';
import { SignLayer, SignaturePad, signPdf, type Placed } from './sign';
import { COLORS, EditLayer, HINTS, TOOLS, TextSheet, editPdf, newItemId, type EditState, type Item, type Tool } from './edit';
import { Pages, organize, sheetsOf, type Sheet as PageSheet } from './pages';
import { CompressSheet, FormSheet, MoreSheet, ProtectSheet, UnlockSheet } from './tools';

type View = { k: 'view'; file: PdfFile; pdf: OpenPdf; id: number };
type Screen =
  | { k: 'home' }
  | View
  | { k: 'convert'; from?: View; then?: Target }
  | { k: 'pages'; from: View; sources: Uint8Array[]; docs: PDFDocumentProxy[]; extra: OpenPdf[]; sheets: PageSheet[] };
/** A file waiting for the person to save or share it (conversions, protected copies). */
interface Ready {
  name: string;
  bytes: Uint8Array;
  mime: string;
}
type Panel =
  | { k: 'more' }
  | { k: 'compress' }
  | { k: 'protect' }
  | { k: 'unlock'; file: PdfFile }
  | { k: 'form'; fields: FormFieldInfo[] }
  | { k: 'text'; item?: Item; at?: { page: number; u: number; v: number } };

let opened = 0;
const base = (name: string) => name.replace(/\.pdf$/i, '');
const suffixed = (name: string, suffix: string) => `${base(name)}-${suffix}.pdf`;
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const TARGET_LABEL: Record<Target, string> = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint' };

/** A picture for the Image tool: scaled to a sensible size and kept as PNG or JPEG for embedding. */
async function pictureFrom(file: File): Promise<{ src: string; aspect: number }> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('That file is not a picture this phone can read.');
  }
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const src = file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
  return { src, aspect: c.width / c.height };
}

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
  const [edit, setEdit] = useState<EditState>();
  const [panel, setPanel] = useState<Panel>();
  const picker = useRef<HTMLInputElement>(null);
  const many = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const extraPdf = useRef<HTMLInputElement>(null);
  const picture = useRef<HTMLInputElement>(null);

  /** Messages belong to the screen they were shown on; clear them whenever the screen changes. */
  const clearMessages = useCallback(() => {
    setError(undefined);
    setNotice(undefined);
  }, []);

  const show = useCallback(
    async (file: PdfFile) => {
      clearMessages();
      setPlaced(undefined);
      setEdit(undefined);
      let pdf: OpenPdf;
      try {
        pdf = await openPdf(file.bytes);
      } catch (e) {
        if (e instanceof PasswordRequired) return setPanel({ k: 'unlock', file });
        throw e;
      }
      setScreen((old) => {
        if (old.k === 'view') void old.pdf.close();
        if (old.k === 'convert' && old.from) void old.from.pdf.close();
        if (old.k === 'pages') {
          void old.from.pdf.close();
          old.extra.forEach((d) => void d.close());
        }
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
    setEdit(undefined);
    if (screen.k === 'convert' && screen.from) return setScreen(screen.from);
    if (screen.k === 'pages') {
      screen.extra.forEach((d) => void d.close());
      return setScreen(screen.from);
    }
    if (screen.k === 'view') void screen.pdf.close();
    setScreen({ k: 'home' });
  };

  // Android's Back button: close what is open (sheet, signing, editing), then go back a screen; exit only from home.
  const onBack = useRef<() => boolean>(() => false);
  onBack.current = () => {
    if (busy) return true;
    if (pad) return (setPad(false), true);
    if (panel) return (setPanel(undefined), true);
    if (placed) return (setPlaced(undefined), true);
    if (edit) return (setEdit(undefined), true);
    if (screen.k !== 'home') return (back(), true);
    return false;
  };
  useEffect(() => {
    if (!native) return;
    const sub = Native.addListener('backButton', () => {
      if (!onBack.current()) void Native.exitApp();
    });
    return () => void sub.then((h) => h.remove());
  }, []);

  const openAccount = (from?: View, then?: Target) => {
    clearMessages();
    setSession(undefined);
    setScreen({ k: 'convert', ...(from ? { from } : {}), ...(then ? { then } : {}) });
    void currentSession().then(setSession, (e: Error) => {
      setSession(null);
      setError(e.message);
    });
  };

  const readFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    return Promise.all(files.map(async (f) => ({ name: f.name, file: f, bytes: new Uint8Array(await f.arrayBuffer()) })));
  };
  const pick = (e: ChangeEvent<HTMLInputElement>) =>
    void run('Opening…', async () => {
      const [f] = await readFiles(e);
      if (!f) return;
      if (!isPdf(f.bytes)) throw new Error('That file is not a PDF.');
      await show({ name: f.name, bytes: f.bytes });
    });
  const combine = (e: ChangeEvent<HTMLInputElement>) =>
    void run('Combining…', async () => {
      const files = await readFiles(e);
      if (!files.length) return;
      if (files.length < 2) throw new Error('Choose two or more PDFs to combine.');
      if (files.some((f) => !isPdf(f.bytes))) throw new Error('Choose PDF files only.');
      await show({ name: 'combined.pdf', bytes: await mergePdfs(files.map((f) => f.bytes)) });
      setNotice(`Combined ${files.length} PDFs. Save or share the result.`);
    });
  const fromPhotos = (e: ChangeEvent<HTMLInputElement>) =>
    void run('Making a PDF…', async () => {
      const files = await readFiles(e);
      if (!files.length) return;
      const images = [];
      for (const f of files) images.push(await imageForPdf(f.file));
      await show({
        name: files.length === 1 ? renamed(files[0]!.name, 'pdf') : 'photos.pdf',
        bytes: await imagesToPdf(images, { pageSize: 'A4', orientation: 'auto', margin: 24 }),
      });
      setNotice(`Made a PDF from ${files.length} picture${files.length === 1 ? '' : 's'}.`);
    });

  const exportTo = (v: View, target: Exclude<Target, 'pdf'>) =>
    run(`Converting to ${TARGET_LABEL[target]}… this can take a minute.`, async () => {
      if (!(await currentSession())) return openAccount(v, target);
      const bytes = await convert(target, v.file.name, v.file.bytes);
      setReady({ name: renamed(v.file.name, target), bytes, mime: MIME[target] });
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
      await show({ name: suffixed(v.file.name, 'signed'), bytes });
      setNotice('Signed. Save or share the signed copy.');
    });
  const applyEdits = (v: View) =>
    run('Saving your changes…', async () => {
      if (!edit?.items.length) throw new Error('Nothing to save yet. Choose a tool and tap the page.');
      const bytes = await editPdf(v.file.bytes, v.pdf.doc, edit.items);
      await show({ name: suffixed(v.file.name, 'edited'), bytes });
      setNotice('Changes saved into the PDF. Save or share the edited copy.');
    });
  const chooseTool = (tool: Tool) => {
    setEdit((e) => (e ? { ...e, tool } : e));
    if (tool === 'image') picture.current?.click();
  };
  const onPicture = (e: ChangeEvent<HTMLInputElement>) =>
    void run('Preparing the picture…', async () => {
      const [f] = await readFiles(e);
      if (!f) return;
      const pic = await pictureFrom(f.file);
      setEdit((s) => (s ? { ...s, tool: 'image', picture: pic } : s));
    });

  const openPages = (v: View) => {
    clearMessages();
    setScreen({ k: 'pages', from: v, sources: [v.file.bytes], docs: [v.pdf.doc], extra: [], sheets: sheetsOf(0, v.pdf.doc.numPages) });
  };
  const addPages = (e: ChangeEvent<HTMLInputElement>) =>
    void run('Adding pages…', async () => {
      const [f] = await readFiles(e);
      if (!f || screen.k !== 'pages') return;
      if (!isPdf(f.bytes)) throw new Error('That file is not a PDF.');
      const d = await openPdf(f.bytes);
      const src = screen.sources.length;
      setScreen({
        ...screen,
        sources: [...screen.sources, f.bytes],
        docs: [...screen.docs, d.doc],
        extra: [...screen.extra, d],
        sheets: [...screen.sheets, ...sheetsOf(src, d.doc.numPages)],
      });
    });
  const applyPages = () =>
    run('Saving pages…', async () => {
      if (screen.k !== 'pages') return;
      const bytes = await organize(screen.sources, screen.sheets);
      await show({ name: suffixed(screen.from.file.name, 'pages'), bytes });
      setNotice(`Saved ${screen.sheets.length} page${screen.sheets.length === 1 ? '' : 's'}. Save or share the new PDF.`);
    });

  const compress = (v: View, level: CompressLevel) =>
    run('Compressing…', async () => {
      setPanel(undefined);
      const r = await compressPdf(v.file.bytes, level, browserRecoder);
      if (r.after >= r.before) return setNotice('This PDF is already as small as it can be made.');
      await show({ name: suffixed(v.file.name, 'compressed'), bytes: r.bytes });
      setNotice(`${Math.round((1 - r.after / r.before) * 100)}% smaller: ${size(r.before)} → ${size(r.after)}. Save or share it.`);
    });
  const protect = (v: View, o: Parameters<typeof protectPdf>[1]) =>
    run('Protecting…', async () => {
      setPanel(undefined);
      const bytes = await protectPdf(v.file.bytes, o);
      setReady({ name: suffixed(v.file.name, 'protected'), bytes, mime: PDF_MIME });
      setNotice('Protected. It now needs the password to open.');
    });
  const unlock = (file: PdfFile, password: string) =>
    run('Unlocking…', async () => {
      const bytes = await unlockPdf(file.bytes, password);
      setPanel(undefined);
      await show({ name: suffixed(file.name, 'unlocked'), bytes });
      setNotice('Unlocked copy. The original file is unchanged.');
    });
  const ocr = (v: View) =>
    run('Preparing to read the pages…', async () => {
      const r = await ocrPdf(v.file.bytes, (p) => setBusy(p.stage === 'loading' ? 'Loading the text reader…' : `Reading page ${p.page} of ${p.pages}…`));
      if (!r.words) return setNotice(r.pagesSkipped ? 'This PDF already has text you can search and copy.' : 'No text was found on these pages.');
      await show({ name: suffixed(v.file.name, 'searchable'), bytes: r.bytes });
      setNotice(`Found ${r.words} words. You can now search and copy the text.`);
    });
  const form = (v: View) =>
    run('Looking for form fields…', async () => {
      const fields = await listFormFields(v.file.bytes);
      if (!fields.some((f) => !f.readOnly)) throw new Error('This PDF has no fillable fields. Use Edit → Text to type on it.');
      setPanel({ k: 'form', fields });
    });
  const fill = (v: View, values: Record<string, string | boolean>, flatten: boolean) =>
    run('Filling in…', async () => {
      setPanel(undefined);
      await show({ name: suffixed(v.file.name, 'filled'), bytes: await fillForm(v.file.bytes, values, flatten) });
      setNotice('Form filled in. Save or share it.');
    });

  const view = screen.k === 'view' ? screen : undefined;
  const title = view ? view.file.name : screen.k === 'convert' ? 'Convert' : screen.k === 'pages' ? 'Pages' : 'Rokela PDF';
  const busyOr = !!busy;

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
      <div className="messages">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="notice">{notice}</p> : null}
        {busy ? (
          <p className="busy" role="status">
            {busy}
          </p>
        ) : null}
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
      </div>
      <input ref={picker} type="file" accept="application/pdf,.pdf" hidden onChange={pick} />
      <input ref={many} type="file" accept="application/pdf,.pdf" multiple hidden onChange={combine} />
      <input ref={photos} type="file" accept="image/*" multiple hidden onChange={fromPhotos} />
      <input ref={extraPdf} type="file" accept="application/pdf,.pdf" hidden onChange={addPages} />
      <input ref={picture} type="file" accept="image/*" hidden onChange={onPicture} />

      {screen.k === 'home' ? (
        <main className="home">
          <button
            className="tile primary"
            disabled={busyOr}
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
          <button className="tile" disabled={busyOr} onClick={() => picker.current?.click()}>
            <strong>Open a PDF</strong>
            <span>Then sign, edit, organize pages, compress, protect and more.</span>
          </button>
          <div className="grid2">
            <Tile label="Combine PDFs" hint="Join several PDFs into one" disabled={busyOr} onClick={() => many.current?.click()} />
            <Tile label="Photos → PDF" hint="Turn pictures into a PDF" disabled={busyOr} onClick={() => photos.current?.click()} />
            <Tile label="Office → PDF" hint="Word, Excel or PowerPoint" disabled={busyOr} onClick={() => openAccount()} />
            <Tile label="PDF → Office" hint="Word, Excel or PowerPoint" disabled={busyOr} onClick={() => openAccount()} />
          </div>
          {!native ? <p className="note">Preview in a browser: scanning and “Open with” need the Android app.</p> : null}
        </main>
      ) : null}

      {view ? (
        <>
          {placed ? <p className="hint">Tap the page where you want to sign. Drag to move; drag the corner to resize.</p> : null}
          {edit ? (
            <div className="edit-tools">
              <div className="tool-row" role="radiogroup" aria-label="Edit tool">
                {TOOLS.map(([t, label]) => (
                  <button key={t} role="radio" aria-checked={edit.tool === t} className={edit.tool === t ? 'on' : ''} onClick={() => chooseTool(t)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="tool-row small">
                {edit.tool === 'draw' ? (
                  <span className="swatches" role="radiogroup" aria-label="Ink colour">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        role="radio"
                        aria-checked={edit.color === c}
                        aria-label={`Colour ${c}`}
                        className={`swatch${edit.color === c ? ' on' : ''}`}
                        style={{ background: c }}
                        onClick={() => setEdit({ ...edit, color: c })}
                      />
                    ))}
                  </span>
                ) : (
                  <span className="muted">{edit.tool === 'image' && !edit.picture ? 'Choose a picture first.' : HINTS[edit.tool]}</span>
                )}
                <button className="link" disabled={!edit.items.length} onClick={() => setEdit({ ...edit, items: edit.items.slice(0, -1) })}>
                  Undo
                </button>
              </div>
            </div>
          ) : null}
          <Viewer
            key={view.id}
            doc={view.pdf.doc}
            layer={(page) =>
              placed && signature ? (
                <SignLayer
                  page={page}
                  placed={placed}
                  signature={signature}
                  onChange={(next) => setPlaced((old) => (typeof next === 'function' ? next(old ?? []) : next))}
                />
              ) : edit ? (
                <EditLayer
                  page={page}
                  state={edit}
                  onChange={(fn) => setEdit((s) => (s ? { ...s, items: fn(s.items) } : s))}
                  onText={(t) => setPanel('id' in t ? { k: 'text', item: t } : { k: 'text', at: t })}
                />
              ) : null
            }
          />
          <nav className="actions-bar">
            {placed ? (
              <>
                <button onClick={() => setPlaced(undefined)}>Cancel</button>
                <button onClick={() => setPad(true)}>New signature</button>
                <button className="primary" disabled={busyOr} onClick={() => void applySignatures(view)}>
                  Apply
                </button>
              </>
            ) : edit ? (
              <>
                <button onClick={() => setEdit(undefined)}>Cancel</button>
                <button className="primary" disabled={busyOr} onClick={() => void applyEdits(view)}>
                  Save changes
                </button>
              </>
            ) : (
              <>
                <button disabled={busyOr} onClick={() => (signature ? startSigning(signature) : setPad(true))}>
                  Sign
                </button>
                <button disabled={busyOr} onClick={() => setEdit({ tool: 'text', color: COLORS[0]!, size: 0.03, items: [] })}>
                  Edit
                </button>
                <button disabled={busyOr} onClick={() => openPages(view)}>
                  Pages
                </button>
                <button disabled={busyOr} onClick={() => setPanel({ k: 'more' })}>
                  More
                </button>
              </>
            )}
          </nav>
        </>
      ) : null}

      {screen.k === 'pages' ? (
        <>
          <p className="hint">Use ‹ › to move pages, ↻ to rotate and ✕ to delete.</p>
          <Pages docs={screen.docs} sheets={screen.sheets} onChange={(sheets) => setScreen({ ...screen, sheets })} />
          <nav className="actions-bar">
            <button disabled={busyOr} onClick={() => extraPdf.current?.click()}>
              Add a PDF
            </button>
            <button className="primary" disabled={busyOr} onClick={() => void applyPages()}>
              Save pages
            </button>
          </nav>
        </>
      ) : null}

      {screen.k === 'convert' ? (
        <Convert
          session={session}
          busy={busyOr}
          onSignedIn={(s) => {
            setSession(s);
            if (screen.from) {
              setScreen(screen.from);
              if (screen.then && screen.then !== 'pdf') void exportTo(screen.from, screen.then);
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
          onOffice={(r) => setReady(r)}
        />
      ) : null}

      {pad ? <SignaturePad onCancel={() => setPad(false)} onDone={startSigning} /> : null}
      {panel?.k === 'more' && view ? (
        <MoreSheet
          onClose={() => setPanel(undefined)}
          groups={[
            [
              'Keep',
              [
                {
                  label: 'Save to phone',
                  run: () =>
                    void run('Saving…', async () => {
                      if (await saveFile(view.file.name, view.file.bytes, PDF_MIME)) setNotice(`Saved ${view.file.name}.`);
                    }),
                },
                {
                  label: 'Share',
                  hint: 'WhatsApp, email, Drive…',
                  run: () => void run('Preparing…', () => shareFile(view.file.name, view.file.bytes, PDF_MIME)),
                },
              ],
            ],
            [
              'Convert (needs internet and a free account)',
              [
                { label: 'To Word', run: () => void exportTo(view, 'docx') },
                { label: 'To Excel', run: () => void exportTo(view, 'xlsx') },
                { label: 'To PowerPoint', run: () => void exportTo(view, 'pptx') },
              ],
            ],
            [
              'Tools (on this phone)',
              [
                { label: 'Compress', hint: 'Make the file smaller to send', run: () => setPanel({ k: 'compress' }) },
                { label: 'Protect with a password', run: () => setPanel({ k: 'protect' }) },
                { label: 'Make text searchable', hint: 'Read the text in scans (OCR)', run: () => void ocr(view) },
                { label: 'Fill in a form', run: () => void form(view) },
              ],
            ],
          ]}
        />
      ) : null}
      {panel?.k === 'compress' && view ? <CompressSheet onClose={() => setPanel(undefined)} onPick={(level) => void compress(view, level)} /> : null}
      {panel?.k === 'protect' && view ? <ProtectSheet onClose={() => setPanel(undefined)} onDone={(o) => void protect(view, o)} /> : null}
      {panel?.k === 'unlock' ? <UnlockSheet name={panel.file.name} onClose={() => setPanel(undefined)} onDone={(pw) => void unlock(panel.file, pw)} /> : null}
      {panel?.k === 'form' && view ? (
        <FormSheet fields={panel.fields} onClose={() => setPanel(undefined)} onDone={(values, flatten) => void fill(view, values, flatten)} />
      ) : null}
      {panel?.k === 'text' && edit ? (
        <TextSheet
          initial={panel.item?.kind === 'text' ? panel.item.text : ''}
          color={panel.item?.color ?? edit.color}
          size={panel.item?.kind === 'text' ? panel.item.size : edit.size}
          onCancel={() => setPanel(undefined)}
          onDelete={panel.item ? () => (setEdit({ ...edit, items: edit.items.filter((x) => x.id !== panel.item!.id) }), setPanel(undefined)) : undefined}
          onDone={(text, color, sz) => {
            const item = panel.item;
            if (item?.kind === 'text')
              setEdit({ ...edit, color, size: sz, items: edit.items.map((x) => (x.id === item.id ? { ...item, text, color, size: sz } : x)) });
            else if (panel.at)
              setEdit({ ...edit, color, size: sz, items: [...edit.items, { id: newItemId(), kind: 'text', ...panel.at, text, color, size: sz }] });
            setPanel(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

function Tile({ label, hint, disabled, onClick }: { label: string; hint: string; disabled: boolean; onClick: () => void }) {
  return (
    <button className="tile" disabled={disabled} onClick={onClick}>
      <strong>{label}</strong>
      <span>{hint}</span>
    </button>
  );
}

function Convert(p: {
  session: Session | null | undefined;
  busy: boolean;
  onSignedIn: (s: Session) => void;
  onSignOut: () => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  onPdf: (f: PdfFile) => Promise<void>;
  onOffice: (r: Ready) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [target, setTarget] = useState<Exclude<Target, 'pdf'>>('docx');
  const office = useRef<HTMLInputElement>(null);
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
  const fromPdf = (t: Exclude<Target, 'pdf'>) => {
    setTarget(t);
    pdf.current?.click();
  };
  return (
    <main className="home">
      <p className="muted">Signed in as {p.session.user.email}.</p>
      <button className="tile primary" disabled={p.busy} onClick={() => office.current?.click()}>
        <strong>Word, Excel or PowerPoint → PDF</strong>
        <span>Choose a .docx, .xlsx, .pptx (or .doc, .xls, .ppt, .odt, .rtf…) file.</span>
      </button>
      <div className="grid3">
        <Tile label="PDF → Word" hint=".docx" disabled={p.busy} onClick={() => fromPdf('docx')} />
        <Tile label="PDF → Excel" hint=".xlsx" disabled={p.busy} onClick={() => fromPdf('xlsx')} />
        <Tile label="PDF → PowerPoint" hint=".pptx" disabled={p.busy} onClick={() => fromPdf('pptx')} />
      </div>
      <button className="link" onClick={p.onSignOut}>
        Sign out
      </button>
      <input
        ref={office}
        type="file"
        hidden
        accept={OFFICE_EXTENSIONS.map((x) => `.${x}`).join(',')}
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
          void p.run(`Converting to ${TARGET_LABEL[target]}… this can take a minute.`, async () => {
            const f = await read(e);
            if (!f) return;
            if (!isPdf(f.bytes)) throw new Error('That file is not a PDF.');
            p.onOffice({ name: renamed(f.name, target), bytes: await convert(target, f.name, f.bytes), mime: MIME[target] });
          })
        }
      />
    </main>
  );
}

/** Renders pages as they scroll into view, so long PDFs stay light on memory. */
function Viewer({ doc, layer }: { doc: PDFDocumentProxy; layer: (page: number) => ReactNode }) {
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  return (
    <main className="viewer">
      <p className="meta">
        {doc.numPages} page{doc.numPages === 1 ? '' : 's'}
      </p>
      {pages.map((n) => (
        <Page key={n} doc={doc} n={n} layer={layer} />
      ))}
    </main>
  );
}

function Page({ doc, n, layer }: { doc: PDFDocumentProxy; n: number; layer: (page: number) => ReactNode }) {
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
      {done ? layer(n - 1) : null}
    </figure>
  );
}
