/**
 * P1.A Regression — Soft → Hard confidence-gated promotion.
 *
 * Pre-P1.A: `SOFT_CONSTRAINT_ATTRIBUTES` (critic_score, body, producer_prestige, …)
 * never reached Vespa YQL filtering. `candidate-pool.ts:231` only fed
 * `input.hardConstraints` into `hardConstraintsToSparseFilterTokens`. So queries
 * like "평점 좋은 와인" or "지금 마실 수 있는" parsed soft and never tightened
 * retrieval — leaving the 7,282-doc corpus under-filtered.
 *
 * Post-P1.A: `softConstraintsToOptionalFilterTokens` performs a narrow,
 * principled promotion of soft constraints into Vespa filter tokens when:
 *   - confidence ≥ confidenceFloor (default 0.8)
 *   - mapping_version ∈ {rule-based-v1.0, entity-resolver-v1.0}
 *   - attribute is in the MIN-only translation map (critic_score / body /
 *     producer_prestige)
 *   - operator/value yields a finite numeric MIN bound
 *
 * This file is append-only — never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import { softConstraintsToOptionalFilterTokens } from '../../src/domain/retrieval/service/constraint-to-sparse-filter-tokens.js';
import type { NormalizedConstraint } from '../../src/domain/shared/types/index.js';

function makeSoft(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
  overrides: Partial<NormalizedConstraint> = {},
): NormalizedConstraint {
  return {
    attribute,
    operator,
    value,
    source_phrase: attribute,
    confidence: 0.85,
    mapping_version: 'rule-based-v1.0',
    ...overrides,
  };
}

describe('P1.A — softConstraintsToOptionalFilterTokens', () => {
  describe('happy path — promotion fires', () => {
    it('critic_score >= 0.7 with confidence 0.85 + rule-based mapping → critic_score_min:0.7', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '>=', 0.7, { confidence: 0.85 }),
      ]);
      expect(tokens).toContain('critic_score_min:0.7');
    });

    it('entity-resolver-v1.0 mapping version also qualifies for promotion', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '>=', 0.8, {
          confidence: 0.9,
          mapping_version: 'entity-resolver-v1.0',
        }),
      ]);
      expect(tokens).toContain('critic_score_min:0.8');
    });

    it('body = 0.6 with high confidence promotes to body_min:0.6', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('body', '=', 0.6),
      ]);
      expect(tokens).toContain('body_min:0.6');
    });

    it('producer_prestige range { min: 0.75, max: 1.0 } promotes only the MIN bound', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('producer_prestige', 'range', { min: 0.75, max: 1.0 }),
      ]);
      expect(tokens).toContain('producer_prestige_min:0.75');
      // MAX bound MUST NOT be emitted — over-pruning guard.
      expect(tokens.some((t) => t.includes('_max:'))).toBe(false);
    });

    it('range with reversed bounds normalizes so MIN-of-bounds is emitted', () => {
      // { min: 0.9, max: 0.4 } → lo = 0.4, that's the MIN-only emission.
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', 'range', { min: 0.9, max: 0.4 }),
      ]);
      expect(tokens).toContain('critic_score_min:0.4');
    });
  });

  describe('confidence floor gate', () => {
    it('confidence 0.7 (just below floor 0.8) is NOT promoted', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '>=', 0.7, { confidence: 0.7 }),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('confidence exactly 0.8 (at floor) IS promoted (>= comparison, inclusive)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '>=', 0.7, { confidence: 0.8 }),
      ]);
      expect(tokens).toContain('critic_score_min:0.7');
    });

    it('custom confidenceFloor override is respected', () => {
      // With a stricter floor of 0.95, even 0.9 confidence is rejected.
      const tokens = softConstraintsToOptionalFilterTokens(
        [makeSoft('critic_score', '>=', 0.7, { confidence: 0.9 })],
        { confidenceFloor: 0.95 },
      );
      expect(tokens).toHaveLength(0);
    });

    it('non-finite confidence (NaN) is rejected', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '>=', 0.7, { confidence: Number.NaN }),
      ]);
      expect(tokens).toHaveLength(0);
    });
  });

  describe('mapping version gate', () => {
    it('LLM-sourced mapping_version (llm-linker-v1.0) is NOT promoted even at high confidence', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '>=', 0.7, {
          confidence: 0.95,
          mapping_version: 'llm-linker-v1.0',
        }),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('unknown mapping_version is NOT promoted', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '>=', 0.7, {
          confidence: 0.95,
          mapping_version: 'fictional-version-v999',
        }),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('undefined mapping_version is NOT promoted', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        {
          attribute: 'critic_score',
          operator: '>=',
          value: 0.7,
          source_phrase: 'critic_score',
          confidence: 0.95,
          // mapping_version omitted
        },
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('pairing-objective mapping is NOT in the allow-list and is NOT promoted', () => {
      // Domain check: only deterministic tier-1/tier-2 mappings promote.
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '>=', 0.7, {
          confidence: 0.95,
          mapping_version: 'pairing-objective-v1.0',
        }),
      ]);
      expect(tokens).toHaveLength(0);
    });
  });

  describe('attribute scope', () => {
    it('drinking_window is NOT promoted (two-sided semantic excluded from MIN-only map)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('drinking_window', '>=', 2025),
      ]);
      // drinking_window has no MIN-only token translation; emit nothing.
      expect(tokens).toHaveLength(0);
    });

    it('style (sensory string) is NOT promoted (no numeric MIN bound)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('style', '=', 'bold'),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('price_band is NOT promoted (not in MIN-only allow-list)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('price_band', '=', 'premium'),
      ]);
      expect(tokens).toHaveLength(0);
    });
  });

  describe('operator / value shape gate', () => {
    it('operator `<=` is NOT promoted (would emit MAX bound — over-pruning)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '<=', 0.9),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('operator `exclude` is NOT promoted', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', 'exclude', 0.5),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('operator `in` with array value is NOT promoted (not a numeric bound)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', 'in', ['high', 'medium']),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('operator `=` with non-numeric value is NOT promoted', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '=', 'high'),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('operator `=` with non-finite number (Infinity) is NOT promoted', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('critic_score', '=', Number.POSITIVE_INFINITY),
      ]);
      expect(tokens).toHaveLength(0);
    });
  });

  describe('input order + multi-constraint composition', () => {
    it('preserves stable input order across multiple promotions', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('body', '>=', 0.5),
        makeSoft('critic_score', '>=', 0.7),
        makeSoft('producer_prestige', '>=', 0.6),
      ]);
      expect(tokens).toEqual([
        'body_min:0.5',
        'critic_score_min:0.7',
        'producer_prestige_min:0.6',
      ]);
    });

    it('mixed array: promotable + non-promotable constraints emit only the promotable', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('style', '=', 'bold'),                  // not in allow-list
        makeSoft('critic_score', '>=', 0.7),             // promotes
        makeSoft('drinking_window', '>=', 2025),          // not in allow-list
        makeSoft('body', '=', 0.6),                       // promotes
      ]);
      expect(tokens).toEqual(['critic_score_min:0.7', 'body_min:0.6']);
    });

    it('empty input → empty token list', () => {
      expect(softConstraintsToOptionalFilterTokens([])).toEqual([]);
    });
  });
});
