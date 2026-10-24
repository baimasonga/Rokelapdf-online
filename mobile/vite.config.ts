import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// `@/…` resolves to the web app's sources, so the browser PDF tools are shared rather than copied.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  build: { outDir: 'dist', target: 'es2020', chunkSizeWarningLimit: 4000 },
});
