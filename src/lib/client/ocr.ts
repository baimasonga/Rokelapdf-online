'use client';
import { closePdf, openPdf } from '@/components/editor/pdfjs';
import { addTextLayer, type OcrWord } from '@/lib/tools/ops';

// OCR in the browser: each page without real text is rendered with pdf.js, read by Tesseract (WebAssembly, served
// from /ocr on this origin), and the recognised words are added back as an invisible text layer. Nothing is
// uploaded; the English model is downloaded once and cached by the browser.

const DPI = 300;
const MAX_SIDE = 5000;
const MIN_CONFIDENCE = 40;

export interface OcrProgress {
  page: number;
  pages: number;
  stage: 'loading' | 'reading' | 'skipped';
}

export interface OcrResult {
  bytes: Uint8Array;
  pagesRead: number;
  pagesSkipped: number;
  words: number;
}

export async function ocrPdf(bytes: Uint8Array, onProgress?: (p: OcrProgress) => void): Promise<OcrResult> {
  const doc = await openPdf(bytes);
  onProgress?.({ page: 0, pages: doc.numPages, stage: 'loading' });
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr/core',
    langPath: '/ocr/lang',
    gzip: true,
    workerBlobURL: false,
  });
  const pages: Array<{ index: number; words: OcrWord[] }> = [];
  let skipped = 0;
  let count = 0;
  try {
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      // Pages that already carry real text are left alone (born-digital pages, or OCR done before).
      const existing = (await page.getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join('');
      if (existing.replace(/\s+/g, '').length > 25) {
        skipped++;
        onProgress?.({ page: i + 1, pages: doc.numPages, stage: 'skipped' });
        continue;
      }
      onProgress?.({ page: i + 1, pages: doc.numPages, stage: 'reading' });
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(DPI / 72, MAX_SIDE / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Your browser could not prepare the page for reading.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      canvas.width = canvas.height = 0;
      page.cleanup();
      const pt = (x: number, y: number) => vp.convertToPdfPoint(x, y) as [number, number];
      const words: OcrWord[] = [];
      for (const block of data.blocks ?? [])
        for (const para of block.paragraphs)
          for (const line of para.lines)
            for (const w of line.words) {
              if (w.confidence < MIN_CONFIDENCE || !w.text.trim()) continue;
              const b = w.bbox;
              words.push({ text: w.text, p0: pt(b.x0, b.y1), p1: pt(b.x1, b.y1), p2: pt(b.x0, b.y0) });
            }
      count += words.length;
      pages.push({ index: i, words });
    }
  } finally {
    await worker.terminate().catch(() => undefined);
    void closePdf(doc);
  }
  const out = pages.some((p) => p.words.length) ? await addTextLayer(bytes, pages) : bytes;
  return { bytes: out, pagesRead: pages.length, pagesSkipped: skipped, words: count };
}
