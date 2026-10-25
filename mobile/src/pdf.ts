import type { PDFDocumentProxy } from 'pdfjs-dist';
// The legacy build, like the website: the modern one needs very recent JavaScript built-ins that older Android
// WebViews (and Chromium before ~145) do not have, and fails to render there.
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import worker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = worker;

/** Character maps, fonts and decoders bundled with the app (public/pdfjs), so every PDF renders offline. */
const asset = (p: string) => new URL(p, document.baseURI).href;
export const PDF_DATA = {
  cMapUrl: asset('pdfjs/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: asset('pdfjs/standard_fonts/'),
  wasmUrl: asset('pdfjs/wasm/'),
  iccUrl: asset('pdfjs/iccs/'),
  enableXfa: false,
};

/** Thrown when a PDF needs a password to open. */
export class PasswordRequired extends Error {}

/** An open document and the means to release its worker resources. */
export interface OpenPdf {
  doc: PDFDocumentProxy;
  close(): Promise<void>;
}

export async function openPdf(bytes: Uint8Array): Promise<OpenPdf> {
  // pdf.js takes ownership of the buffer it is given; keep the caller's copy usable for sharing.
  const task = getDocument({ data: bytes.slice(), ...PDF_DATA });
  try {
    return { doc: await task.promise, close: () => task.destroy() };
  } catch (e) {
    void task.destroy();
    if ((e as Error)?.name === 'PasswordException') throw new PasswordRequired('This PDF is password-protected.');
    throw new Error('This file could not be opened as a PDF.');
  }
}

/** Renders one page to fit `width` CSS pixels. Resolution is capped to keep memory low on small phones. */
export async function renderPage(doc: PDFDocumentProxy, n: number, canvas: HTMLCanvasElement, width: number) {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (width / base.width) * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${(width / base.width) * base.height}px`;
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
}
