import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CONTRACT_ROUTE_FILES = [
  '/Users/songmin/wine-search-engine/src/interface/http/routes/search.route.ts',
  '/Users/songmin/wine-search-engine/src/interface/http/routes/batch-search.route.ts',
  '/Users/songmin/wine-search-engine/src/interface/http/routes/replay.route.ts',
  '/Users/songmin/wine-search-engine/src/interface/http/routes/interpret.route.ts',
  '/Users/songmin/wine-search-engine/src/interface/http/routes/resolve.route.ts',
  '/Users/songmin/wine-search-engine/src/interface/http/routes/hybrid.route.ts',
  '/Users/songmin/wine-search-engine/src/interface/http/routes/watchlist.route.ts',
  '/Users/songmin/wine-search-engine/src/interface/http/routes/health.route.ts',
  '/Users/songmin/wine-search-engine/src/interface/http/routes/claude-tools.route.ts',
] as const;

function readRouteFile(routePath: string): string {
  return readFileSync(routePath, 'utf8');
}

describe('contract route discipline', () => {
  it('registers contract-backed routes through registerContractRoute', () => {
    for (const routePath of CONTRACT_ROUTE_FILES) {
      const source = readRouteFile(routePath);
      expect(source, path.basename(routePath)).toContain('registerContractRoute(');
    }
  });

  it('avoids direct reply.send/reply.status in contract-backed route files', () => {
    const directReplyCallPattern = /\breply\.(status|send)\s*\(/;

    for (const routePath of CONTRACT_ROUTE_FILES) {
      const source = readRouteFile(routePath);
      expect(directReplyCallPattern.test(source), path.basename(routePath)).toBe(false);
    }
  });
});
