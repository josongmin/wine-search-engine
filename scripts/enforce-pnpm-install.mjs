#!/usr/bin/env node
/**
 * Lifecycle guard: refuse installs driven by npm/yarn/bun (or unknown clients).
 * Intended for root `preinstall` / `web` `preinstall` so `npm install` fails fast.
 *
 * Skipped when:
 * - `SKIP_PNPM_ONLY_CHECK=1` (containers / one-off automation only)
 * - Install uses `--ignore-scripts` (Docker production stages, etc.)
 */
import { stderr } from 'node:process';

if (process.env.SKIP_PNPM_ONLY_CHECK === '1') {
  process.exit(0);
}

const ua = process.env.npm_config_user_agent ?? '';

if (ua.startsWith('pnpm/')) {
  process.exit(0);
}

stderr.write(
  `${[
    '[wine-search-engine] Install with pnpm only (npm/yarn/bun are blocked).',
    '  corepack enable',
    '  pnpm install --frozen-lockfile',
    'One-off bypass (avoid in normal dev): SKIP_PNPM_ONLY_CHECK=1',
  ].join('\n')}\n`,
);
process.exit(1);
