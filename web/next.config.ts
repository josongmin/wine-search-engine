import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Monorepo root for when Turbopack is used. `pnpm` still links
  // `web/node_modules/next` → `../../node_modules/.pnpm/.../next`, which
  // Turbopack may reject; dev/build use `--webpack` in package.json (see vercel/next.js#88335).
  turbopack: {
    root: path.join(import.meta.dirname, '..'),
  },
  /* API proxy is not used — client.ts calls API_BASE directly.
     Add rewrites here if you switch to same-origin proxying. */
};

export default nextConfig;
