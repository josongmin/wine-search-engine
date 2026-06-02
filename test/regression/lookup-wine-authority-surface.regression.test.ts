/**
 * Post-cutover authority rail for `lookup_wine`.
 *
 * Why: once `/v1/lookup/wine`, local CLI `lookupWine`, and eval lanes diverged,
 * direct `SearchUseCase.execute({ primitiveRoute: 'lookup_wine' })` callers
 * silently masqueraded as the public authority surface. This rail pins the
 * intended split:
 *
 * - product edges (`/v1/lookup/wine`, local CLI `lookupWine`) must call the
 *   compatibility-backed V2 authority seam directly
 * - legacy-core comparisons stay confined to explicit benchmark/debug lanes and
 *   must opt in with `lookupAuthorityMode='legacy_core'`
 *
 * Append-only: never delete.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('lookup_wine authority surface regression', () => {
  it('public lookup route is fail-closed on the compatibility-backed authority seam', () => {
    const src = read('src/interface/http/routes/primitive-search.route.ts');
    expect(src).toContain('lookup route requires lookupWineV2CompatibilityUseCase wiring');
    expect(src).toContain('deps.lookupWineV2CompatibilityUseCase.execute(');
    expect(src).not.toContain('deps.searchUseCase.execute(toLookupWineRequest(parsed)');
  });

  it('local CLI lookupWine bypasses generic SearchUseCase execution', () => {
    const src = read('src/infrastructure/cli/local/local-search-facade.ts');
    expect(src).toContain("if (kind === 'lookupWine')");
    expect(src).toContain('container.lookupWineV2CompatibilityUseCase.execute(');
    expect(src).not.toContain("kind === 'lookupWine' && container.lookupWineV2CompatibilityUseCase !== undefined");
  });

  it('legacy-core compare lanes opt in explicitly', () => {
    const authorityEval = read('scripts/eval/run-entity-resolution-validation.ts');
    const shadowEval = read('scripts/eval/run-lookup-v2-shadow-compare.ts');
    const debugOne = read('scripts/eval/debug-one-lookup.ts');

    for (const src of [authorityEval, shadowEval, debugOne]) {
      expect(src).toContain("primitiveRoute: 'lookup_wine'");
      expect(src).toContain("lookupAuthorityMode: 'legacy_core'");
    }
  });
});
