'use client';
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { zipSync } from 'fflate';
import { ArrowDown, ArrowUp, Download, FileArchive, FilePen, Loader2, Lock, Plus, RotateCcw, Upload, X } from 'lucide-react';
import { toolBySlug, type ToolSlug } from '@/lib/tools/registry';
import {
  addBlankPages,
  addPageNumbers,
  addWatermark,
  cropPages,
  deletePages,
  extractPages,
  fillForm,
  flattenPdf,
  imagesToPdf,
  insertPdf,
  listFormFields,
  mergePdfs,
  parseRanges,
  rotatePages,
  splitPdf,
  type FormFieldInfo,
  type PageNumberOptions,
  type WatermarkOptions,
} from '@/lib/tools/ops';
import { imageForPdf, pdfToImages } from '@/lib/client/raster';
import { putHandoff } from '@/lib/client/handoff';
import { fmtBytes } from '@/lib/client/format';
import { PagePicker, toRanges } from './page-picker';

// One component runs every single-step tool: choose files, set options, run the operation in this browser and
// download the result. Nothing is uploaded. Interactive tools (sign, edit…) hand the file to the editor instead.

const MAX_FILE = 300 * 1024 * 1024;
const MAX_FILES = 50;

interface Picked {
  id: string;
  file: File;
  bytes: Uint8Array;
}
interface Output {
  name: string;
  blob: Blob;
  url: string;
  pdf?: Uint8Array;
}

const baseName = (n: string) => n.replace(/\.[a-z0-9]+$/i, '').slice(0, 120) || 'document';
const isPdf = (b: Uint8Array) => {
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024));
  return head.includes('%PDF-');
};
const pdfBlob = (b: Uint8Array) => new Blob([b as BlobPart], { type: 'application/pdf' });
let seq = 0;

function save(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="opt">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="opt">
      <span>{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

const num = (s: string, fallback: number) => (s.trim() === '' || !Number.isFinite(Number(s)) ? fallback : Number(s));

export function ToolRunner({ slug }: { slug: ToolSlug }) {
  const tool = toolBySlug(slug)!;
  const router = useRouter();
  const [files, setFiles] = useState<Picked[]>([]);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  // ---- options (one flat set; each tool reads the ones it needs) ----------------------------------------------
  const [spec, setSpec] = useState('');
  const [splitKind, setSplitKind] = useState<'ranges' | 'every' | 'each'>('ranges');
  const [every, setEvery] = useState('2');
  const [angle, setAngle] = useState<90 | 180 | 270>(90);
  const [addKind, setAddKind] = useState<'blank' | 'pdf'>('blank');
  const [after, setAfter] = useState('');
  const [blankCount, setBlankCount] = useState('1');
  const [blankSize, setBlankSize] = useState<'same' | 'A4' | 'Letter'>('same');
  const [other, setOther] = useState<Picked>();
  const [margins, setMargins] = useState({ top: '5', right: '5', bottom: '5', left: '5' });
  const [wm, setWm] = useState<WatermarkOptions>({ text: 'CONFIDENTIAL', fontSize: 60, opacity: 0.25, color: '#1e3a8a', layout: 'diagonal' });
  const [pn, setPn] = useState<PageNumberOptions>({ position: 'bottom-center', format: 'n', start: 1, fontSize: 11, margin: 28, skipFirst: false });
  const [fields, setFields] = useState<FormFieldInfo[]>();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [flatten, setFlatten] = useState(false);
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(0.9);
  const [imgPage, setImgPage] = useState<'fit' | 'A4' | 'Letter'>('A4');
  const [orient, setOrient] = useState<'auto' | 'portrait' | 'landscape'>('auto');
  const [imgMargin, setImgMargin] = useState(18);

  const first = files[0];
  const name = first ? baseName(first.file.name) : 'document';

  // Release object URLs for old results.
  useEffect(() => () => outputs.forEach((o) => URL.revokeObjectURL(o.url)), [outputs]);

  // Read the form fields when a form is chosen.
  useEffect(() => {
    if (slug !== 'fill-pdf-form' || !first) return;
    let live = true;
    setFields(undefined);
    listFormFields(first.bytes).then(
      (fs) => {
        if (!live) return;
        setFields(fs);
        setValues(Object.fromEntries(fs.map((f) => [f.name, f.value])));
      },
      (e: unknown) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [slug, first]);

  // ---- choosing files -------------------------------------------------------------------------------------------
  async function read(list: FileList | File[]): Promise<Picked[]> {
    const out: Picked[] = [];
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE) throw new Error(`“${file.name}” is larger than ${fmtBytes(MAX_FILE)}.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (tool.accept === 'pdf' && !isPdf(bytes)) throw new Error(`“${file.name}” is not a PDF.`);
      if (tool.accept === 'image' && !file.type.startsWith('image/')) throw new Error(`“${file.name}” is not an image.`);
      out.push({ id: `f${++seq}`, file, bytes });
    }
    return out;
  }

  async function choose(list: FileList | File[] | null) {
    if (!list || !list.length) return;
    setError(undefined);
    try {
      const picked = await read(tool.multiple ? list : [list[0]!]);
      if (tool.editorTool) {
        // Interactive tools continue in the editor with the file and the tool already chosen.
        setBusy('Opening the editor…');
        await putHandoff(picked[0]!.bytes, picked[0]!.file.name);
        router.push(`/edit?handoff=1&tool=${tool.editorTool}`);
        return;
      }
      const next = tool.multiple ? [...files, ...picked] : picked;
      if (next.length > MAX_FILES) throw new Error(`Choose up to ${MAX_FILES} files.`);
      setOutputs([]);
      setFiles(next);
      if (!tool.multiple) {
        setSpec('');
        setCount(0);
      }
    } catch (e) {
      setBusy(undefined);
      setError((e as Error).message);
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void choose(e.dataTransfer.files);
  };
  const move = (i: number, d: -1 | 1) =>
    setFiles((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const next = xs.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const reset = () => {
    setFiles([]);
    setOutputs([]);
    setError(undefined);
    setSpec('');
    setCount(0);
    setOther(undefined);
    setFields(undefined);
  };

  // Clicking thumbnails edits the page-range text, so both stay in step.
  const selected = useMemo(() => {
    if (!count || !spec.trim()) return new Set<number>();
    try {
      return new Set(parseRanges(spec, count));
    } catch {
      return new Set<number>();
    }
  }, [spec, count]);
  const toggle = (i: number) => {
    const s = new Set(selected);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    setSpec(toRanges(s));
  };

  // ---- running --------------------------------------------------------------------------------------------------
  async function compute(): Promise<Array<{ name: string; blob: Blob; pdf?: Uint8Array }>> {
    const pdf = (n: string, b: Uint8Array) => [{ name: n, blob: pdfBlob(b), pdf: b }];
    const b = first!.bytes;
    switch (slug) {
      case 'merge-pdf':
        if (files.length < 2) throw new Error('Add at least two PDFs to merge.');
        return pdf(`${name}-merged.pdf`, await mergePdfs(files.map((f) => f.bytes)));
      case 'split-pdf': {
        const parts = await splitPdf(
          b,
          splitKind === 'each' ? { kind: 'each' } : splitKind === 'every' ? { kind: 'every', n: num(every, 0) } : { kind: 'ranges', spec },
          name,
        );
        return parts.map((p) => ({ name: p.name, blob: pdfBlob(p.bytes), pdf: p.bytes }));
      }
      case 'delete-pages':
        return pdf(`${name}-edited.pdf`, await deletePages(b, spec));
      case 'extract-pages':
        return pdf(`${name}-extract.pdf`, await extractPages(b, spec));
      case 'rotate-pdf':
        return pdf(`${name}-rotated.pdf`, await rotatePages(b, angle, spec));
      case 'add-pages': {
        const pos = num(after, count);
        if (addKind === 'pdf') {
          if (!other) throw new Error('Choose the PDF to insert.');
          return pdf(`${name}-combined.pdf`, await insertPdf(b, other.bytes, pos));
        }
        return pdf(`${name}-pages-added.pdf`, await addBlankPages(b, { after: pos, count: num(blankCount, 0), size: blankSize }));
      }
      case 'crop-pdf':
        return pdf(
          `${name}-cropped.pdf`,
          await cropPages(b, { top: num(margins.top, 0), right: num(margins.right, 0), bottom: num(margins.bottom, 0), left: num(margins.left, 0) }, spec),
        );
      case 'watermark-pdf':
        return pdf(`${name}-watermarked.pdf`, await addWatermark(b, wm, spec));
      case 'page-numbers':
        return pdf(`${name}-numbered.pdf`, await addPageNumbers(b, pn));
      case 'flatten-pdf': {
        const r = await flattenPdf(b);
        if (!r.fields) throw new Error('This PDF has no form fields to flatten.');
        return pdf(`${name}-flattened.pdf`, r.bytes);
      }
      case 'fill-pdf-form':
        return pdf(`${name}-filled.pdf`, await fillForm(b, values, flatten));
      case 'pdf-to-jpg':
      case 'pdf-to-png': {
        const pages = spec.trim() ? parseRanges(spec, count) : Array.from({ length: count }, (_, i) => i);
        if (!pages.length) throw new Error('The PDF has no pages.');
        const imgs = await pdfToImages(b, { pages, format: slug === 'pdf-to-jpg' ? 'jpeg' : 'png', dpi, quality, baseName: name }, (d, t) =>
          setBusy(`Converting page ${d} of ${t}…`),
        );
        return imgs;
      }
      case 'jpg-to-pdf': {
        const imgs = [];
        for (const f of files) imgs.push(await imageForPdf(f.file));
        return pdf(
          `${files.length === 1 ? name : 'images'}.pdf`,
          await imagesToPdf(imgs, { pageSize: imgPage, orientation: orient, margin: imgPage === 'fit' ? 0 : imgMargin }),
        );
      }
      default:
        throw new Error('This tool opens in the editor.');
    }
  }

  async function run() {
    if (!first || busy) return;
    setError(undefined);
    setBusy('Working…');
    try {
      const out = await compute();
      setOutputs(out.map((o) => ({ ...o, url: URL.createObjectURL(o.blob) })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try another file.');
    } finally {
      setBusy(undefined);
    }
  }

  async function downloadZip() {
    const entries: Record<string, Uint8Array> = {};
    for (const o of outputs) entries[o.name] = new Uint8Array(await o.blob.arrayBuffer());
    // Already-compressed images and PDFs gain little from deflate; store them.
    save(`${name}.zip`, new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: 'application/zip' }));
  }

  async function openInEditor(o: Output) {
    if (!o.pdf) return;
    await putHandoff(o.pdf, o.name);
    router.push('/edit?handoff=1');
  }

  // ---- view -----------------------------------------------------------------------------------------------------
  const accept = tool.accept === 'pdf' ? 'application/pdf,.pdf' : 'image/*';
  const picker = (mark: 'check' | 'remove' = 'check', interactive = true) =>
    first && (
      <PagePicker
        key={first.id}
        bytes={first.bytes}
        selected={interactive ? selected : undefined}
        onToggle={interactive ? toggle : undefined}
        onCount={setCount}
        mark={mark}
      />
    );
  const rangeField = (label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder={count ? `e.g. 1-${Math.min(3, count)}` : 'e.g. 1-3, 5'} />
    </Field>
  );

  let options: ReactNode = null;
  let preview: ReactNode = null;
  let ready = !!first;
  switch (slug) {
    case 'merge-pdf':
      ready = files.length >= 2;
      options = <p className="muted">Put the files in order with the arrows, then merge.</p>;
      break;
    case 'split-pdf':
      preview = picker('check', false);
      options = (
        <>
          <Segmented
            label="Split"
            value={splitKind}
            onChange={setSplitKind}
            options={[
              ['ranges', 'By ranges'],
              ['every', 'Every N pages'],
              ['each', 'Every page'],
            ]}
          />
          {splitKind === 'ranges' && (
            <Field label="Ranges" hint="Each range becomes its own file, e.g. 1-3, 4-6, 7-">
              <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="1-3, 4-6" />
            </Field>
          )}
          {splitKind === 'every' && (
            <Field label="Pages per file">
              <input type="number" min={1} value={every} onChange={(e) => setEvery(e.target.value)} />
            </Field>
          )}
        </>
      );
      break;
    case 'delete-pages':
      preview = picker('remove');
      options = rangeField('Pages to delete', 'Click pages or type ranges.');
      ready = !!first && !!spec.trim();
      break;
    case 'extract-pages':
      preview = picker();
      options = rangeField('Pages to keep', 'Click pages or type ranges.');
      ready = !!first && !!spec.trim();
      break;
    case 'rotate-pdf':
      preview = picker();
      options = (
        <>
          <Segmented
            label="Rotate"
            value={angle}
            onChange={setAngle}
            options={[
              [90, '90° right'],
              [180, '180°'],
              [270, '90° left'],
            ]}
          />
          {rangeField('Pages', 'Leave empty to rotate every page.')}
        </>
      );
      break;
    case 'add-pages':
      preview = picker('check', false);
      options = (
        <>
          <Segmented
            label="Add"
            value={addKind}
            onChange={setAddKind}
            options={[
              ['blank', 'Blank pages'],
              ['pdf', 'Another PDF'],
            ]}
          />
          <Field label="Insert after page" hint={`0 puts them at the start. Leave empty to add at the end${count ? ` (after page ${count})` : ''}.`}>
            <input type="number" min={0} max={count || undefined} value={after} onChange={(e) => setAfter(e.target.value)} />
          </Field>
          {addKind === 'blank' ? (
            <>
              <Field label="How many">
                <input type="number" min={1} max={100} value={blankCount} onChange={(e) => setBlankCount(e.target.value)} />
              </Field>
              <Segmented
                label="Page size"
                value={blankSize}
                onChange={setBlankSize}
                options={[
                  ['same', 'Same as document'],
                  ['A4', 'A4'],
                  ['Letter', 'Letter'],
                ]}
              />
            </>
          ) : (
            <div className="opt">
              <span>PDF to insert</span>
              <div className="actions">
                <button type="button" className="button file-button" onClick={() => otherRef.current?.click()}>
                  <Plus size={16} aria-hidden="true" /> {other ? 'Choose another' : 'Choose PDF'}
                </button>
                {other && <span className="muted">{other.file.name}</span>}
              </div>
              <input
                ref={otherRef}
                type="file"
                accept={accept}
                hidden
                onChange={async (e) => {
                  const f = e.target.files;
                  e.target.value = '';
                  try {
                    if (f?.length) setOther((await read([f[0]!]))[0]);
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              />
            </div>
          )}
        </>
      );
      ready = !!first && (addKind === 'blank' || !!other);
      break;
    case 'crop-pdf':
      preview = picker();
      options = (
        <>
          <div className="opt-grid">
            {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
              <Field key={k} label={`${k[0]!.toUpperCase()}${k.slice(1)} (%)`}>
                <input type="number" min={0} max={45} step={0.5} value={margins[k]} onChange={(e) => setMargins((m) => ({ ...m, [k]: e.target.value }))} />
              </Field>
            ))}
          </div>
          {rangeField('Pages', 'Leave empty to crop every page.')}
        </>
      );
      break;
    case 'watermark-pdf':
      preview = picker();
      options = (
        <>
          <Field label="Text">
            <input value={wm.text} maxLength={120} onChange={(e) => setWm({ ...wm, text: e.target.value })} />
          </Field>
          <Segmented
            label="Layout"
            value={wm.layout}
            onChange={(layout) => setWm({ ...wm, layout })}
            options={[
              ['diagonal', 'Diagonal'],
              ['center', 'Centred'],
              ['tile', 'Tiled'],
            ]}
          />
          <div className="opt-grid">
            <Field label="Size">
              <input type="number" min={6} max={200} value={wm.fontSize} onChange={(e) => setWm({ ...wm, fontSize: num(e.target.value, 60) })} />
            </Field>
            <Field label="Colour">
              <input type="color" value={wm.color} onChange={(e) => setWm({ ...wm, color: e.target.value })} />
            </Field>
          </div>
          <Field label={`Opacity: ${Math.round(wm.opacity * 100)}%`}>
            <input type="range" min={0.05} max={1} step={0.05} value={wm.opacity} onChange={(e) => setWm({ ...wm, opacity: Number(e.target.value) })} />
          </Field>
          {rangeField('Pages', 'Leave empty to watermark every page.')}
        </>
      );
      break;
    case 'page-numbers':
      preview = picker('check', false);
      options = (
        <>
          <Field label="Position">
            <select value={pn.position} onChange={(e) => setPn({ ...pn, position: e.target.value as PageNumberOptions['position'] })}>
              <option value="bottom-center">Bottom centre</option>
              <option value="bottom-right">Bottom right</option>
              <option value="bottom-left">Bottom left</option>
              <option value="top-center">Top centre</option>
              <option value="top-right">Top right</option>
              <option value="top-left">Top left</option>
            </select>
          </Field>
          <Field label="Format">
            <select value={pn.format} onChange={(e) => setPn({ ...pn, format: e.target.value as PageNumberOptions['format'] })}>
              <option value="n">1</option>
              <option value="page-n">Page 1</option>
              <option value="n-of-total">1 / 9</option>
              <option value="page-n-of-total">Page 1 of 9</option>
            </select>
          </Field>
          <div className="opt-grid">
            <Field label="Start at">
              <input type="number" min={0} value={pn.start} onChange={(e) => setPn({ ...pn, start: num(e.target.value, 1) })} />
            </Field>
            <Field label="Size">
              <input type="number" min={6} max={48} value={pn.fontSize} onChange={(e) => setPn({ ...pn, fontSize: num(e.target.value, 11) })} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={pn.skipFirst} onChange={(e) => setPn({ ...pn, skipFirst: e.target.checked })} /> Don’t number the first page (cover)
          </label>
        </>
      );
      break;
    case 'flatten-pdf':
      preview = picker('check', false);
      options = <p className="muted">Form fields become part of the page. The result looks the same in every viewer and can no longer be edited.</p>;
      break;
    case 'fill-pdf-form':
      preview = picker('check', false);
      options = !first ? null : !fields ? (
        <p className="muted">Reading form fields…</p>
      ) : !fields.length ? (
        <p className="muted">
          This PDF has no fillable fields. <Link href="/tools/create-fillable-pdf">Add fields to it</Link> or{' '}
          <Link href="/tools/edit-pdf">type on it in the editor</Link>.
        </p>
      ) : (
        <>
          <div className="form-fields">
            {fields.map((f) => {
              const v = values[f.name];
              const set = (x: string | boolean) => setValues((cur) => ({ ...cur, [f.name]: x }));
              if (f.type === 'checkbox')
                return (
                  <label key={f.name} className="check">
                    <input type="checkbox" checked={v === true} disabled={f.readOnly} onChange={(e) => set(e.target.checked)} /> {f.name}
                  </label>
                );
              return (
                <Field key={f.name} label={f.name}>
                  {f.type === 'text' ? (
                    f.multiline ? (
                      <textarea rows={3} value={String(v ?? '')} disabled={f.readOnly} onChange={(e) => set(e.target.value)} />
                    ) : (
                      <input value={String(v ?? '')} disabled={f.readOnly} onChange={(e) => set(e.target.value)} />
                    )
                  ) : (
                    <select value={String(v ?? '')} disabled={f.readOnly} onChange={(e) => set(e.target.value)}>
                      <option value="">—</option>
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              );
            })}
          </div>
          <label className="check">
            <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} /> Lock the answers (flatten)
          </label>
        </>
      );
      ready = !!fields?.length;
      break;
    case 'pdf-to-jpg':
    case 'pdf-to-png':
      preview = picker();
      options = (
        <>
          <Segmented
            label="Resolution"
            value={dpi}
            onChange={setDpi}
            options={[
              [72, 'Screen (72 dpi)'],
              [150, 'Standard (150)'],
              [300, 'Print (300)'],
            ]}
          />
          {slug === 'pdf-to-jpg' && (
            <Field label={`Quality: ${Math.round(quality * 100)}%`}>
              <input type="range" min={0.5} max={1} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
            </Field>
          )}
          {rangeField('Pages', 'Leave empty to convert every page.')}
        </>
      );
      ready = !!first && count > 0;
      break;
    case 'jpg-to-pdf':
      options = (
        <>
          <Segmented
            label="Page size"
            value={imgPage}
            onChange={setImgPage}
            options={[
              ['A4', 'A4'],
              ['Letter', 'Letter'],
              ['fit', 'Same as image'],
            ]}
          />
          {imgPage !== 'fit' && (
            <>
              <Segmented
                label="Orientation"
                value={orient}
                onChange={setOrient}
                options={[
                  ['auto', 'Auto'],
                  ['portrait', 'Portrait'],
                  ['landscape', 'Landscape'],
                ]}
              />
              <Segmented
                label="Margin"
                value={imgMargin}
                onChange={setImgMargin}
                options={[
                  [0, 'None'],
                  [18, 'Small'],
                  [36, 'Large'],
                ]}
              />
            </>
          )}
        </>
      );
      break;
  }

  const Icon = busy ? Loader2 : Upload;

  if (!files.length) {
    return (
      <div className="tool-run">
        <div
          className={`drop${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <span className="file-icon">
            <Icon size={30} className={busy ? 'spin' : undefined} aria-hidden="true" />
          </span>
          <button type="button" className="button primary lg" disabled={!!busy} onClick={() => inputRef.current?.click()}>
            {busy ?? (tool.accept === 'image' ? 'Choose images' : tool.multiple ? 'Choose PDF files' : 'Choose PDF file')}
          </button>
          <span className="muted">or drop {tool.multiple ? 'files' : 'a file'} here</span>
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            multiple={tool.multiple}
            hidden
            data-testid="tool-input"
            onChange={(e) => {
              const f = e.target.files;
              void choose(f ? Array.from(f) : null);
              e.target.value = '';
            }}
          />
        </div>
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        <p className="privacy">
          <Lock size={14} aria-hidden="true" /> Your files are processed in this browser and never uploaded.
        </p>
      </div>
    );
  }

  return (
    <div className="tool-run">
      <div className="tool-work">
        <div className="tool-main">
          {tool.multiple && (
            <ul className="file-list" aria-label="Files">
              {files.map((f, i) => (
                <li key={f.id}>
                  <span className="file-order">{i + 1}</span>
                  <span className="file-name">{f.file.name}</span>
                  <span className="muted">{fmtBytes(f.file.size)}</span>
                  <span className="file-actions">
                    <button type="button" className="icon-button" aria-label={`Move ${f.file.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${f.file.name} down`}
                      disabled={i === files.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${f.file.name}`}
                      onClick={() => setFiles((xs) => xs.filter((x) => x.id !== f.id))}
                    >
                      <X size={16} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!tool.multiple && (
            <div className="file-chip">
              <strong>{first!.file.name}</strong>
              <span className="muted">
                {fmtBytes(first!.file.size)}
                {count ? ` · ${count} page${count === 1 ? '' : 's'}` : ''}
              </span>
            </div>
          )}
          {preview}
        </div>
        <aside className="tool-side" aria-label="Options">
          <h2>{tool.title}</h2>
          {options}
          {error && (
            <p className="tool-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="button accent lg wide" disabled={!ready || !!busy} onClick={run}>
            {busy ? (
              <>
                <Loader2 size={18} className="spin" aria-hidden="true" /> {busy}
              </>
            ) : (
              tool.title
            )}
          </button>
          <div className="actions">
            {tool.multiple && (
              <button type="button" className="button" onClick={() => inputRef.current?.click()}>
                <Plus size={16} aria-hidden="true" /> Add files
              </button>
            )}
            <button type="button" className="button ghost" onClick={reset}>
              <RotateCcw size={16} aria-hidden="true" /> Start over
            </button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            multiple={tool.multiple}
            hidden
            onChange={(e) => {
              const f = e.target.files;
              void choose(f ? Array.from(f) : null);
              e.target.value = '';
            }}
          />
          {outputs.length > 0 && (
            <div className="results" aria-live="polite">
              <h3>{outputs.length === 1 ? 'Your file is ready' : `${outputs.length} files are ready`}</h3>
              {outputs.length > 1 && (
                <button type="button" className="button primary wide" onClick={downloadZip}>
                  <FileArchive size={16} aria-hidden="true" /> Download all (ZIP)
                </button>
              )}
              <ul>
                {outputs.map((o) => (
                  <li key={o.name}>
                    <a href={o.url} download={o.name} className={outputs.length === 1 ? 'button primary wide' : 'result-link'}>
                      <Download size={16} aria-hidden="true" /> {outputs.length === 1 ? `Download ${o.name}` : o.name}
                    </a>
                    <span className="muted">{fmtBytes(o.blob.size)}</span>
                  </li>
                ))}
              </ul>
              {outputs.length === 1 && outputs[0]!.pdf && (
                <button type="button" className="button wide" onClick={() => void openInEditor(outputs[0]!)}>
                  <FilePen size={16} aria-hidden="true" /> Continue in the editor
                </button>
              )}
            </div>
          )}
          <p className="privacy">
            <Lock size={14} aria-hidden="true" /> Processed in this browser — nothing is uploaded.
          </p>
        </aside>
      </div>
    </div>
  );
}
