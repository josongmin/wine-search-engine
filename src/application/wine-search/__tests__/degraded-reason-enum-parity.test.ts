import { describe, it, expect } from 'vitest';
import { DegradedReasonSchema } from '../wine-search-result-schemas.js';
import { WineSearchDegradedReasonSchema } from '../../../interface/http/schemas/wine-search.schema.js';
import type { DegradedReason } from '../synthesis-schemas.js';

/**
 * SSoT parity (CLAUDE.md rule 30): the synthesis `DegradedReason` union is
 * mirrored by THREE Zod enums (the internal result-schema, the HTTP wire
 * schema, and — implicitly — the wire DTO type). They drifted once already:
 * `llm_unavailable` (and `no_corpus_match`) were added to the union + HTTP
 * schema but NOT to `wine-search-result-schemas`, so `assertWineSearchResult`
 * 500'd every LLM-provider-unavailable agent request at runtime. These tests
 * lock the enums together so a new degraded reason cannot be half-added again.
 */

// Compile-time exhaustiveness: every DegradedReason MUST be a key here, and
// every key MUST be a DegradedReason. Adding a union member without updating
// this map is a type error; the runtime test below asserts the enums match it.
const CANONICAL_DEGRADED_REASONS: Record<DegradedReason, true> = {
  malformed_llm_output: true,
  timeout: true,
  circuit_open: true,
  no_results: true,
  policy_blocked: true,
  unexpected_error: true,
  ungrounded_claim: true,
  no_corpus_match: true,
  llm_unavailable: true,
};

const canonical = Object.keys(CANONICAL_DEGRADED_REASONS).sort();

describe('DegradedReason enum parity (SSoT)', () => {
  it('the internal result-schema enum covers exactly the canonical set', () => {
    expect([...DegradedReasonSchema.options].sort()).toEqual(canonical);
  });

  it('the HTTP wire enum covers exactly the canonical set', () => {
    expect([...WineSearchDegradedReasonSchema.options].sort()).toEqual(canonical);
  });

  it('result-schema and HTTP wire enums agree with each other', () => {
    expect([...DegradedReasonSchema.options].sort()).toEqual(
      [...WineSearchDegradedReasonSchema.options].sort(),
    );
  });

  it('both enums accept the provider-unavailable reason (the drift that 500ed agent requests)', () => {
    expect(DegradedReasonSchema.safeParse('llm_unavailable').success).toBe(true);
    expect(WineSearchDegradedReasonSchema.safeParse('llm_unavailable').success).toBe(true);
  });
});
