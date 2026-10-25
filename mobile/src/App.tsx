import { createUsageReporter } from './analytics';
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { App as Native } from '@capacitor/app';
import type { Session } from '@supabase/supabase-js';
import type { SignatureImage } from '@/lib/editor/signature';
import {
  compressPdf,
  fillForm,
  imagesToPdf,
  listFormFields,
  mergePdfs,
  pageCount,
  splitPdf,
  type CompressLevel,
  type FormFieldInfo,
  type SplitMode,
} from '@/lib/tools/ops';
import { protectPdf, unlockPdf } from '@/lib/tools/security';
import { browserRecoder, imageForPdf } from '@/lib/client/raster';
import { ocrPdf } from '@/lib/client/ocr';
import {
  ArrowLeft,
  Camera,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  Combine,
  Download,
  EllipsisVertical,
  FileInput,
  FileOutput,
  FilePenLine,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Grid2x2,
  Images,
  LayoutGrid,
  Lock,
  LogOut,
  PenTool,
  Plus,
  Presentation,
  RotateCw,
  ScanText,
  Scissors,
  Share2,
  Shrink,
  Signature,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { norm } from '@/lib/editor/model';
import { MIME, PDF_MIME, isPdf, native, onIncoming, saveFile, scanDocument, shareFile, shareFiles, takeIncoming, type PdfFile } from './native';
import { PasswordRequired, openPdf, renderPage, type OpenPdf } from './pdf';
import { OFFICE_EXTENSIONS, SITE, convert, currentSession, renamed, signIn, signOut, type Target } from './account';
import { SignLayer, SignaturePad, signPdf, type Placed } from './sign';
import { COLORS, EditLayer, HINTS, TOOLS, TextSheet, editPdf, newItemId, type EditState, type Item, type Tool } from './edit';
import { Pages, moveSelected, organize, sheetsOf, type Sheet as PageSheet } from './pages';
import { CompressSheet, FormSheet, PaidSheet, PartsSheet, ProtectSheet, SplitSheet, ToolsSheet, UnlockSheet, type Part } from './tools';
import { paidBlock, type Why } from './access';
import type { PaidFeature } from '@/lib/licensing';
import { AppBar, BarButton, IconButton, Progress, Row, Sheet, ToolTile, type ToolDef } from './ui';
import { RECENT_MAX, forget, openRecent, recentFiles, remember, type Recent } from './recent';
import logo from '@/../public/brand/rokela-icon.png';

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
/** Tools that work on an open PDF; from the home screen they first ask for the file. */
type FileTool = 'edit' | 'sign' | 'organize' | 'split' | 'compress' | 'protect' | 'ocr' | 'form' | 'export';
/** File tools that are paid (src/lib/licensing.ts). Combining and adding another PDF's pages are merging. */
const TOOL_FEATURE: Partial<Record<FileTool, PaidFeature>> = { edit: 'edit', sign: 'sign', split: 'split', protect: 'protect', ocr: 'ocr' };
type Panel =
  | { k: 'tools' }
  | { k: 'export' }
  | { k: 'compress' }
  | { k: 'split' }
  | { k: 'parts'; parts: Part[] }
  | { k: 'paid'; feature: PaidFeature; why: Why }
  | { k: 'protect' }
  | { k: 'unlock'; file: PdfFile }
  | { k: 'form'; fields: FormFieldInfo[] }
  | { k: 'text'; item?: Item; at?: { page: number; u: number; v: number } };

let opened = 0;
const base = (name: string) => name.replace(/\.pdf$/i, '');
const suffixed = (name: string, suffix: string) => `${base(name)}-${suffix}.pdf`;
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const TARGET_LABEL: Record<Target, string> = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint' };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
function when(at: number) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `Today ${time}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
/** Colours of the round tool icons: one hue per kind of task, so tools are easy to find again. */
const C = {
  scan: '#e2483d',
  edit: '#2f6fdb',
  sign: '#c2185b',
  organize: '#1e8a5a',
  combine: '#0e9aa7',
  compress: '#e8890c',
  protect: '#0f1f3d',
  ocr: '#7a4fd8',
  create: '#d9468f',
  export: '#6b4fd8',
  form: '#3a7d44',
};

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
  const [version, setVersion] = useState<string>();
  const usage = useRef<ReturnType<typeof createUsageReporter> | undefined>(undefined);
  const [usageEnabled, setUsageEnabled] = useState(true);
  const trackUsage = (feature: Parameters<ReturnType<typeof createUsageReporter>['track']>[0]) => {
    if (!native) return;
    const major = /Android (\d{1,2})(?:[.; ]|$)/.exec(navigator.userAgent)?.[1];
    usage.current?.track(
      feature,
      version ?? '0',
      major ? Number(major) : null,
      Math.min(window.screen.width, window.screen.height) >= 600 ? 'tablet' : 'phone',
    );
  };
  useEffect(() => {
    if (!native) return;
    try {
      usage.current = createUsageReporter({ storage: localStorage });
    } catch {
      setUsageEnabled(false);
      return;
    }
    setUsageEnabled(usage.current.enabled());
    void Native.getInfo().then(
      (info) => {
        const major = /Android (\d{1,2})(?:[.; ]|$)/.exec(navigator.userAgent)?.[1];
        usage.current?.track(
          'app_open',
          info.version,
          major ? Number(major) : null,
          Math.min(window.screen.width, window.screen.height) >= 600 ? 'tablet' : 'phone',
        );
      },
      () => undefined,
    );
    const retry = () => {
      void usage.current?.flush();
    };
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 60000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', retry);
    };
  }, []);

  const [recent, setRecent] = useState<Recent[]>(() => recentFiles());
  const [pending, setPending] = useState<FileTool>();
  /** The tool a home-screen tile asked for; it belongs to the next file picked, and only to that. */
  const pickingFor = useRef<FileTool>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
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
      void remember(file, pdf.doc.numPages).then(setRecent);
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

  /** Runs a paid tool after the access check; otherwise says why it cannot run yet. */
  const paid = async (feature: PaidFeature, go: () => void) => {
    setBusy('Checking your access…');
    let why: Why | undefined;
    try {
      why = await paidBlock();
    } finally {
      setBusy(undefined);
    }
    if (why) setPanel({ k: 'paid', feature, why });
    else go();
  };

  // The installed build, shown on the home screen so testers can tell which version they have.
  useEffect(() => {
    if (native)
      void Native.getInfo().then(
        (i) => setVersion(i.version),
        () => undefined,
      );
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
      setSelected(new Set());
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
    if (screen.k === 'pages' && selected.size) return (setSelected(new Set()), true);
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
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const tool = pickingFor.current;
    pickingFor.current = undefined;
    void run('Opening…', async () => {
      const [f] = await readFiles(e);
      if (!f) return;
      if (!isPdf(f.bytes)) throw new Error('That file is not a PDF.');
      await show({ name: f.name, bytes: f.bytes });
      if (tool) setPending(tool);
    });
  };
  /** Opens the file picker for a plain "Open"; a tool picked earlier and then cancelled no longer applies. */
  const openPicker = () => {
    pickingFor.current = undefined;
    picker.current?.click();
  };
  const combine = (e: ChangeEvent<HTMLInputElement>) => {
    const reading = readFiles(e);
    void paid('merge', () => void combineNow(reading));
  };
  const combineNow = (reading: ReturnType<typeof readFiles>) =>
    run('Combining…', async () => {
      const files = await reading;
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
    setSelected(new Set());
    setScreen({ k: 'pages', from: v, sources: [v.file.bytes], docs: [v.pdf.doc], extra: [], sheets: sheetsOf(0, v.pdf.doc.numPages) });
  };
  const addPages = (e: ChangeEvent<HTMLInputElement>) => {
    const reading = readFiles(e);
    void paid('merge', () => void addPagesNow(reading));
  };
  const addPagesNow = (reading: ReturnType<typeof readFiles>) =>
    run('Adding pages…', async () => {
      const [f] = await reading;
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
  const editSheets = (fn: (sheets: PageSheet[]) => PageSheet[]) => {
    if (screen.k === 'pages') setScreen({ ...screen, sheets: fn(screen.sheets) });
  };
  const deleteSelected = () => {
    if (screen.k !== 'pages') return;
    if (selected.size >= screen.sheets.length) return setError('A PDF needs at least one page. Keep one page or go back.');
    editSheets((all) => all.filter((x) => !selected.has(x.key)));
    setSelected(new Set());
  };
  const applyPages = () =>
    run('Saving pages…', async () => {
      if (screen.k !== 'pages') return;
      setSelected(new Set());
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
  const split = (v: View, mode: SplitMode) =>
    run('Splitting…', async () => {
      const made = await splitPdf(v.file.bytes, mode, v.file.name.replace(/\.pdf$/i, ''));
      // Recent keeps RECENT_MAX files; more parts would push the first ones out (and off the phone).
      if (made.length > RECENT_MAX)
        throw new Error(`That makes ${made.length} files. Split into ${RECENT_MAX} or fewer at a time, so every part is kept in Recent.`);
      const parts = await Promise.all(made.map(async (p) => ({ ...p, pages: await pageCount(p.bytes) })));
      // Every part goes into Recent, so none is lost when another one is opened.
      for (const p of parts) setRecent(await remember({ name: p.name, bytes: p.bytes }, p.pages));
      setPanel({ k: 'parts', parts });
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
      const r = await ocrPdf(
        v.file.bytes,
        (p) => setBusy(p.stage === 'loading' ? 'Loading the text reader…' : `Reading page ${p.page} of ${p.pages}…`),
        'eng',
        { gzip: false },
      );
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

  const startTool = (v: View, tool: FileTool) => {
    const feature = TOOL_FEATURE[tool];
    if (feature) void paid(feature, () => openTool(v, tool));
    else openTool(v, tool);
  };
  const openTool = (v: View, tool: FileTool) => {
    if (tool === 'edit') setEdit({ tool: 'text', color: COLORS[0]!, size: 0.03, items: [] });
    else if (tool === 'sign') {
      if (signature) startSigning(signature);
      else setPad(true);
    } else if (tool === 'organize') openPages(v);
    else if (tool === 'split') setPanel({ k: 'split' });
    else if (tool === 'compress') setPanel({ k: 'compress' });
    else if (tool === 'protect') setPanel({ k: 'protect' });
    else if (tool === 'ocr') void ocr(v);
    else if (tool === 'form') void form(v);
    else setPanel({ k: 'export' });
  };
  const withFile = (tool: FileTool) => {
    pickingFor.current = tool;
    picker.current?.click();
  };
  // A tool chosen on the home screen starts as soon as its PDF is open.
  useEffect(() => {
    if (pending && screen.k === 'view') {
      setPending(undefined);
      startTool(screen, pending);
    }
  }, [pending, screen]); // eslint-disable-line react-hooks/exhaustive-deps
  const scan = () =>
    void run('Opening the scanner…', async () => {
      const f = await scanDocument();
      if (f) await show(f);
    });

  const view = screen.k === 'view' ? screen : undefined;
  const busyOr = !!busy;
  const keep = view
    ? [
        {
          label: 'Save to phone',
          icon: Download,
          run: () =>
            void run('Saving…', async () => {
              if (await saveFile(view.file.name, view.file.bytes, PDF_MIME)) setNotice(`Saved ${view.file.name}.`);
            }),
        },
        { label: 'Share', icon: Share2, run: () => void run('Preparing…', () => shareFile(view.file.name, view.file.bytes, PDF_MIME)) },
      ]
    : [];
  const fileTools = (go: (t: FileTool) => void): ToolDef[] => [
    { id: 'edit', label: 'Edit PDF', icon: FilePenLine, color: C.edit, run: () => go('edit') },
    { id: 'sign', label: 'Fill & Sign', icon: Signature, color: C.sign, run: () => go('sign') },
    { id: 'organize', label: 'Organize pages', icon: LayoutGrid, color: C.organize, run: () => go('organize') },
    { id: 'split', label: 'Split', icon: Scissors, color: C.organize, run: () => go('split') },
    { id: 'compress', label: 'Compress', icon: Shrink, color: C.compress, run: () => go('compress') },
    { id: 'protect', label: 'Protect', icon: Lock, color: C.protect, run: () => go('protect') },
    { id: 'ocr', label: 'Make text searchable', icon: ScanText, color: C.ocr, run: () => go('ocr') },
    { id: 'form', label: 'Fill in a form', icon: ClipboardList, color: C.form, run: () => go('form') },
    { id: 'export', label: 'Export PDF', icon: FileOutput, color: C.export, run: () => go('export') },
  ];
  const homeTools: ToolDef[] = [
    { id: 'scan', label: 'Scan', icon: Camera, color: C.scan, run: scan },
    ...fileTools(withFile),
    { id: 'combine', label: 'Combine files', icon: Combine, color: C.combine, run: () => many.current?.click() },
    { id: 'photos', label: 'Photos to PDF', icon: Images, color: C.create, run: () => photos.current?.click() },
    { id: 'office', label: 'Office to PDF', icon: FileInput, color: C.edit, run: () => openAccount() },
  ];
  const snack = error ? (
    <div className="snackbar error" role="alert">
      <span>{error}</span>
      <button className="snack-close" aria-label="Dismiss" onClick={() => setError(undefined)}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  ) : ready ? (
    <div className="snackbar ready" role="status">
      <span>{ready.name} is ready.</span>
      <button
        onClick={() =>
          void run('Saving…', async () => {
            // Keep the file when the Save-to dialog is cancelled: this bar may be the only way to get it.
            if (await saveFile(ready.name, ready.bytes, ready.mime)) {
              setNotice(`Saved ${ready.name}.`);
              setReady(undefined);
            }
          })
        }
      >
        Save
      </button>
      <button onClick={() => void run('Preparing…', () => shareFile(ready.name, ready.bytes, ready.mime))}>Share</button>
      <button className="snack-close" aria-label="Dismiss" onClick={() => setReady(undefined)}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  ) : notice ? (
    <div className="snackbar notice" role="status">
      <span>{notice}</span>
      <button className="snack-close" aria-label="Dismiss" onClick={() => setNotice(undefined)}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  ) : null;

  return (
    <div className={`app screen-${screen.k}${panel || pad ? ' has-sheet' : ''}`}>
      <input ref={picker} type="file" accept="application/pdf,.pdf" hidden onChange={pick} />
      <input ref={many} type="file" accept="application/pdf,.pdf" multiple hidden onChange={combine} />
      <input ref={photos} type="file" accept="image/*" multiple hidden onChange={fromPhotos} />
      <input ref={extraPdf} type="file" accept="application/pdf,.pdf" hidden onChange={addPages} />
      <input ref={picture} type="file" accept="image/*" hidden onChange={onPicture} />

      {screen.k === 'home' ? (
        <>
          <AppBar
            left={<img className="appbar-logo" src={logo} alt="" />}
            title="Rokela PDF"
            right={<IconButton icon={FolderOpen} label="Open a PDF" onClick={openPicker} disabled={busyOr} />}
          />
          <main className="home">
            <section aria-labelledby="tools-h">
              <h2 id="tools-h" className="section-title">
                Tools
              </h2>
              <div className="tool-grid">
                {homeTools.map((t) => (
                  <ToolTile
                    key={t.id}
                    tool={{
                      ...t,
                      run: () => {
                        const features: Record<string, Parameters<typeof trackUsage>[0]> = {
                          scan: 'scan',
                          edit: 'edit',
                          sign: 'sign',
                          organize: 'pages',
                          split: 'pages',
                          compress: 'compress',
                          protect: 'protect',
                          ocr: 'ocr',
                          form: 'fill',
                          export: 'convert',
                          combine: 'merge',
                          photos: 'photos',
                          office: 'convert',
                        };
                        trackUsage(features[t.id] ?? 'open');
                        t.run();
                      },
                    }}
                    disabled={busyOr}
                  />
                ))}
              </div>
            </section>
            <section aria-labelledby="recent-h">
              <h2 id="recent-h" className="section-title">
                Recent
              </h2>
              {recent.length ? (
                <div className="list">
                  {recent.map((f) => (
                    <Row
                      key={f.id}
                      icon={FileText}
                      iconColor={C.scan}
                      title={f.name}
                      detail={`${plural(f.pages, 'page')} · ${size(f.size)} · ${when(f.at)}`}
                      onClick={() =>
                        void run('Opening…', async () => {
                          await show(await openRecent(f.id));
                        })
                      }
                      trailing={<IconButton icon={X} label={`Remove ${f.name} from Recent`} onClick={() => void forget(f.id).then(setRecent)} />}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <Clock size={32} aria-hidden="true" />
                  <p>Files you open, scan or create appear here.</p>
                  <button className="primary pill" onClick={openPicker}>
                    Open a PDF
                  </button>
                </div>
              )}
            </section>
            {!native ? <p className="note">Preview in a browser: scanning and “Open with” need the Android app.</p> : null}
            {version ? <p className="version">Version {version}</p> : null}
            {native ? (
              <section aria-label="Usage privacy" className="note">
                <label>
                  <input
                    type="checkbox"
                    checked={usageEnabled}
                    onChange={(e) => {
                      usage.current?.setEnabled(e.target.checked);
                      setUsageEnabled(usage.current?.enabled() ?? false);
                    }}
                  />{' '}
                  Share basic app usage
                </label>
                <p>
                  Reports app launches, home-screen tool selections, app/Android version and device class using a random app identifier. Country is estimated
                  from IP where configured. No documents, account details or GPS are sent; raw IP is not stored in analytics. Reports expire after 30 days.
                  Turning this off clears unsent reports; previously received reports expire normally.
                </p>
              </section>
            ) : null}
          </main>
          <button className="fab" aria-label="Scan a document" disabled={busyOr} onClick={scan}>
            <Camera size={26} aria-hidden="true" />
          </button>
        </>
      ) : null}

      {view ? (
        <>
          {placed ? (
            <AppBar
              left={<IconButton icon={X} label="Cancel" onClick={() => setPlaced(undefined)} />}
              title="Fill & Sign"
              right={
                <button className="text-btn" disabled={busyOr} onClick={() => void applySignatures(view)}>
                  Done
                </button>
              }
            />
          ) : edit ? (
            <AppBar
              left={<IconButton icon={X} label="Cancel" onClick={() => setEdit(undefined)} />}
              title="Edit PDF"
              right={
                <>
                  <IconButton icon={Undo2} label="Undo" disabled={!edit.items.length} onClick={() => setEdit({ ...edit, items: edit.items.slice(0, -1) })} />
                  <button className="text-btn" disabled={busyOr} onClick={() => void applyEdits(view)}>
                    Done
                  </button>
                </>
              }
            />
          ) : (
            <AppBar
              left={<IconButton icon={ArrowLeft} label="Back" onClick={back} />}
              title={view.file.name}
              subtitle={`${plural(view.pdf.doc.numPages, 'page')} · ${size(view.file.bytes.length)}`}
              right={
                <>
                  <IconButton
                    icon={Share2}
                    label="Share"
                    disabled={busyOr}
                    onClick={() => void run('Preparing…', () => shareFile(view.file.name, view.file.bytes, PDF_MIME))}
                  />
                  <IconButton icon={EllipsisVertical} label="More" disabled={busyOr} onClick={() => setPanel({ k: 'tools' })} />
                </>
              }
            />
          )}
          {placed || edit ? (
            <p className="hint-chip">
              {placed
                ? 'Tap where you want to sign. Drag to move; drag the corner to resize.'
                : edit!.tool === 'image' && !edit!.picture
                  ? 'Choose a picture first.'
                  : HINTS[edit!.tool]}
            </p>
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
          {snack}
          <nav className="bottombar">
            {placed ? (
              <BarButton icon={PenTool} label="New signature" onClick={() => setPad(true)} />
            ) : edit ? (
              <div className="palette">
                {edit.tool === 'draw' || edit.tool === 'text' ? (
                  <div className="swatches" role="radiogroup" aria-label="Colour">
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
                  </div>
                ) : null}
                <div className="palette-tools" role="radiogroup" aria-label="Edit tool">
                  {TOOLS.map(([t, label, icon]) => (
                    <BarButton key={t} role="radio" icon={icon} label={label} active={edit.tool === t} onClick={() => chooseTool(t)} />
                  ))}
                </div>
              </div>
            ) : (
              <>
                <BarButton icon={FilePenLine} label="Edit" disabled={busyOr} onClick={() => startTool(view, 'edit')} />
                <BarButton icon={Signature} label="Fill & Sign" disabled={busyOr} onClick={() => startTool(view, 'sign')} />
                <BarButton icon={LayoutGrid} label="Organize" disabled={busyOr} onClick={() => startTool(view, 'organize')} />
                <BarButton icon={Grid2x2} label="All tools" disabled={busyOr} onClick={() => setPanel({ k: 'tools' })} />
              </>
            )}
          </nav>
        </>
      ) : null}

      {screen.k === 'pages' ? (
        <>
          <AppBar
            left={<IconButton icon={X} label="Cancel" onClick={back} />}
            title="Organize pages"
            subtitle={selected.size ? `${selected.size} selected` : 'Tap pages to select them'}
            right={
              <button className="text-btn" disabled={busyOr} onClick={() => void applyPages()}>
                Done
              </button>
            }
          />
          <Pages
            docs={screen.docs}
            sheets={screen.sheets}
            selected={selected}
            onToggle={(key) =>
              setSelected((old) => {
                const next = new Set(old);
                if (!next.delete(key)) next.add(key);
                return next;
              })
            }
          />
          {snack}
          <nav className="bottombar">
            <BarButton icon={Plus} label="Add a PDF" disabled={busyOr} onClick={() => extraPdf.current?.click()} />
            <BarButton
              icon={RotateCw}
              label="Rotate"
              disabled={!selected.size}
              onClick={() => editSheets((all) => all.map((x) => (selected.has(x.key) ? { ...x, rotation: norm(x.rotation + 90) } : x)))}
            />
            <BarButton icon={ChevronLeft} label="Move earlier" disabled={!selected.size} onClick={() => editSheets((all) => moveSelected(all, selected, -1))} />
            <BarButton icon={ChevronRight} label="Move later" disabled={!selected.size} onClick={() => editSheets((all) => moveSelected(all, selected, 1))} />
            <BarButton icon={Trash2} label="Delete" disabled={!selected.size} onClick={deleteSelected} />
          </nav>
        </>
      ) : null}

      {screen.k === 'convert' ? (
        <>
          <AppBar left={<IconButton icon={ArrowLeft} label="Back" onClick={back} />} title="Convert" subtitle="Word, Excel and PowerPoint" />
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
          {snack}
        </>
      ) : null}

      {screen.k === 'home' ? snack : null}
      {busy ? <Progress label={busy} /> : null}

      {pad ? <SignaturePad onCancel={() => setPad(false)} onDone={startSigning} /> : null}
      {panel?.k === 'tools' && view ? <ToolsSheet onClose={() => setPanel(undefined)} tools={fileTools((t) => startTool(view, t))} actions={keep} /> : null}
      {panel?.k === 'export' && view ? (
        <Sheet title="Export PDF" onClose={() => setPanel(undefined)}>
          <p className="muted">Converted on rokelapdf.com: needs internet and a free account.</p>
          <div className="sheet-rows">
            {(
              [
                ['docx', 'To Word', FileText, '#2f6fdb'],
                ['xlsx', 'To Excel', FileSpreadsheet, '#1e8a5a'],
                ['pptx', 'To PowerPoint', Presentation, '#d9541e'],
              ] as const
            ).map(([t, label, icon, color]) => (
              <Row
                key={t}
                icon={icon}
                iconColor={color}
                title={label}
                onClick={() => {
                  setPanel(undefined);
                  void exportTo(view, t);
                }}
              />
            ))}
          </div>
        </Sheet>
      ) : null}
      {panel?.k === 'compress' && view ? <CompressSheet onClose={() => setPanel(undefined)} onPick={(level) => void compress(view, level)} /> : null}
      {panel?.k === 'paid' ? (
        <PaidSheet
          feature={panel.feature}
          why={panel.why}
          onClose={() => setPanel(undefined)}
          onSignIn={() => {
            setPanel(undefined);
            openAccount(view);
          }}
        />
      ) : null}
      {panel?.k === 'split' && view ? (
        <SplitSheet pages={view.pdf.doc.numPages} onClose={() => setPanel(undefined)} onSplit={(m) => void split(view, m)} />
      ) : null}
      {panel?.k === 'parts' ? (
        <PartsSheet
          parts={panel.parts}
          onClose={() => setPanel(undefined)}
          onOpen={(p) =>
            void run('Opening…', async () => {
              setPanel(undefined);
              await show({ name: p.name, bytes: p.bytes });
            })
          }
          onShareAll={() => void run('Preparing…', () => shareFiles(panel.parts))}
        />
      ) : null}
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

  if (p.session === undefined) return <p className="muted center">Checking your account…</p>;
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
      <p className="muted signed-in">Signed in as {p.session.user.email}</p>
      <div className="list">
        <Row
          icon={FileInput}
          iconColor="#2f6fdb"
          title="Word, Excel or PowerPoint → PDF"
          detail=".docx, .xlsx, .pptx, .doc, .xls, .ppt, .odt, .rtf…"
          onClick={() => office.current?.click()}
        />
        <Row icon={FileText} iconColor="#2f6fdb" title="PDF → Word" detail="An editable .docx" onClick={() => fromPdf('docx')} />
        <Row icon={FileSpreadsheet} iconColor="#1e8a5a" title="PDF → Excel" detail="Tables as a .xlsx workbook" onClick={() => fromPdf('xlsx')} />
        <Row icon={Presentation} iconColor="#d9541e" title="PDF → PowerPoint" detail="Pages as .pptx slides" onClick={() => fromPdf('pptx')} />
        <Row icon={LogOut} title="Sign out" onClick={p.onSignOut} />
      </div>
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
  const [current, setCurrent] = useState(1);
  return (
    <main className="viewer">
      {doc.numPages > 1 ? (
        <p className="page-pill" aria-live="polite">
          {current} / {doc.numPages}
        </p>
      ) : null}
      {pages.map((n) => (
        <Page key={n} doc={doc} n={n} layer={layer} onVisible={setCurrent} />
      ))}
    </main>
  );
}

function Page({ doc, n, layer, onVisible }: { doc: PDFDocumentProxy; n: number; layer: (page: number) => ReactNode; onVisible: (n: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);
  // The page counter follows whichever page fills most of the screen.
  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    // The current page is the one crossing the middle of the screen. ("Half of it visible" picked the last page on open:
    // before they render, short pages are all half visible at once.)
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onVisible(n), { rootMargin: '-50% 0px -50% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [n, onVisible]);
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
