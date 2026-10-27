import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// `@/…` resolves to the web app's sources, so the browser PDF tools are shared rather than copied.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: [
      // The web app's pdf.js loader (used by shared OCR and image tools) is replaced by the app's own.
      { find: '@/components/editor/pdfjs', replacement: fileURLToPath(new URL('./src/pdfjs-shim.ts', import.meta.url)) },
      { find: '@', replacement: fileURLToPath(new URL('../src', import.meta.url)) },
    ],
    // Shared files live outside mobile/; their imports must resolve to this app's node_modules (CI installs only these).
    dedupe: ['react', 'react-dom', 'pdf-lib', '@pdf-lib/fontkit', '@cantoo/pdf-lib', 'fflate', 'tesseract.js', 'pdfjs-dist'],
  },
  build: { outDir: 'dist', target: 'es2020', chunkSizeWarningLimit: 4000 },
});
