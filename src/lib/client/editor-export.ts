'use client';
import { PDFDocument } from 'pdf-lib';
import { buildPdf, EditorError } from '@/lib/editor/export';
import { norm, toDisplay, type EditorState } from '@/lib/editor/model';
import { closePdf, openPdf } from '@/components/editor/pdfjs';

let defaultFont: Promise<Uint8Array> | undefined;
async function fontBytes() {
  defaultFont ??= fetch('/fonts/NotoSans-Regular.ttf')
    .then(async (r) => {
      if (!r.ok) throw new EditorError('The Unicode font could not be loaded. Try again.');
      return new Uint8Array(await r.arrayBuffer());
    })
    .catch((e) => {
      defaultFont = undefined;
      throw e;
    });
  return defaultFont;
}

/** Redaction never returns the source PDF: every page is rendered into a new image-only document. */
export async function buildEditedPdf(sources: Uint8Array[], state: EditorState, meta: { title?: string; fontBytes?: Uint8Array } = {}) {
  const hasUnicode = Object.values(state.annots)
    .flat()
    .some((a) => a.kind === 'text' && /[^\n\r\x20-\x7e\xa0-\xff€‘’“”•–—…™]/.test(a.text));
  const bytes = await buildPdf(sources, state, { ...meta, ...(meta.fontBytes || hasUnicode ? { fontBytes: meta.fontBytes ?? (await fontBytes()) } : {}) });
  if (
    !Object.values(state.annots)
      .flat()
      .some((a) => a.kind === 'redact')
  )
    return bytes;
  const pdf = await openPdf(bytes);
  const out = await PDFDocument.create();
  try {
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, 5000 / Math.max(base.width, base.height), Math.sqrt(16000000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new EditorError('The page could not be redacted. No file was exported.');
      await page.render({ canvas, canvasContext: ctx, viewport, background: 'rgb(255,255,255)' }).promise;
      ctx.fillStyle = '#000000';
      // Apply masks after rendering, so existing annotations and form widgets cannot cover them.
      for (const a of state.annots[state.pages[i]!.id] ?? [])
        if (a.kind === 'redact') {
          const p = toDisplay(a.x, a.y, norm(page.rotate));
          const q = toDisplay(a.x + a.w, a.y + a.h, norm(page.rotate));
          const x = Math.floor(Math.min(p.u, q.u) * canvas.width) - 1;
          const y = Math.floor(Math.min(p.v, q.v) * canvas.height) - 1;
          ctx.fillRect(x, y, Math.ceil(Math.abs(q.u - p.u) * canvas.width) + 2, Math.ceil(Math.abs(q.v - p.v) * canvas.height) + 2);
        }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new EditorError('The redacted page could not be exported.'))), 'image/png'),
      );
      const image = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
      out.addPage([base.width, base.height]).drawImage(image, { x: 0, y: 0, width: base.width, height: base.height });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
    if (meta.title) out.setTitle(meta.title.slice(0, 200));
    out.setProducer('Rokela PDF Pro — redacted');
    return out.save();
  } finally {
    void closePdf(pdf);
  }
}
