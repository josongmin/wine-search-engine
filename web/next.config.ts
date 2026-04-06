import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* API proxy is not used — client.ts calls API_BASE directly.
     Add rewrites here if you switch to same-origin proxying. */
};

export default nextConfig;
