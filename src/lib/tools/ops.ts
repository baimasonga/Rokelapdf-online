import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFTextField,
  StandardFonts,
  TextRenderingMode,
  beginText,
  degrees,
  endText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import { unzlibSync } from 'fflate';
import { loadSource, EditorError } from '../editor/export';
import { drawableText, norm, toPage, displaySize, type Rotation } from '../editor/model';

// PDF tools that run entirely in the browser (and in tests). Every function takes PDF bytes and returns new bytes;
// nothing is uploaded. Errors are EditorError with a message written for the person using the tool.

export { EditorError as ToolError };
const fail = (msg: string): never => {
  throw new EditorError(msg);
};

export interface NamedPdf {
  name: string;
  bytes: Uint8Array;
}

const save = (d: PDFDocument) => d.save({ useObjectStreams: true });

async function load(bytes: Uint8Array) {
  return loadSource(bytes);
}

// ---- page ranges -----------------------------------------------------------------------------------------
/**
 * Parses a page selection such as "1-3, 5, 8-" (1-based, inclusive, "8-" means to the end) into sorted, unique
 * zero-based indices. Throws a readable error for anything outside the document.
 */
export function parseRanges(spec: string, pageCount: number): number[] {
  const out = new Set<number>();
  const parts = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) fail('Enter the pages, for example 1-3, 5.');
  for (const p of parts) {
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(p);
    if (!m || (!m[1] && !m[3])) fail(`“${p}” is not a page or range.`);
    const a = m![1] ? Number(m![1]) : 1;
    const b = m![2] ? (m![3] ? Number(m![3]) : pageCount) : a;
    if (a < 1 || b < 1 || a > pageCount || b > pageCount)
      fail(`Page ${Math.max(a, b)} does not exist; this PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
    if (a > b) fail(`“${p}” goes backwards; write it as ${b}-${a}.`);
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

/** Splits a selection into contiguous groups, e.g. [0,1,2,5] → [[0,1,2],[5]]. */
function groups(indices: number[]): number[][] {
  const out: number[][] = [];
  for (const i of indices) {
    const last = out[out.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else out.push([i]);
  }
  return out;
}

async function copy(src: PDFDocument, indices: number[]): Promise<PDFDocument> {
  const d = await PDFDocument.create();
  for (const p of await d.copyPages(src, indices)) d.addPage(p);
  return d;
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await load(bytes)).getPageCount();
}

// ---- organize --------------------------------------------------------------------------------------------
export async function mergePdfs(files: Uint8Array[]): Promise<Uint8Array> {
  if (files.length < 2) fail('Choose at least two PDFs to merge.');
  const out = await PDFDocument.create();
  for (const f of files) {
    const src = await load(f);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return save(out);
}

export type SplitMode = { kind: 'ranges'; spec: string } | { kind: 'every'; n: number } | { kind: 'each' };

export async function splitPdf(bytes: Uint8Array, mode: SplitMode, baseName = 'document'): Promise<NamedPdf[]> {
  const src = await load(bytes);
  const total = src.getPageCount();
  let sets: number[][];
  if (mode.kind === 'each') sets = src.getPageIndices().map((i) => [i]);
  else if (mode.kind === 'every') {
    if (!Number.isInteger(mode.n) || mode.n < 1) fail('Enter how many pages each file should have.');
    sets = [];
    for (let i = 0; i < total; i += mode.n) sets.push(src.getPageIndices().slice(i, i + mode.n));
  } else {
    // Each comma-separated part becomes its own file.
    sets = mode.spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((part) => parseRanges(part, total));
    if (!sets.length) fail('Enter the page ranges, for example 1-3, 4-6.');
  }
  if (sets.length === 1 && sets[0]!.length === total) fail('That would produce the same document. Choose smaller ranges.');
  const out: NamedPdf[] = [];
  for (const s of sets) {
    const label = groups(s)
      .map((g) => (g.length === 1 ? `${g[0]! + 1}` : `${g[0]! + 1}-${g[g.length - 1]! + 1}`))
      .join('_');
    out.push({ name: `${baseName}-pages-${label}.pdf`, bytes: await save(await copy(src, s)) });
  }
  return out;
}

export async function extractPages(bytes: Uint8Array, spec: string): Promise<Uint8Array> {
  const src = await load(bytes);
  return save(await copy(src, parseRanges(spec, src.getPageCount())));
}

export async function deletePages(bytes: Uint8Array, spec: string): Promise<Uint8Array> {
  const src = await load(bytes);
  const drop = new Set(parseRanges(spec, src.getPageCount()));
  const keep = src.getPageIndices().filter((i) => !drop.has(i));
  if (!keep.length) fail('You cannot delete every page.');
  return save(await copy(src, keep));
}

/** Rotates the selected pages (all when `spec` is empty) clockwise by 90, 180 or 270 degrees. */
export async function rotatePages(bytes: Uint8Array, by: 90 | 180 | 270, spec = ''): Promise<Uint8Array> {
  const d = await load(bytes);
  const sel = spec.trim() ? new Set(parseRanges(spec, d.getPageCount())) : undefined;
  d.getPages().forEach((p, i) => {
    if (!sel || sel.has(i)) p.setRotation(degrees(norm(p.getRotation().angle + by)));
  });
  return save(d);
}

/** Reorders pages: `order` lists every zero-based page index exactly once in the new order. */
export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  const src = await load(bytes);
  const n = src.getPageCount();
  if (order.length !== n || new Set(order).size !== n || order.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) fail('The new page order is incomplete.');
  return save(await copy(src, order));
}

/** One page of an organized document: a page from one of the source PDFs (with added rotation), or a blank page. */
export type PagePlan = { src: number; index: number; rotate: 0 | 90 | 180 | 270 } | { blank: true };

/**
 * Builds a new PDF from pages of several source PDFs in the given order, adding rotation, with blank pages where asked
 * (sized like the page before them, or A4 at the start).
 */
export async function organizePdf(sources: Uint8Array[], plan: PagePlan[]): Promise<Uint8Array> {
  if (!plan.length) fail('Keep at least one page.');
  if (plan.length > 5000) fail('That is too many pages.');
  const docs = [];
  for (const b of sources) docs.push(await load(b));
  const out = await PDFDocument.create();
  let last: [number, number] = [...SIZES.A4] as [number, number];
  for (const p of plan) {
    if ('blank' in p) {
      out.addPage(last);
      continue;
    }
    const src = docs[p.src];
    if (!src || !Number.isInteger(p.index) || p.index < 0 || p.index >= src.getPageCount()) fail('A page in the new order no longer exists.');
    if (![0, 90, 180, 270].includes(p.rotate)) fail('Pages can only be turned in quarter turns.');
    const [page] = await out.copyPages(src!, [p.index]);
    page!.setRotation(degrees(norm(page!.getRotation().angle + p.rotate)));
    out.addPage(page!);
    last = [page!.getWidth(), page!.getHeight()];
  }
  return save(out);
}

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Crops by percentages of each page's visible size (0–45 per side). The crop applies to the page as displayed, so
 * "top" means the top the reader sees, even on rotated pages.
 */
export async function cropPages(bytes: Uint8Array, m: Margins, spec = ''): Promise<Uint8Array> {
  for (const v of Object.values(m)) if (!(v >= 0 && v <= 45)) fail('Each margin must be between 0% and 45%.');
  if (!m.top && !m.right && !m.bottom && !m.left) fail('Set at least one margin to crop.');
  const d = await load(bytes);
  const sel = spec.trim() ? new Set(parseRanges(spec, d.getPageCount())) : undefined;
  d.getPages().forEach((p, i) => {
    if (sel && !sel.has(i)) return;
    const b = p.getCropBox();
    // Map the displayed margins onto the unrotated box.
    const r = norm(p.getRotation().angle);
    const [t, rt, bt, l] =
      r === 0
        ? [m.top, m.right, m.bottom, m.left]
        : r === 90
          ? [m.right, m.bottom, m.left, m.top]
          : r === 180
            ? [m.bottom, m.left, m.top, m.right]
            : [m.left, m.top, m.right, m.bottom];
    const x = b.x + (b.width * l) / 100;
    const y = b.y + (b.height * bt) / 100;
    p.setCropBox(x, y, b.width * (1 - (l + rt) / 100), b.height * (1 - (t + bt) / 100));
  });
  return save(d);
}

const SIZES = { A4: [595.28, 841.89], Letter: [612, 792] } as const;

/** Inserts `count` blank pages after page `after` (0 = at the start); size "same" copies the neighbouring page. */
export async function addBlankPages(bytes: Uint8Array, opts: { after: number; count: number; size: 'same' | 'A4' | 'Letter' }): Promise<Uint8Array> {
  const d = await load(bytes);
  const n = d.getPageCount();
  if (!Number.isInteger(opts.after) || opts.after < 0 || opts.after > n) fail(`Choose a position between 0 and ${n}.`);
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 100) fail('Add between 1 and 100 pages.');
  const ref = d.getPage(Math.min(Math.max(opts.after - 1, 0), n - 1));
  const [w, h] = opts.size === 'same' ? [ref.getWidth(), ref.getHeight()] : SIZES[opts.size];
  for (let i = 0; i < opts.count; i++) d.insertPage(opts.after + i, [w, h]);
  return save(d);
}

/** Inserts all pages of another PDF after page `after` (0 = at the start). */
export async function insertPdf(bytes: Uint8Array, other: Uint8Array, after: number): Promise<Uint8Array> {
  const d = await load(bytes);
  if (!Number.isInteger(after) || after < 0 || after > d.getPageCount()) fail(`Choose a position between 0 and ${d.getPageCount()}.`);
  const src = await load(other);
  const pages = await d.copyPages(src, src.getPageIndices());
  pages.forEach((p, i) => d.insertPage(after + i, p));
  return save(d);
}

// ---- text stamped on pages (watermark, page numbers) --------------------------------------------------------
function hex(c: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (!m) fail('Choose a colour.');
  return rgb(parseInt(m![1]!, 16) / 255, parseInt(m![2]!, 16) / 255, parseInt(m![3]!, 16) / 255);
}

/**
 * Draws one line of text centred at (cx, cy) in *displayed* page points (top-left origin, as the reader sees the
 * page), turned `turn` degrees counter-clockwise from upright. Works for any page rotation and crop box.
 */
function drawCentered(
  page: PDFPage,
  font: PDFFont,
  text: string,
  size: number,
  cx: number,
  cy: number,
  turn: number,
  opts: { color: ReturnType<typeof rgb>; opacity: number },
) {
  const box = page.getCropBox();
  const r: Rotation = norm(page.getRotation().angle);
  const d = displaySize(box.width, box.height, r);
  const w = font.widthOfTextAtSize(text, size);
  const capH = font.heightAtSize(size, { descender: false }) * 0.72;
  const t = (turn * Math.PI) / 180;
  // Baseline start in display coordinates (y grows downwards).
  const sx = cx - (w / 2) * Math.cos(t) + (capH / 2) * Math.sin(t);
  const sy = cy + (w / 2) * Math.sin(t) + (capH / 2) * Math.cos(t);
  const p = toPage(sx / d.w, sy / d.h, r);
  page.drawText(text, {
    x: box.x + p.x * box.width,
    y: box.y + (1 - p.y) * box.height,
    size,
    font,
    color: opts.color,
    opacity: opts.opacity,
    rotate: degrees(r + turn),
  });
}

export interface WatermarkOptions {
  text: string;
  fontSize: number;
  opacity: number; // 0.05–1
  color: string; // #rrggbb
  layout: 'diagonal' | 'center' | 'tile';
}

export async function addWatermark(bytes: Uint8Array, o: WatermarkOptions, spec = ''): Promise<Uint8Array> {
  const text = drawableText(o.text).replace(/\n/g, ' ').trim();
  if (!text) fail('Enter the watermark text.');
  if (text.length > 120) fail('Keep the watermark under 120 characters.');
  if (!(o.fontSize >= 6 && o.fontSize <= 200)) fail('Choose a size between 6 and 200.');
  if (!(o.opacity >= 0.05 && o.opacity <= 1)) fail('Choose an opacity between 5% and 100%.');
  const d = await load(bytes);
  const font = await d.embedFont(StandardFonts.HelveticaBold);
  const color = hex(o.color);
  const sel = spec.trim() ? new Set(parseRanges(spec, d.getPageCount())) : undefined;
  d.getPages().forEach((page, i) => {
    if (sel && !sel.has(i)) return;
    const box = page.getCropBox();
    const dims = displaySize(box.width, box.height, norm(page.getRotation().angle));
    if (o.layout === 'tile') {
      const stepX = font.widthOfTextAtSize(text, o.fontSize) + o.fontSize * 3;
      const stepY = o.fontSize * 5;
      for (let y = stepY / 2; y < dims.h + stepY; y += stepY)
        for (let x = (Math.round(y / stepY) % 2) * (stepX / 2); x < dims.w + stepX; x += stepX)
          drawCentered(page, font, text, o.fontSize, x, y, 30, { color, opacity: o.opacity });
    } else {
      const turn = o.layout === 'diagonal' ? (Math.atan2(dims.h, dims.w) * 180) / Math.PI : 0;
      drawCentered(page, font, text, o.fontSize, dims.w / 2, dims.h / 2, turn, { color, opacity: o.opacity });
    }
  });
  return save(d);
}

export interface PageNumberOptions {
  position: 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left';
  format: 'n' | 'page-n' | 'n-of-total' | 'page-n-of-total';
  start: number;
  fontSize: number;
  margin: number; // points from the edge
  skipFirst: boolean;
}

export function pageLabel(format: PageNumberOptions['format'], n: number, total: number): string {
  return format === 'n' ? `${n}` : format === 'page-n' ? `Page ${n}` : format === 'n-of-total' ? `${n} / ${total}` : `Page ${n} of ${total}`;
}

export async function addPageNumbers(bytes: Uint8Array, o: PageNumberOptions): Promise<Uint8Array> {
  if (!Number.isInteger(o.start) || o.start < 0 || o.start > 100000) fail('Start numbering from 0 or more.');
  if (!(o.fontSize >= 6 && o.fontSize <= 48)) fail('Choose a size between 6 and 48.');
  if (!(o.margin >= 6 && o.margin <= 144)) fail('Choose a margin between 6 and 144 points.');
  const d = await load(bytes);
  const font = await d.embedFont(StandardFonts.Helvetica);
  const pages = d.getPages();
  const numbered = pages.length - (o.skipFirst ? 1 : 0);
  const lastNumber = o.start + numbered - 1;
  pages.forEach((page, i) => {
    if (o.skipFirst && i === 0) return;
    const n = o.start + i - (o.skipFirst ? 1 : 0);
    const label = pageLabel(o.format, n, lastNumber);
    const box = page.getCropBox();
    const dims = displaySize(box.width, box.height, norm(page.getRotation().angle));
    const w = font.widthOfTextAtSize(label, o.fontSize);
    const [vert, horiz] = o.position.split('-') as ['top' | 'bottom', 'center' | 'left' | 'right'];
    const cx = horiz === 'center' ? dims.w / 2 : horiz === 'left' ? o.margin + w / 2 : dims.w - o.margin - w / 2;
    const cy = vert === 'top' ? o.margin + o.fontSize / 2 : dims.h - o.margin - o.fontSize / 2;
    drawCentered(page, font, label, o.fontSize, cx, cy, 0, { color: rgb(0.15, 0.15, 0.15), opacity: 1 });
  });
  return save(d);
}

// ---- forms ---------------------------------------------------------------------------------------------------
export interface FormFieldInfo {
  name: string;
  type: 'text' | 'checkbox' | 'dropdown' | 'radio' | 'list';
  value: string | boolean;
  options: string[];
  multiline: boolean;
  readOnly: boolean;
}

export async function listFormFields(bytes: Uint8Array): Promise<FormFieldInfo[]> {
  const d = await load(bytes);
  return d
    .getForm()
    .getFields()
    .map((f): FormFieldInfo | undefined => {
      const base = { name: f.getName(), readOnly: f.isReadOnly(), options: [] as string[], multiline: false };
      if (f instanceof PDFTextField) return { ...base, type: 'text', value: f.getText() ?? '', multiline: f.isMultiline() };
      if (f instanceof PDFCheckBox) return { ...base, type: 'checkbox', value: f.isChecked() };
      if (f instanceof PDFDropdown) return { ...base, type: 'dropdown', value: f.getSelected()[0] ?? '', options: f.getOptions() };
      if (f instanceof PDFOptionList) return { ...base, type: 'list', value: f.getSelected()[0] ?? '', options: f.getOptions() };
      if (f instanceof PDFRadioGroup) return { ...base, type: 'radio', value: f.getSelected() ?? '', options: f.getOptions() };
      return undefined; // buttons and signature fields are not fillable here
    })
    .filter((f): f is FormFieldInfo => !!f);
}

/** Fills form fields by name. With `flatten`, the values become part of the page and can no longer be edited. */
export async function fillForm(bytes: Uint8Array, values: Record<string, string | boolean>, flatten = false): Promise<Uint8Array> {
  const d = await load(bytes);
  const form = d.getForm();
  if (!form.getFields().length) fail('This PDF has no fillable fields.');
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (const [name, v] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f || f.isReadOnly()) continue;
    if (f instanceof PDFTextField) f.setText(drawableText(String(v)).slice(0, f.getMaxLength() ?? 10000));
    else if (f instanceof PDFCheckBox) {
      if (v === true || v === 'true') f.check();
      else f.uncheck();
    } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
      if (v === '') f.clear();
      else if (f.getOptions().includes(String(v))) f.select(String(v));
    } else if (f instanceof PDFRadioGroup) {
      if (v === '') f.clear();
      else if (f.getOptions().includes(String(v))) f.select(String(v));
    }
  }
  form.updateFieldAppearances(font);
  if (flatten) form.flatten();
  return save(d);
}

/** Makes form fields part of the page content, so the PDF looks the same everywhere and can't be changed. */
export async function flattenPdf(bytes: Uint8Array): Promise<{ bytes: Uint8Array; fields: number }> {
  const d = await load(bytes);
  const form = d.getForm();
  const fields = form.getFields().length;
  if (fields) {
    form.updateFieldAppearances(await d.embedFont(StandardFonts.Helvetica));
    form.flatten();
  }
  return { bytes: await save(d), fields };
}

// ---- images --------------------------------------------------------------------------------------------------
export interface ImageInput {
  bytes: Uint8Array;
  type: 'image/jpeg' | 'image/png';
}
export interface ImagesToPdfOptions {
  pageSize: 'fit' | 'A4' | 'Letter';
  orientation: 'auto' | 'portrait' | 'landscape';
  margin: number; // points
}

export async function imagesToPdf(images: ImageInput[], o: ImagesToPdfOptions): Promise<Uint8Array> {
  if (!images.length) fail('Choose at least one image.');
  if (!(o.margin >= 0 && o.margin <= 144)) fail('Choose a margin between 0 and 144 points.');
  const d = await PDFDocument.create();
  for (const img of images) {
    let e;
    try {
      e = img.type === 'image/png' ? await d.embedPng(img.bytes) : await d.embedJpg(img.bytes);
    } catch {
      fail('One of the images could not be read. Use JPG or PNG files.');
    }
    const { width: iw, height: ih } = e!;
    let pw: number;
    let ph: number;
    if (o.pageSize === 'fit') [pw, ph] = [iw + 2 * o.margin, ih + 2 * o.margin];
    else {
      const [a, b] = SIZES[o.pageSize];
      const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && iw > ih);
      [pw, ph] = landscape ? [b, a] : [a, b];
    }
    const page = d.addPage([pw, ph]);
    const scale = Math.min((pw - 2 * o.margin) / iw, (ph - 2 * o.margin) / ih, o.pageSize === 'fit' ? 1 : Infinity);
    const w = iw * scale;
    const h = ih * scale;
    page.drawImage(e!, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return save(d);
}

// ---- compress ------------------------------------------------------------------------------------------------
/**
 * An image to re-encode: either a JPEG file (`jpeg`) or raw 8-bit pixels (`raw`, gray or RGB, row-major). The
 * recoder scales it so neither side exceeds `maxSide` and returns JPEG bytes, or undefined to keep the original.
 */
export type RecodeInput =
  { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number } | { kind: 'raw'; pixels: Uint8Array; channels: 1 | 3; width: number; height: number };
export type ImageRecoder = (
  img: RecodeInput,
  opts: { maxSide: number; quality: number },
) => Promise<{ bytes: Uint8Array; width: number; height: number } | undefined>;

export type CompressLevel = 'light' | 'recommended' | 'strong';
export const COMPRESS_LEVELS: Record<CompressLevel, { maxSide: number; quality: number }> = {
  light: { maxSide: 2400, quality: 0.85 },
  recommended: { maxSide: 1600, quality: 0.72 },
  strong: { maxSide: 1000, quality: 0.5 },
};

export interface CompressResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  /** Images re-encoded smaller. */
  images: number;
}

const num = (d: PDFDict, key: string) => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
};
const nameOf = (d: PDFDict, key: string) => {
  const v = d.lookup(PDFName.of(key));
  if (v instanceof PDFName) return v.decodeText();
  if (v instanceof PDFArray && v.size() === 1) {
    const one = v.lookup(0);
    return one instanceof PDFName ? one.decodeText() : undefined;
  }
  return undefined;
};

/**
 * Makes a PDF smaller by re-encoding its photos and scans as lighter JPEGs (downscaled to the level's size), and by
 * saving with compressed object streams. Text, fonts and vector drawings are untouched, so they stay sharp and
 * selectable. Only formats that can be re-encoded faithfully are touched (JPEG, and 8-bit gray/RGB Flate images
 * without predictors or decode arrays); masks, CMYK, indexed and JPEG 2000 images are kept as they are. An image
 * is replaced only when the new version is smaller.
 */
export async function compressPdf(bytes: Uint8Array, level: CompressLevel, recode: ImageRecoder): Promise<CompressResult> {
  const opts = COMPRESS_LEVELS[level];
  if (!opts) fail('Choose a compression level.');
  const d = await load(bytes);
  let images = 0;
  for (const [ref, obj] of d.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (nameOf(dict, 'Subtype') !== 'Image' || dict.lookup(PDFName.of('ImageMask'))?.toString() === 'true') continue;
    if (dict.has(PDFName.of('Decode')) || dict.has(PDFName.of('Mask'))) continue;
    const width = num(dict, 'Width');
    const height = num(dict, 'Height');
    const bpc = num(dict, 'BitsPerComponent');
    const cs = nameOf(dict, 'ColorSpace');
    const filter = nameOf(dict, 'Filter');
    if (!width || !height || bpc !== 8 || (cs !== 'DeviceRGB' && cs !== 'DeviceGray')) continue;
    if (obj.contents.length < 8 * 1024) continue; // not worth it
    let input: RecodeInput | undefined;
    if (filter === 'DCTDecode') input = { kind: 'jpeg', bytes: obj.contents, width, height };
    else if (filter === 'FlateDecode' && !dict.has(PDFName.of('DecodeParms'))) {
      const channels = cs === 'DeviceRGB' ? 3 : 1;
      let pixels: Uint8Array;
      try {
        pixels = unzlibSync(obj.contents);
      } catch {
        continue;
      }
      if (pixels.length !== width * height * channels) continue;
      input = { kind: 'raw', pixels, channels, width, height };
    }
    if (!input) continue;
    const out = await recode(input, opts);
    if (!out || out.bytes.length >= obj.contents.length) continue;
    const next = dict.clone(d.context);
    next.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    // Encoders write colour (YCbCr) JPEGs, even for grey input.
    next.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
    next.set(PDFName.of('Width'), PDFNumber.of(out.width));
    next.set(PDFName.of('Height'), PDFNumber.of(out.height));
    next.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    next.delete(PDFName.of('DecodeParms'));
    next.delete(PDFName.of('Length'));
    d.context.assign(ref, PDFRawStream.of(next, out.bytes));
    images++;
  }
  const result = await save(d);
  // Never hand back something bigger than what came in.
  const smaller = result.length < bytes.length;
  return { bytes: smaller ? result : bytes, before: bytes.length, after: smaller ? result.length : bytes.length, images: smaller ? images : 0 };
}

// ---- OCR text layer ------------------------------------------------------------------------------------------
/** A recognised word, in PDF user space (points): baseline start, baseline end and the top of the word's start. */
export interface OcrWord {
  text: string;
  p0: [number, number];
  p1: [number, number];
  p2: [number, number];
}

/**
 * Adds an invisible, selectable text layer (text rendering mode 3) on top of scanned pages, one run per recognised
 * word, stretched and turned to cover the word on the page. The page's appearance does not change; the words become
 * searchable and copyable. Characters the built-in font cannot encode become "?".
 */
export async function addTextLayer(bytes: Uint8Array, pages: Array<{ index: number; words: OcrWord[] }>): Promise<Uint8Array> {
  const d = await load(bytes);
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (const { index, words } of pages) {
    const page = d.getPages()[index];
    if (!page || !words.length) continue;
    const key = page.node.newFontDictionary('OCR', font.ref);
    const ops = [pushGraphicsState(), beginText(), setFontAndSize(key, 1), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const w of words) {
      const text = drawableText(w.text).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const w1 = font.widthOfTextAtSize(text, 1);
      const ux = w.p1[0] - w.p0[0];
      const uy = w.p1[1] - w.p0[1];
      const vx = w.p2[0] - w.p0[0];
      const vy = w.p2[1] - w.p0[1];
      if (!w1 || (!ux && !uy) || (!vx && !vy)) continue;
      ops.push(setTextMatrix(ux / w1, uy / w1, vx, vy, w.p0[0], w.p0[1]), showText(font.encodeText(text)));
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  }
  return save(d);
}
