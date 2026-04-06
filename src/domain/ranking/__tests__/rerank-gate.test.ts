import { describe, it, expect } from 'vitest';
import { evaluateRerankGate } from '../service/rerank-gate.js';
import type { RerankGateInput } from '../service/rerank-gate.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<RerankGateInput> = {}): RerankGateInput {
  return {
    candidateCount: 10,
    queryClass: 'semantic_preference',
    effectiveRoute: 'hybrid',
    hasAnchor: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('evaluateRerankGate', () => {
  describe('rerankForced === true', () => {
    it('forces rerank regardless of candidate count', () => {
      const decision = evaluateRerankGate(makeInput({ rerankForced: true, candidateCount: 2 }));
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('forced');
    });

    it('forces rerank even for known_item query class', () => {
      const decision = evaluateRerankGate(
        makeInput({ rerankForced: true, queryClass: 'known_item' }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('forced');
    });

    it('forces rerank even for exact_lookup route', () => {
      const decision = evaluateRerankGate(
        makeInput({ rerankForced: true, effectiveRoute: 'exact_lookup' }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('forced');
    });
  });

  describe('candidateCount < 5', () => {
    it('skips when candidateCount is 0', () => {
      const decision = evaluateRerankGate(makeInput({ candidateCount: 0 }));
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('too_few_candidates');
    });

    it('skips when candidateCount is 4', () => {
      const decision = evaluateRerankGate(makeInput({ candidateCount: 4 }));
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('too_few_candidates');
    });

    it('does not skip at exactly 5 candidates', () => {
      const decision = evaluateRerankGate(makeInput({ candidateCount: 5 }));
      // 5 candidates with semantic_preference and no anchor — below the >=20 threshold, default skip
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('default_skip');
    });
  });

  describe('short_entity / exact_lookup — skip (already precise)', () => {
    it('skips for queryClass short_entity with sufficient candidates', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'short_entity', candidateCount: 25 }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('already_precise');
    });

    it('skips for effectiveRoute exact_lookup with sufficient candidates', () => {
      const decision = evaluateRerankGate(
        makeInput({ effectiveRoute: 'exact_lookup', candidateCount: 25 }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('already_precise');
    });

    it('short_entity takes precedence over large candidate set', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'short_entity', candidateCount: 100 }),
      );
      expect(decision.shouldRerank).toBe(false);
    });
  });

  describe('comparison_query / hasAnchor — always rerank (high value)', () => {
    it('reranks for comparison_query query class', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'comparison_query', candidateCount: 6 }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('comparison_query');
    });

    it('reranks when hasAnchor is true', () => {
      const decision = evaluateRerankGate(
        makeInput({ hasAnchor: true, candidateCount: 6 }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('has_anchor');
    });

    it('hasAnchor with comparison_query uses has_anchor reason (hasAnchor takes precedence in ternary)', () => {
      // Both queryClass=comparison_query and hasAnchor=true satisfy the gate condition.
      // The reason ternary checks hasAnchor first → 'has_anchor'.
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'comparison_query', hasAnchor: true, candidateCount: 6 }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('has_anchor');
    });
  });

  describe('candidateCount >= 20', () => {
    it('reranks when candidateCount is exactly 20', () => {
      const decision = evaluateRerankGate(makeInput({ candidateCount: 20 }));
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('large_candidate_set');
    });

    it('reranks when candidateCount exceeds 20', () => {
      const decision = evaluateRerankGate(makeInput({ candidateCount: 50 }));
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('large_candidate_set');
    });
  });

  describe('default: skip', () => {
    it('skips when candidateCount is between 5 and 19 with no high-value signal', () => {
      const decision = evaluateRerankGate(
        makeInput({ candidateCount: 10, queryClass: 'semantic_preference', hasAnchor: false }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('default_skip');
    });

    it('skips for candidateCount 19 (just below threshold)', () => {
      const decision = evaluateRerankGate(makeInput({ candidateCount: 19 }));
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('default_skip');
    });
  });

  describe('topKOverride', () => {
    it('does not set topKOverride in default cases', () => {
      const decision = evaluateRerankGate(makeInput({ candidateCount: 20 }));
      expect(decision.topKOverride).toBeUndefined();
    });

    it('does not set topKOverride for forced rerank', () => {
      const decision = evaluateRerankGate(makeInput({ rerankForced: true }));
      expect(decision.topKOverride).toBeUndefined();
    });
  });

  describe('rerankForced is not set / undefined', () => {
    it('does not force rerank when rerankForced is omitted', () => {
      const input: RerankGateInput = {
        candidateCount: 3,
        queryClass: 'semantic_preference',
        effectiveRoute: 'hybrid',
        hasAnchor: false,
      };
      const decision = evaluateRerankGate(input);
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('too_few_candidates');
    });

    it('does not force rerank when rerankForced is false', () => {
      const decision = evaluateRerankGate(
        makeInput({ rerankForced: false, candidateCount: 3 }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('too_few_candidates');
    });
  });

  describe('edge cases', () => {
    it('empty string effectiveRoute does not match exact_lookup', () => {
      // effectiveRoute='' must NOT trigger already_precise; falls through to default_skip.
      const decision = evaluateRerankGate(
        makeInput({ effectiveRoute: '', candidateCount: 10 }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('default_skip');
    });

    it('hasAnchor=true with candidateCount<5 → too_few_candidates (rule 2 beats rule 4)', () => {
      // The too_few_candidates guard (rule 2) fires before the hasAnchor guard (rule 4).
      // Even high-value anchor queries should skip reranking with < 5 candidates.
      const decision = evaluateRerankGate(
        makeInput({ hasAnchor: true, candidateCount: 3 }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('too_few_candidates');
    });

    it('short_entity with hasAnchor=true still skips (rule 3 beats rule 4)', () => {
      // short_entity is already precise; reranking adds noise even with an anchor.
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'short_entity', hasAnchor: true, candidateCount: 10 }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('already_precise');
    });
  });
});
