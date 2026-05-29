import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const CONTRACT_ROUTE_FILES = [
  'src/interface/http/routes/search.route.ts',
  'src/interface/http/routes/lookup.route.ts',
  'src/interface/http/routes/watchlist.route.ts',
  'src/interface/http/routes/health.route.ts',
  'src/interface/http/routes/feedback.route.ts',
  'src/interface/http/routes/wine-search.route.ts',
] as const;

function readRouteFile(routePath: string): string {
  return readFileSync(path.join(REPO_ROOT, routePath), 'utf8');
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
