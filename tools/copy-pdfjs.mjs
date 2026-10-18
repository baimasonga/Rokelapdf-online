// Copies the pdf.js worker and its data files into public/pdfjs so they are served from our own origin
// (CSP: worker-src 'self'). Runs on install and before dev/build; the output is not committed.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const out = join(root, 'public', 'pdfjs');
if (!existsSync(src)) throw new Error('pdfjs-dist is not installed');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The legacy build supports the browsers our users have (the modern build needs very recent JS built-ins).
cpSync(join(src, 'legacy', 'build', 'pdf.worker.min.mjs'), join(out, 'pdf.worker.min.mjs'));
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) if (existsSync(join(src, d))) cpSync(join(src, d), join(out, d), { recursive: true });

// OCR (tesseract.js): worker, WebAssembly cores (plain/SIMD/relaxed-SIMD; the worker picks one) and the English
// model, served from public/ocr so OCR needs no third-party CDN. Downloaded by browsers only when OCR is used.
const ocr = join(root, 'public', 'ocr');
rmSync(ocr, { recursive: true, force: true });
mkdirSync(join(ocr, 'core'), { recursive: true });
mkdirSync(join(ocr, 'lang'), { recursive: true });
const tjs = join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
const core = join(root, 'node_modules', 'tesseract.js-core');
const lang = join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz');
if (existsSync(tjs) && existsSync(core) && existsSync(lang)) {
  cpSync(tjs, join(ocr, 'worker.min.js'));
  for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'])
    cpSync(join(core, f), join(ocr, 'core', f));
  cpSync(lang, join(ocr, 'lang', 'eng.traineddata.gz'));
}

// Additional OCR languages remain local to this origin; no document data or model request goes to a CDN.
for (const language of ['fra', 'spa', 'deu', 'por']) {
  const model = join(root, 'node_modules', '@tesseract.js-data', language, '4.0.0_best_int', `${language}.traineddata.gz`);
  if (existsSync(model)) cpSync(model, join(ocr, 'lang', `${language}.traineddata.gz`));
}
