'use client';
import Link from 'next/link';
import {
  CloudUpload,
  Combine,
  Download,
  Eraser,
  FilePlus,
  FileText,
  FormInput,
  FolderOpen,
  Highlighter,
  MousePointer2,
  PenLine,
  Redo2,
  Save,
  Signature as SignatureIcon,
  Square,
  Type,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  RotateCw,
  ArrowUp,
  ArrowDown,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button, Form, Modal, Progress, useNotice } from '@/components/ui';
import { ownerUpload, type Workspace } from '@/components/workspace/context';
import { api, enc, fetchSigned, sharingPath } from '@/lib/client/api';
import { useAuth } from '@/lib/client/auth';
import type { UploadProgress } from '@/lib/client/uploader';
import { EditorError, blankPdf, buildPdf, loadSource } from '@/lib/editor/export';
import { takeHandoff } from '@/lib/client/handoff';
import {
  appendPages,
  deletePage,
  movePage,
  norm,
  removeAnnot,
  rotatePage,
  uniqueFieldName,
  upsertAnnot,
  type Annot,
  type EditorState,
  type FieldAnnot,
  type Rotation,
} from '@/lib/editor/model';
import { closePdf, openPdf } from './pdfjs';
import { PageView, Thumb, type PageInfo, type Signature, type Tool } from './page-view';
import { SignaturePad } from './signature-pad';

// The browser PDF editor. Files are opened and edited on this device; nothing is uploaded unless the user saves to
// a workspace, which stores the result as a private draft of a document (never visible through links until it is
// exported and published).

const MAX_BYTES = 200 * 1024 * 1024;
const TOOLS: Array<[Tool, string, string]> = [
  ['select', 'Select', 'Select, move (drag) or delete (Delete key) an annotation; double-click text to edit'],
  ['text', 'Text', 'Click on the page to add text'],
  ['highlight', 'Highlight', 'Drag to highlight'],
  ['rect', 'Box', 'Drag to draw a box'],
  ['ink', 'Draw', 'Draw freehand'],
  ['whiteout', 'Whiteout', 'Covers content visually. The covered text is still in the file — this is not redaction.'],
  ['signature', 'Sign', 'Click on the page to place your signature'],
  ['field', 'Form field', 'Drag to add a fillable text field, or click to place a checkbox'],
];
const TOOL_ICONS: Record<Tool, LucideIcon> = {
  select: MousePointer2,
  text: Type,
  highlight: Highlighter,
  rect: Square,
  ink: PenLine,
  whiteout: Eraser,
  signature: SignatureIcon,
  field: FormInput,
};
const isTool = (t: string | undefined): t is Tool => !!t && TOOLS.some(([x]) => x === t);
const COLORS = ['#111827', '#d32f2f', '#1565c0', '#2e7d32', '#ffeb3b', '#ff9800'];

interface Source {
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  info: PageInfo[];
}
interface History {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
}
const EMPTY: EditorState = { pages: [], annots: {} };

async function readSource(bytes: Uint8Array): Promise<Source> {
  if (bytes.length > MAX_BYTES) throw new EditorError('This file is too large to edit in the browser (200 MB maximum).');
  await loadSource(bytes); // rejects unreadable and encrypted files with a clear message
  const doc = await openPdf(bytes);
  const info: PageInfo[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const [x1, y1, x2, y2] = p.view as [number, number, number, number];
    info.push({ w: x2 - x1, h: y2 - y1, base: norm(p.rotate) });
  }
  return { bytes, doc, info };
}

const fileBytes = async (f: File) => new Uint8Array(await f.arrayBuffer());
const baseName = (n: string) => n.replace(/\.pdf$/i, '').slice(0, 200) || 'Document';

export function Editor({
  ws,
  docId,
  handoff,
  initialTool,
}: {
  ws?: string | undefined;
  docId?: string | undefined;
  /** Open the file another page left for the editor (see lib/client/handoff). */
  handoff?: boolean;
  initialTool?: string | undefined;
}) {
  const notice = useNotice();
  const router = useRouter();
  const { session, ready } = useAuth();
  const [sources, setSources] = useState<Source[]>([]);
  const [h, setH] = useState<History>({ past: [], present: EMPTY, future: [] });
  const [title, setTitle] = useState('Untitled');
  const [tool, setTool] = useState<Tool>('select');
  // Each tool remembers its own colour (a highlight should not inherit the dark text colour).
  const [colors, setColors] = useState<Record<string, string>>({ text: '#111827', highlight: '#ffeb3b', rect: '#d32f2f', ink: '#1565c0', field: '#1565c0' });
  const [signature, setSignature] = useState<Signature>();
  const [sigOpen, setSigOpen] = useState(false);
  const [fieldType, setFieldType] = useState<FieldAnnot['field']>('text');
  const [fontSize, setFontSize] = useState(14);
  const [inkWidth, setInkWidth] = useState(2);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const [selected, setSelected] = useState<{ page: string; id: string }>();
  const [editing, setEditing] = useState<{ page: string; id: string }>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [progress, setProgress] = useState<UploadProgress>();
  const [doc, setDoc] = useState<{ id: string; title: string; orgId: string }>();
  const [saveOpen, setSaveOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>();
  const mainRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLInputElement>(null);
  const mergeRef = useRef<HTMLInputElement>(null);
  const s = h.present;
  const scale = fit * zoom;

  // ---- history ----------------------------------------------------------------------------------------
  const commit = useCallback((next: EditorState | ((cur: EditorState) => EditorState)) => {
    setH((cur) => {
      const n = typeof next === 'function' ? next(cur.present) : next;
      return n === cur.present ? cur : { past: [...cur.past.slice(-99), cur.present], present: n, future: [] };
    });
    setDirty(true);
  }, []);
  /** Updates the present state without a history entry (live dragging). */
  const live = useCallback((fn: (cur: EditorState) => EditorState) => setH((cur) => ({ ...cur, present: fn(cur.present) })), []);
  const dragOrigin = useRef<EditorState>(undefined);
  const undo = () => setH((c) => (c.past.length ? { past: c.past.slice(0, -1), present: c.past[c.past.length - 1]!, future: [c.present, ...c.future] } : c));
  const redo = () => setH((c) => (c.future.length ? { past: [...c.past, c.present], present: c.future[0]!, future: c.future.slice(1) } : c));

  // ---- opening files ------------------------------------------------------------------------------------
  const openBytes = useCallback(
    async (bytes: Uint8Array, name: string) => {
      const src = await readSource(bytes);
      for (const old of sources) void closePdf(old.doc);
      setSources([src]);
      setH({ past: [], present: appendPages(EMPTY, 0, src.info.length), future: [] });
      setTitle(name);
      setSelected(undefined);
      setEditing(undefined);
      setDirty(false);
    },
    [sources],
  );
  const addSource = async (bytes: Uint8Array, at?: number) => {
    const src = await readSource(bytes);
    const index = sources.length;
    setSources((xs) => [...xs, src]);
    commit((cur) => appendPages(cur, index, src.info.length, at));
  };

  // Fit the page width to the viewport.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const first = s.pages[0] && sources[s.pages[0].src]?.info[s.pages[0].index];
      const w = first ? (first.base % 180 ? first.h : first.w) : 612;
      setFit(Math.max(0.3, Math.min(1.5, (el.clientWidth - 48) / w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [s.pages, sources]);

  // Load the draft when opened from a workspace document.
  useEffect(() => {
    if (!ready || !ws || !docId) return;
    if (!session) {
      router.replace(`/signin?next=${encodeURIComponent(`/edit?ws=${ws}&doc=${docId}`)}`);
      return;
    }
    let cancelled = false;
    (async () => {
      setBusy('Opening document…');
      try {
        const P = sharingPath(ws);
        const d = await api(`${P}/documents/${enc(docId)}`);
        if (cancelled) return;
        setDoc({ id: d.id, title: d.title, orgId: ws });
        setTitle(d.title);
        const latest = d.has_draft ? { type: 'draft', id: docId } : d.versions?.[0] ? { type: 'version', id: d.versions[0].id } : undefined;
        if (latest) {
          const { url } = await api(`${P}/files/download`, { body: latest });
          const bytes = await fetchSigned(url);
          if (!cancelled) await openBytes(bytes, d.title);
        }
      } catch (e) {
        notice((e as Error).message, true);
      } finally {
        setBusy(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session?.user.id, ws, docId]);

  // A file handed over by a tool page or the home page, optionally with a tool already chosen.
  useEffect(() => {
    if (!handoff) {
      if (isTool(initialTool)) setTool(initialTool);
      return;
    }
    // The file can be taken only once, so a re-run of this effect (React StrictMode) must not discard it.
    void (async () => {
      setBusy('Opening document…');
      try {
        const f = await takeHandoff();
        if (!f) return;
        await openBytes(f.bytes, baseName(f.name));
        if (isTool(initialTool)) {
          setTool(initialTool);
          if (initialTool === 'signature') setSigOpen(true);
        }
      } catch (e) {
        notice((e as Error).message, true);
      } finally {
        setBusy(undefined);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const fn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [dirty]);

  // Keyboard: undo/redo, delete selection.
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        commit((cur) => removeAnnot(cur, selected.page, selected.id));
        setSelected(undefined);
      } else if (e.key === 'Escape') setSelected(undefined);
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [selected, commit]);

  // ---- output -------------------------------------------------------------------------------------------
  const build = () =>
    buildPdf(
      sources.map((x) => x.bytes),
      s,
      { title },
    );
  const download = async () => {
    const bytes = await build();
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName(title)}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    if (!doc) setDirty(false);
  };
  const saveDraft = async (orgId: string, documentId: string) => {
    const bytes = await build();
    const file = new File([bytes as BlobPart], `${baseName(title)}.pdf`, { type: 'application/pdf', lastModified: Date.now() });
    setBusy('Saving draft…');
    try {
      await ownerUpload(orgId, file, { target: 'draft', document_id: documentId }, setProgress);
    } finally {
      setBusy(undefined);
      setProgress(undefined);
    }
    setDirty(false);
    notice('Draft saved privately. Export and publish it from the document page to share it.');
  };
  const openSaveDialog = async () => {
    if (!session) return router.push(`/signin?next=/edit`);
    setWorkspaces((await api('/api/v1/me')).workspaces);
    setSaveOpen(true);
  };

  const selectedAnnot = useMemo(() => (selected ? s.annots[selected.page]?.find((a) => a.id === selected.id) : undefined), [selected, s]);
  const colorKey = tool === 'select' ? (selectedAnnot?.kind ?? 'text') : tool;
  const color = colors[colorKey] ?? COLORS[0]!;
  const setColor = (c: string) => setColors((x) => ({ ...x, [colorKey]: c }));
  const pageInfo = (pageSrc: number, index: number) => sources[pageSrc]?.info[index];
  const onDropFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) return notice('Choose a PDF file.', true);
    try {
      if (s.pages.length && !window.confirm('Replace the open document? Use “Add PDF” to merge instead.')) return;
      await openBytes(await fileBytes(f), baseName(f.name));
    } catch (e) {
      notice((e as Error).message, true);
    }
  };

  return (
    <div className="editor">
      <input
        ref={openRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => void onDropFile(e.target.files?.[0]).finally(() => (e.target.value = ''))}
      />
      <input
        ref={mergeRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        multiple
        onChange={async (e) => {
          try {
            for (const f of e.target.files ?? []) await addSource(await fileBytes(f));
          } catch (err) {
            notice((err as Error).message, true);
          } finally {
            e.target.value = '';
          }
        }}
      />
      <div className="ed-bar" role="toolbar" aria-label="Editor">
        <div className="ed-doc">
          <FileText size={18} aria-hidden="true" className="muted" />
          <span className="doc-title" title={title}>
            {s.pages.length ? title : 'Edit a PDF'}
          </span>
          {s.pages.length > 0 && <span className={`save-state${dirty ? ' dirty' : ''}`}>{dirty ? 'Unsaved changes' : doc ? 'Saved' : 'On this device'}</span>}
        </div>
        <div className="ed-tools" role="radiogroup" aria-label="Tool">
          {TOOLS.map(([t, label, hint]) => {
            const Icon = TOOL_ICONS[t];
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={tool === t}
                title={hint}
                className={tool === t ? 'active' : ''}
                disabled={!s.pages.length}
                onClick={() => {
                  setTool(t);
                  if (t === 'signature' && !signature) setSigOpen(true);
                }}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
        <div className="ed-actions">
          <Button onClick={download} disabled={!s.pages.length}>
            <Download size={16} aria-hidden="true" /> Download<span className="wide-only"> PDF</span>
          </Button>
          {doc ? (
            <>
              <Button kind="primary" disabled={!s.pages.length} onClick={() => saveDraft(doc.orgId, doc.id)}>
                <Save size={16} aria-hidden="true" /> Save draft
              </Button>
              <Link className="button ghost" href={`/app?ws=${enc(doc.orgId)}&tab=documents&id=${enc(doc.id)}`}>
                Export &amp; share →
              </Link>
            </>
          ) : (
            <Button kind="primary" disabled={!s.pages.length} onClick={openSaveDialog}>
              <CloudUpload size={16} aria-hidden="true" /> Save<span className="wide-only"> to workspace</span>
            </Button>
          )}
        </div>
      </div>
      {s.pages.length > 0 && (
        <div className="ed-sub">
          <div className="ed-file">
            <Button onClick={() => openRef.current?.click()} title="Open a PDF">
              <FolderOpen size={16} aria-hidden="true" /> Open PDF
            </Button>
            <Button onClick={() => mergeRef.current?.click()} disabled={!s.pages.length} title="Append the pages of another PDF">
              <Combine size={16} aria-hidden="true" /> Add PDF
            </Button>
            <Button
              disabled={!s.pages.length}
              title="Insert a blank page at the end"
              onClick={async () => {
                const last = s.pages[s.pages.length - 1];
                const info = last && pageInfo(last.src, last.index);
                await addSource(await blankPdf(info?.w, info?.h));
              }}
            >
              <FilePlus size={16} aria-hidden="true" /> Blank page
            </Button>
          </div>
          <div className="ed-style">
            <span className="swatches" role="radiogroup" aria-label="Colour">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={`Colour ${c}`}
                  className={`swatch${color === c ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </span>
            {(tool === 'text' || selectedAnnot?.kind === 'text') && (
              <label className="inline">
                Size
                <select value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}>
                  {[8, 10, 12, 14, 18, 24, 32, 48].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            )}
            {tool === 'ink' && (
              <label className="inline">
                Width
                <select value={inkWidth} onChange={(e) => setInkWidth(Number(e.target.value))}>
                  {[1, 2, 4, 8].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            )}
            {tool === 'signature' && (
              <Button kind="ghost" onClick={() => setSigOpen(true)}>
                {signature ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local data: URL, nothing to optimize */}
                    <img src={signature.src} alt="Your signature" className="sig-thumb" /> Change
                  </>
                ) : (
                  'Create signature'
                )}
              </Button>
            )}
            {tool === 'field' && (
              <span className="seg" role="radiogroup" aria-label="Field type">
                {(
                  [
                    ['text', 'Text field'],
                    ['checkbox', 'Checkbox'],
                  ] as Array<[FieldAnnot['field'], string]>
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={fieldType === v}
                    className={fieldType === v ? 'on' : ''}
                    onClick={() => setFieldType(v)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            )}
            {selectedAnnot?.kind === 'field' && (
              <label className="inline">
                Name
                <input
                  key={selectedAnnot.id}
                  defaultValue={selectedAnnot.name}
                  maxLength={60}
                  className="field-name"
                  onBlur={(e) => {
                    const name = uniqueFieldName(s, e.target.value, selectedAnnot.id);
                    e.target.value = name;
                    if (name !== selectedAnnot.name) commit((cur) => upsertAnnot(cur, selected!.page, { ...selectedAnnot, name }));
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
              </label>
            )}
            {selectedAnnot && selectedAnnot.kind !== 'whiteout' && selectedAnnot.kind !== 'image' && (
              <Button
                kind="ghost"
                onClick={() =>
                  commit((cur) =>
                    upsertAnnot(cur, selected!.page, { ...selectedAnnot, color, ...(selectedAnnot.kind === 'text' ? { size: fontSize } : {}) } as Annot),
                  )
                }
              >
                Apply style
              </Button>
            )}
            {selectedAnnot && (
              <Button
                kind="ghost"
                onClick={() => {
                  commit((cur) => removeAnnot(cur, selected!.page, selected!.id));
                  setSelected(undefined);
                }}
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      )}
      {s.pages.length > 0 && (
        <div className="ed-zoom" role="group" aria-label="History and zoom">
          <Button kind="ghost" onClick={undo} disabled={!h.past.length} title="Undo (Ctrl+Z)">
            <Undo2 size={18} aria-hidden="true" />
            <span className="sr-only">Undo</span>
          </Button>
          <Button kind="ghost" onClick={redo} disabled={!h.future.length} title="Redo (Ctrl+Shift+Z)">
            <Redo2 size={18} aria-hidden="true" />
            <span className="sr-only">Redo</span>
          </Button>
          <Button kind="ghost" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))} title="Zoom out">
            <ZoomOut size={18} aria-hidden="true" />
            <span className="sr-only">Zoom out</span>
          </Button>
          <span className="zoom">{Math.round(scale * 100)}%</span>
          <Button kind="ghost" onClick={() => setZoom((z) => Math.min(4, z * 1.25))} title="Zoom in">
            <ZoomIn size={18} aria-hidden="true" />
            <span className="sr-only">Zoom in</span>
          </Button>
        </div>
      )}

      <div className="editor-body">
        <aside className="thumbs" aria-label="Pages" hidden={!s.pages.length}>
          {s.pages.map((pg, i) => {
            const src = sources[pg.src];
            const info = src?.info[pg.index];
            if (!src || !info) return null;
            return (
              <div key={pg.id} className="thumb">
                <button
                  type="button"
                  className="thumb-open"
                  onClick={() => document.getElementById(`page-${pg.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  aria-label={`Go to page ${i + 1}`}
                >
                  <Thumb doc={src.doc} index={pg.index} info={info} added={pg.rotation} annots={s.annots[pg.id] ?? []} />
                </button>
                <div className="thumb-actions">
                  <span>{i + 1}</span>
                  <button type="button" title="Rotate left" aria-label={`Rotate page ${i + 1} left`} onClick={() => commit((c) => rotatePage(c, pg.id, -90))}>
                    <RotateCcw size={14} aria-hidden="true" />
                  </button>
                  <button type="button" title="Rotate right" aria-label={`Rotate page ${i + 1} right`} onClick={() => commit((c) => rotatePage(c, pg.id, 90))}>
                    <RotateCw size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    title="Move up"
                    aria-label={`Move page ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => commit((c) => movePage(c, pg.id, i - 1))}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    aria-label={`Move page ${i + 1} down`}
                    disabled={i === s.pages.length - 1}
                    onClick={() => commit((c) => movePage(c, pg.id, i + 1))}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    title="Delete page"
                    aria-label={`Delete page ${i + 1}`}
                    disabled={s.pages.length === 1}
                    onClick={() => commit((c) => deletePage(c, pg.id))}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </aside>

        <div
          ref={mainRef}
          className="pages"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onDropFile(e.dataTransfer.files[0]);
          }}
        >
          {busy && <p className="muted center">{busy}</p>}
          <Progress p={progress} />
          {!s.pages.length && !busy && (
            <div className="ed-empty">
              <h1>{doc ? doc.title : 'Edit a PDF'}</h1>
              <p>Add text, highlights, signatures and form fields, then download. Your file stays on this device{doc ? '' : ' unless you save it'}.</p>
              <div className="bigdrop">
                <button type="button" className="button primary xl" onClick={() => openRef.current?.click()}>
                  <Upload size={22} aria-hidden="true" /> Choose PDF
                </button>
                <span className="bigdrop-hint">or drop a PDF here</span>
              </div>
            </div>
          )}
          {s.pages.map((pg, i) => {
            const src = sources[pg.src];
            const info = src?.info[pg.index];
            if (!src || !info) return null;
            return (
              <div key={pg.id} id={`page-${pg.id}`} className="page-slot">
                <PageView
                  doc={src.doc}
                  index={pg.index}
                  info={info}
                  added={pg.rotation as Rotation}
                  annots={s.annots[pg.id] ?? []}
                  scale={scale}
                  tool={tool}
                  color={color}
                  fontSize={fontSize}
                  inkWidth={inkWidth}
                  selected={selected?.page === pg.id ? selected.id : undefined}
                  editing={editing?.page === pg.id ? editing.id : undefined}
                  label={`Page ${i + 1} of ${s.pages.length}`}
                  onSelect={(id) => setSelected(id ? { page: pg.id, id } : undefined)}
                  signature={signature}
                  fieldType={fieldType}
                  onNeedSignature={() => setSigOpen(true)}
                  onCreate={(a) => {
                    commit((c) => upsertAnnot(c, pg.id, a.kind === 'field' ? { ...a, name: uniqueFieldName(c, a.name) } : a));
                    if (a.kind !== 'text') setSelected({ page: pg.id, id: a.id });
                  }}
                  onEditText={(id) => {
                    setEditing({ page: pg.id, id });
                    setSelected({ page: pg.id, id });
                  }}
                  onChange={(a, done) => {
                    if (editing?.id === a.id) {
                      setEditing(undefined);
                      // An emptied text box disappears.
                      if (a.kind === 'text' && !a.text.trim()) {
                        commit((c) => removeAnnot(c, pg.id, a.id));
                        setSelected(undefined);
                      } else commit((c) => upsertAnnot(c, pg.id, a));
                      return;
                    }
                    if (!done) {
                      dragOrigin.current ??= h.present;
                      live((c) => upsertAnnot(c, pg.id, a));
                      return;
                    }
                    // End of a drag: one history entry from where the drag began.
                    const origin = dragOrigin.current;
                    dragOrigin.current = undefined;
                    setH((cur) => ({ past: [...cur.past.slice(-99), origin ?? cur.present], present: upsertAnnot(cur.present, pg.id, a), future: [] }));
                    setDirty(true);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      <SignaturePad
        open={sigOpen}
        onClose={() => setSigOpen(false)}
        onDone={(sig) => {
          setSignature(sig);
          setSigOpen(false);
          setTool('signature');
          notice('Click on the page where you want to sign.');
        }}
      />

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save to workspace">
        <p className="muted">The edited PDF is saved as a private draft of a new document. Export and publish it to share it.</p>
        {workspaces && (
          <Form
            fields={[
              { name: 'title', label: 'Document title', value: title },
              {
                name: 'ws',
                label: 'Workspace',
                type: 'select',
                options: workspaces.map((w) => [w.id, w.kind === 'personal' ? 'Personal' : w.name] as [string, string]),
              },
            ]}
            submit="Save draft"
            onSubmit={async (v) => {
              const d = await api(`${sharingPath(v.ws!)}/documents`, { body: { title: v.title, require_approval: false } });
              setTitle(v.title!);
              await saveDraft(v.ws!, d.id);
              setDoc({ id: d.id, title: v.title!, orgId: v.ws! });
              setSaveOpen(false);
              router.replace(`/edit?ws=${enc(v.ws!)}&doc=${enc(d.id)}`);
            }}
          />
        )}
      </Modal>
    </div>
  );
}
