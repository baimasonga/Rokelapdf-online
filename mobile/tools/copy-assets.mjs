// Copies data files the app loads at run time into public/ (served from the app itself, never a CDN):
// pdf.js character maps, standard fonts and decoders, and the OCR engine with its English model.
// Runs before every build; the output is not committed.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const pub = join(root, 'public');
const need = (p) => {
  if (!existsSync(p)) throw new Error(`missing ${p}: run npm ci in mobile/`);
  return p;
};

const pdfjs = join(pub, 'pdfjs');
rmSync(pdfjs, { recursive: true, force: true });
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(need(join(nm, 'pdfjs-dist', d)), join(pdfjs, d), { recursive: true });

const ocr = join(pub, 'ocr');
rmSync(ocr, { recursive: true, force: true });
mkdirSync(join(ocr, 'core'), { recursive: true });
mkdirSync(join(ocr, 'lang'), { recursive: true });
cpSync(need(join(nm, 'tesseract.js', 'dist', 'worker.min.js')), join(ocr, 'worker.min.js'));
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'])
  cpSync(need(join(nm, 'tesseract.js-core', f)), join(ocr, 'core', f));
// Uncompressed: Android's packaging unpacks .gz assets and drops the extension, so the app always loads the plain
// file (ocrPdf with gzip: false), in the APK and in the browser test alike.
writeFileSync(
  join(ocr, 'lang', 'eng.traineddata'),
  gunzipSync(readFileSync(need(join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz')))),
);
// Noto Sans for edited text beyond Helvetica's characters (the web editor's export loads /fonts/NotoSans-Regular.ttf).
const fonts = join(pub, 'fonts');
rmSync(fonts, { recursive: true, force: true });
mkdirSync(fonts, { recursive: true });
for (const f of ['NotoSans-Regular.ttf', 'LICENSE.txt']) cpSync(need(join(root, '..', 'public', 'fonts', f)), join(fonts, f));
console.log('copied pdf.js data, OCR assets and fonts into public/');
