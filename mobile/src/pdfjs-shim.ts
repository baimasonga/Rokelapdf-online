import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import { PDF_DATA } from './pdf';

// Stands in for the web app's src/components/editor/pdfjs.ts in shared code (OCR, image tools): the same API, backed by
// the app's pdf.js and the data files bundled in public/pdfjs.

export const pdfjs = () => import('pdfjs-dist');

export function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({ data: bytes.slice(), ...PDF_DATA }).promise;
}

export function closePdf(doc: PDFDocumentProxy | undefined): Promise<void> {
  return doc ? doc.loadingTask.destroy() : Promise.resolve();
}
