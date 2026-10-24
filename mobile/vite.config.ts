import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// `@/…` resolves to the web app's sources, so the browser PDF tools are shared rather than copied.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
    // Shared files live outside mobile/; their imports must resolve to this app's node_modules (CI installs only these).
    dedupe: ['pdf-lib', '@pdf-lib/fontkit'],
  },
  build: { outDir: 'dist', target: 'es2020', chunkSizeWarningLimit: 4000 },
});
