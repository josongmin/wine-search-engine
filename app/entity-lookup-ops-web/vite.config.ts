import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone CSR SPA. No backend — loads pipeline artifacts from /public/data.
export default defineConfig({
  plugins: [react()],
  server: { port: 5311, open: true },
  preview: { port: 5311 },
});
