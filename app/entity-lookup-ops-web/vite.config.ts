import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone CSR SPA. No backend — loads pipeline artifacts from /public/data.
export default defineConfig({
  plugins: [react()],
  // Pin target locally so esbuild ignores the parent repo's tsconfig.base.json (ES2024).
  esbuild: { target: 'es2021' },
  build: { target: 'es2021' },
  server: { port: 5311, open: true },
  preview: { port: 5311 },
});
