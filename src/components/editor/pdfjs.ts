'use client';
import type { PDFDocumentProxy } from 'pdfjs-dist';

// The legacy build: the modern one relies on very recent built-ins (e.g. Map.prototype.getOrInsertComputed) that
// many current browsers do not have yet.

// pdf.js is loaded lazily in the browser only. The worker and its data files are served from this origin
// (public/pdfjs, copied at install time), (pdf.js 5 does not use eval).
type PdfJs = typeof import('pdfjs-dist');
let mod: Promise<PdfJs> | undefined;

export function pdfjs(): Promise<PdfJs> {
  mod ??= (import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfJs>).then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
    return m;
  });
  return mod;
}

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  // pdf.js transfers the buffer to its worker, so give it a copy.
  return m.getDocument({
    data: bytes.slice(),
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    iccUrl: '/pdfjs/iccs/',
    enableXfa: false,
  }).promise;
}

/** Releases a document and its worker resources (pdf.js 6: owned by the loading task). */
export function closePdf(doc: PDFDocumentProxy | undefined): Promise<void> {
  return doc ? doc.loadingTask.destroy() : Promise.resolve();
}
