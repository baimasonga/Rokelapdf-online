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
cpSync(join(src, 'build', 'pdf.worker.min.mjs'), join(out, 'pdf.worker.min.mjs'));
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) if (existsSync(join(src, d))) cpSync(join(src, d), join(out, d), { recursive: true });
