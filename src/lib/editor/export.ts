import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { ASCENT, LINE_HEIGHT, displaySize, drawableText, norm, toDisplay, toPage, type Annot, type EditorState, type Rotation } from './model';

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
  if (doc.isEncrypted) throw new EditorError('This PDF is password-protected or encrypted. Remove the protection first, then open it again.');
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

function drawAnnot(page: PDFPage, font: PDFFont, a: Annot) {
  // The CropBox is what viewers (and the editor) show; it defaults to the MediaBox.
  const box = page.getCropBox();
  const W = box.width;
  const H = box.height;
  // Page space (top-left, normalized) → PDF user space (bottom-left, points).
  const user = (x: number, y: number) => ({ x: box.x + x * W, y: box.y + (1 - y) * H });
  if (a.kind === 'text') {
    const text = drawableText(a.text);
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
  const lo = user(a.x, a.y + a.h);
  const common = { x: lo.x, y: lo.y, width: a.w * W, height: a.h * H };
  if (a.kind === 'highlight') page.drawRectangle({ ...common, color: hex(a.color), opacity: 0.35, blendMode: 'Multiply' as never });
  else if (a.kind === 'whiteout') page.drawRectangle({ ...common, color: rgb(1, 1, 1) });
  else page.drawRectangle({ ...common, borderColor: hex(a.color), borderWidth: 1.5 });
}

export async function buildPdf(sources: Uint8Array[], s: EditorState, meta: { title?: string } = {}): Promise<Uint8Array> {
  if (!s.pages.length) throw new EditorError('The document has no pages.');
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const loaded = new Map<number, PDFDocument>();
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
    for (const a of s.annots[p.id] ?? []) drawAnnot(page!, font, a);
  }
  if (meta.title) out.setTitle(meta.title.slice(0, 200));
  out.setProducer('Rokela PDF Pro');
  out.setModificationDate(new Date());
  return out.save({ useObjectStreams: true });
}
