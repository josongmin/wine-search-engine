import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
  /* API proxy is not used — client.ts calls API_BASE directly.
     Add rewrites here if you switch to same-origin proxying. */
};

export default nextConfig;
