/**
 * ADR-010 / ADR-011: downstream readers must only consume
 * `plan.constraintGraph` / `compiled.constraintGraph` after their ADR-011
 * Phase-1b migration is explicit. The allow-list below enumerates every
 * file authorised to reference `.constraintGraph` on a plan / compiled
 * query / compiler result.
 *
 * Phase 1a (ADR-010): type + projector + compiler emission + planner thread.
 * Phase 1b.1 (ADR-011): first-reader migration —
 *   - `compiled-wine-query.ts`   (passthrough field)
 *   - `execution-compiler.ts`    (plan → compiled copy)
 *   - `compute-graph-coverage.ts`(graph-aware AND/OR/XOR coverage)
 *   - `search-usecase-provenance-closure.ts` (first migrated reader)
 *   - `search-usecase-hybrid-ranking-pipeline.ts`
 *     (call-site that threads `compiled.constraintGraph` into the stage builders)
 *
 * Future Phase-1b.* migrations MUST append their source files to the
 * allow-list in the same PR that migrates them. Bare `.constraintGraph`
 * leaks elsewhere fail this test.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
);

/**
 * Files explicitly allowed to reference `constraintGraph` in Phase 1a.
 * - The type itself
 * - The projector
 * - The compiler seam that calls the projector
 * - Planner surface that threads the field onto V2
 * - QueryPlanV2 type where the field is declared
 * - ADR-010 / plan doc references
 * - Regression tests that lock the contract
 */
const PHASE_1A_ALLOWLIST: readonly RegExp[] = [
  // Phase 1a (ADR-010): type + projector + planner/compiler emission.
  /src\/domain\/query\/model\/constraint-graph\.ts$/,
  /src\/domain\/query\/model\/query-plan\.ts$/,
  /src\/domain\/query\/service\/build-trivial-graph-from-atoms\.ts$/,
  /src\/domain\/query\/service\/constraint-compiler\.ts$/,
  /src\/domain\/query\/service\/planner\.ts$/,
  // Phase 1b.1 (ADR-011): first-reader migration + passthrough plumbing.
  /src\/domain\/query\/model\/compiled-wine-query\.ts$/,
  /src\/domain\/query\/service\/execution-compiler\.ts$/,
  /src\/domain\/query\/service\/compute-graph-coverage\.ts$/,
  /src\/application\/search\/search-usecase-provenance-closure\.ts$/,
  /src\/application\/search\/search-usecase-hybrid-ranking-pipeline\.ts$/,
  // Docs / tests / benchmarks remain globally allowed.
  /docs\//,
  /test\/regression\//,
  /test\/benchmark\//,
];

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    const s = statSync(abs);
    if (s.isDirectory()) {
      listTsFiles(abs, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
  return out;
}

describe('ConstraintGraph reader allow-list (ADR-010 / ADR-011)', () => {
  it('no src/ file outside the allow-list references plan.constraintGraph', () => {
    const srcRoot = join(REPO_ROOT, 'src');
    const files = listTsFiles(srcRoot);
    const offenders: string[] = [];

    for (const abs of files) {
      const rel = abs.slice(REPO_ROOT.length + 1);
      if (PHASE_1A_ALLOWLIST.some((re) => re.test(rel))) continue;
      const src = readFileSync(abs, 'utf8');
      // Phase 1a ban: reading `.constraintGraph` off a plan / compiled query /
      // compiler result. Allow `constraintGraphEmissionRate` in bench etc.
      if (/\.constraintGraph\b(?!Emission)/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
