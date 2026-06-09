import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone CSR SPA. No backend — loads pipeline artifacts from /public/data.
export default defineConfig({
  plugins: [react()],
  // Pin target locally so esbuild ignores the parent repo's tsconfig.base.json (ES2024).
  esbuild: { target: 'es2021' },
  build: { target: 'es2021' },
  // Proxy the ops API to the main wine-search-engine backend so the SPA can
  // call /v2/entity-lookup* with no CORS. Override target via VITE_OPS_BACKEND.
  server: {
    port: 5311,
    open: true,
    proxy: {
      '/v2': { target: process.env.VITE_OPS_BACKEND ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
  preview: { port: 5311 },
});
