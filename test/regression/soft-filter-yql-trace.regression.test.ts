/**
 * S4.3 — Soft-filter → YQL trace (P1.A end-to-end token plumbing).
 *
 * The pre-existing `retrieval-soft-to-hard-promotion.regression.test.ts` proves
 * that `softConstraintsToOptionalFilterTokens` EMITS a `critic_score_min:` token.
 * That alone does NOT prove the token actually reaches Vespa YQL — a token whose
 * key is unknown to `FILTER_TOKEN_REGISTRY` would be silently dropped by
 * `buildSparseFilters` (see the "Unknown token — blocked" branch in
 * `src/infrastructure/vespa/mapping.ts`).
 *
 * This regression closes that gap: it feeds a promoted soft constraint through
 * BOTH stages of the production retrieval filter path —
 *
 *   softConstraintsToOptionalFilterTokens()  →  buildSparseFilters() / buildDenseFilters()
 *
 * — and asserts that the resulting YQL fragment actually contains the
 * `critic_score_normalized >= 0.7` clause. This is the proof that P1's
 * promotion REACHES the query, not just that the token function returns a string.
 *
 * It also asserts the negative: a sub-floor confidence emits no token, so the
 * YQL fragment is empty (no over-filtering from low-confidence preferences).
 *
 * This file is append-only — never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import { softConstraintsToOptionalFilterTokens } from '../../src/domain/retrieval/service/constraint-to-sparse-filter-tokens.js';
import {
  buildSparseFilters,
  buildDenseFilters,
} from '../../src/infrastructure/vespa/mapping.js';
import type { NormalizedConstraint } from '../../src/domain/shared/types/index.js';

/**
 * Trust list mirrors the legacy pre-canonicalization gate so the S4.3
 * regression invariants still hold under the new `soft_promotion_authority`
 * contract — trusted mapping versions get `authority='allow'`; LLM/unknown
 * versions do not.
 */
const TRUSTED_MAPPING_VERSIONS: ReadonlySet<string> = new Set([
  'rule-based-v1.0',
  'entity-resolver-v1.0',
  'v1.0',
]);

function makeSoft(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
  overrides: Partial<NormalizedConstraint> = {},
): NormalizedConstraint {
  const merged: NormalizedConstraint = {
    attribute,
    operator,
    value,
    source_phrase: attribute,
    confidence: 0.85,
    mapping_version: 'rule-based-v1.0',
    ...overrides,
  };
  if (!('soft_promotion_authority' in overrides)
      && merged.mapping_version !== undefined
      && TRUSTED_MAPPING_VERSIONS.has(merged.mapping_version)) {
    return { ...merged, soft_promotion_authority: 'allow' };
  }
  return merged;
}

describe('S4.3 — soft constraint promotion reaches Vespa YQL', () => {
  describe('above the confidence floor — promotion reaches YQL', () => {
    // The canonical case from the task: critic_score>=0.7 confidence=0.85
    // mappingVersion='rule-based-v1.0'.
    const soft = makeSoft('critic_score', '>=', 0.7, {
      confidence: 0.85,
      mapping_version: 'rule-based-v1.0',
    });

    it('emits the promoted critic_score_min token', () => {
      const tokens = softConstraintsToOptionalFilterTokens([soft]);
      expect(tokens).toContain('critic_score_min:0.7');
    });

    it('the promoted token survives buildSparseFilters → critic_score_normalized >= 0.7 YQL clause', () => {
      const tokens = softConstraintsToOptionalFilterTokens([soft]);
      const yql = buildSparseFilters(tokens);
      // FILTER_TOKEN_REGISTRY maps critic_score_min → { num_gte, critic_score_normalized }.
      // Proves the token is RECOGNISED (not silently dropped) and produces a real clause.
      // num_gte clamps to [0,1] and renders with 4 decimals (NORMALIZED_SCORE_YQL_DECIMAL_PLACES).
      expect(yql).toContain('critic_score_normalized >= 0.7000');
      // Sanity: the fragment is an AND-clause continuation, not empty.
      expect(yql.startsWith(' AND ')).toBe(true);
    });

    it('the promoted token survives buildDenseFilters too (ANN path applies the same filter)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([soft]);
      const yql = buildDenseFilters(tokens);
      // num_gte clamps to [0,1] and renders with 4 decimals (NORMALIZED_SCORE_YQL_DECIMAL_PLACES).
      expect(yql).toContain('critic_score_normalized >= 0.7000');
    });
  });

  describe('below the confidence floor — NOT promoted, no YQL filter', () => {
    // confidence 0.6 < default floor 0.8 → must NOT promote, must NOT tighten YQL.
    const soft = makeSoft('critic_score', '>=', 0.7, {
      confidence: 0.6,
      mapping_version: 'rule-based-v1.0',
    });

    it('emits no token', () => {
      const tokens = softConstraintsToOptionalFilterTokens([soft]);
      expect(tokens).toHaveLength(0);
    });

    it('buildSparseFilters produces an empty YQL fragment (no critic_score clause)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([soft]);
      const yql = buildSparseFilters(tokens);
      expect(yql).toBe('');
      expect(yql).not.toContain('critic_score_normalized');
    });
  });

  describe('disallowed mapping version — NOT promoted even above floor', () => {
    it('llm-linker-v1.0 at confidence 0.95 produces no YQL filter', () => {
      const soft = makeSoft('critic_score', '>=', 0.7, {
        confidence: 0.95,
        mapping_version: 'llm-linker-v1.0',
      });
      const tokens = softConstraintsToOptionalFilterTokens([soft]);
      const yql = buildSparseFilters(tokens);
      expect(yql).toBe('');
    });
  });
});
