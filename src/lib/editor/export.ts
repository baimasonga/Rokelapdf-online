import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { ASCENT, LINE_HEIGHT, displaySize, drawableText, norm, toDisplay, toPage, type Annot, type EditorState, type FieldAnnot, type Rotation } from './model';

// Builds the edited PDF: copies pages from the sources in the edited order, applies rotation, and draws annotations
// into the page content. Runs entirely in the browser (and in tests); the file never leaves the device unless the
// user saves it to a workspace.

export class EditorError extends Error {}

export async function loadSource(bytes: Uint8Array): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new EditorError('This file is not a readable PDF.');
  }
  if (doc.isEncrypted) throw new EditorError('This PDF is password-protected. Remove the password with the Unlock PDF tool, then open it again.');
  return doc;
}

/** A one-page PDF with a blank page of the given size (used for "insert blank page"). */
export async function blankPdf(width = 595.28, height = 841.89): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([width, height]);
  return d.save();
}

function hex(c: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  return m ? rgb(parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255) : rgb(0, 0, 0);
}

/** User-space rectangle (points, bottom-left origin) of a page-space box. */
function userRect(page: PDFPage, a: { x: number; y: number; w: number; h: number }) {
  const box = page.getCropBox();
  return { x: box.x + a.x * box.width, y: box.y + (1 - a.y - a.h) * box.height, width: a.w * box.width, height: a.h * box.height };
}

/**
 * Where to draw an image so it fills `rect` and is upright when the page is shown rotated by `rot` (clockwise, as
 * viewers apply /Rotate). pdf-lib rotates counter-clockwise about the image's bottom-left corner.
 */
export function imagePlacement(rect: { x: number; y: number; width: number; height: number }, rot: Rotation) {
  const [w, h] = rot % 180 ? [rect.height, rect.width] : [rect.width, rect.height];
  const t = (rot * Math.PI) / 180;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    x: cx - (w / 2) * Math.cos(t) + (h / 2) * Math.sin(t),
    y: cy - (w / 2) * Math.sin(t) - (h / 2) * Math.cos(t),
    width: w,
    height: h,
    rotate: degrees(rot),
  };
}

/** Decodes a PNG/JPEG data URL created by the editor. */
export function dataUrlBytes(src: string): { bytes: Uint8Array; type: 'png' | 'jpg' } {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(src);
  if (!m) throw new EditorError('A signature image is damaged. Remove it and add it again.');
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type: m[1] === 'png' ? 'png' : 'jpg' };
}

function addField(doc: PDFDocument, page: PDFPage, font: PDFFont, a: FieldAnnot, name: string) {
  const r = userRect(page, a);
  // pdf-lib takes the widget's origin and size in its rotated frame; rotate with the page so the field is upright.
  const rot = norm(page.getRotation().angle);
  const at =
    rot === 90
      ? { x: r.x + r.width, y: r.y, width: r.height, height: r.width }
      : rot === 180
        ? { x: r.x + r.width, y: r.y + r.height, width: r.width, height: r.height }
        : rot === 270
          ? { x: r.x, y: r.y + r.height, width: r.height, height: r.width }
          : r;
  const opts = { ...at, rotate: degrees(rot), borderWidth: 1, borderColor: hex(a.color), backgroundColor: rgb(1, 1, 1), font };
  const form = doc.getForm();
  if (a.field === 'checkbox') form.createCheckBox(name).addToPage(page, opts);
  else {
    const f = form.createTextField(name);
    f.addToPage(page, opts);
    if (r.height > 40) f.enableMultiline();
  }
}

function drawAnnot(page: PDFPage, font: PDFFont, a: Annot, images: Map<string, PDFImage>) {
  // The CropBox is what viewers (and the editor) show; it defaults to the MediaBox.
  const box = page.getCropBox();
  const W = box.width;
  const H = box.height;
  // Page space (top-left, normalized) → PDF user space (bottom-left, points).
  const user = (x: number, y: number) => ({ x: box.x + x * W, y: box.y + (1 - y) * H });
  if (a.kind === 'text') {
    const text = font.name === 'Helvetica' ? drawableText(a.text) : a.text.replace(/\r\n?/g, '\n');
    const d = displaySize(W, H, a.rot);
    const anchor = toDisplay(a.x, a.y, a.rot);
    text.split('\n').forEach((line, i) => {
      if (!line) return;
      // Baseline of this line on the view the text was placed in, then back to page space.
      const p = toPage(anchor.u, anchor.v + (a.size * (ASCENT + i * LINE_HEIGHT)) / d.h, a.rot);
      const u = user(p.x, p.y);
      page.drawText(line, { x: u.x, y: u.y, size: a.size, font, color: hex(a.color), rotate: degrees(a.rot) });
    });
    return;
  }
  if (a.kind === 'ink') {
    for (let i = 1; i < a.points.length; i++) {
      const p = user(...a.points[i - 1]!);
      const q = user(...a.points[i]!);
      page.drawLine({ start: p, end: q, thickness: a.width, color: hex(a.color), lineCap: 1 });
    }
    return;
  }
  if (a.kind === 'image') {
    const img = images.get(a.src);
    if (img) page.drawImage(img, imagePlacement(userRect(page, a), a.rot));
    return;
  }
  if (a.kind === 'field') return; // added as a form field after drawing
  const lo = user(a.x, a.y + a.h);
  const common = { x: lo.x, y: lo.y, width: a.w * W, height: a.h * H };
  if (a.kind === 'highlight') page.drawRectangle({ ...common, color: hex(a.color), opacity: 0.35, blendMode: 'Multiply' as never });
  else if (a.kind === 'redact') page.drawRectangle({ ...common, color: rgb(0, 0, 0) });
  else if (a.kind === 'whiteout') page.drawRectangle({ ...common, color: rgb(1, 1, 1) });
  else page.drawRectangle({ ...common, borderColor: hex(a.color), borderWidth: 1.5 });
}

export async function buildPdf(sources: Uint8Array[], s: EditorState, meta: { title?: string; fontBytes?: Uint8Array } = {}): Promise<Uint8Array> {
  if (!s.pages.length) throw new EditorError('The document has no pages.');
  const out = await PDFDocument.create();
  let font: PDFFont;
  if (meta.fontBytes) {
    const { default: fontkit } = await import('@pdf-lib/fontkit');
    out.registerFontkit(fontkit);
    font = await out.embedFont(meta.fontBytes, { subset: true });
    const supported = new Set(font.getCharacterSet());
    for (const a of Object.values(s.annots).flat())
      if (a.kind === 'text') {
        for (const ch of a.text)
          if (!/[\r\n\t]/.test(ch) && !supported.has(ch.codePointAt(0)!))
            throw new EditorError('The selected font does not support every character. Choose a font that covers this language.');
      }
  } else font = await out.embedFont(StandardFonts.Helvetica);
  const loaded = new Map<number, PDFDocument>();
  const images = new Map<string, PDFImage>();
  const names = new Set<string>();
  // Each distinct signature is embedded once, however often it is placed.
  for (const a of Object.values(s.annots).flat())
    if (a.kind === 'image' && !images.has(a.src)) {
      const { bytes, type } = dataUrlBytes(a.src);
      try {
        images.set(a.src, type === 'png' ? await out.embedPng(bytes) : await out.embedJpg(bytes));
      } catch {
        throw new EditorError('A signature image is damaged. Remove it and add it again.');
      }
    }
  for (const p of s.pages) {
    let src = loaded.get(p.src);
    if (!src) {
      const bytes = sources[p.src];
      if (!bytes) throw new EditorError('A source file is missing.');
      src = await loadSource(bytes);
      loaded.set(p.src, src);
    }
    const [page] = await out.copyPages(src, [p.index]);
    const total: Rotation = norm(page!.getRotation().angle + p.rotation);
    page!.setRotation(degrees(total));
    out.addPage(page!);
    for (const a of s.annots[p.id] ?? []) drawAnnot(page!, font, a, images);
    for (const a of s.annots[p.id] ?? [])
      if (a.kind === 'field') {
        // Names are unique in the editor; this guards against a name a source form already uses.
        let name = a.name;
        for (let i = 2; names.has(name) || out.getForm().getFieldMaybe(name); i++) name = `${a.name} ${i}`;
        names.add(name);
        addField(out, page!, font, a, name);
      }
  }
  if (meta.title) out.setTitle(meta.title.slice(0, 200));
  out.setProducer('Rokela PDF Pro');
  out.setModificationDate(new Date());
  return out.save({ useObjectStreams: true });
}
