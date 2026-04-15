/**
 * ADR-011 Phase 1b.3a: the pre-rank retrieval coverage wrapper in
 * `search-usecase-hybrid-candidates.ts::buildRetrievalCoverage` threads
 * `compiled.constraintGraph` into `buildHybridCandidateCoverageStage`.
 *
 * This is a grep-level contract lock: the runtime wiring is exercised by
 * the specialized-retrieval-routing integration suite; here we pin the
 * source expression to prevent a silent regression that drops the graph
 * arg on this call-site.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HYBRID_CANDIDATES_SRC = fileURLToPath(
  new URL(
    '../../src/application/search/search-usecase-hybrid-candidates.ts',
    import.meta.url,
  ),
);

describe('buildRetrievalCoverage passes compiled.constraintGraph', () => {
  const src = readFileSync(HYBRID_CANDIDATES_SRC, 'utf8');

  it('call-site threads compiled.constraintGraph into the stage builder', () => {
    // The wrapper must forward compiled.constraintGraph — flat fallback
    // still works (the stage builder handles `undefined`), but dropping
    // this argument silently reverts Phase 1b.3a's semantic-parity
    // guarantee with provenance-closure.
    expect(src).toMatch(
      /buildHybridCandidateCoverageStage\(\s*plan,\s*candidates,\s*compiled\.execution\.provenancePolicy,\s*compiled\.constraintGraph,?\s*\)/,
    );
  });
});
