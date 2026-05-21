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
    rerankLimit: 20,
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

    it('forces rerank even for short_entity query class', () => {
      const decision = evaluateRerankGate(
        makeInput({ rerankForced: true, queryClass: 'short_entity' }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('forced');
    });

    it('forces rerank even for entity route', () => {
      const decision = evaluateRerankGate(
        makeInput({ rerankForced: true, effectiveRoute: 'entity' }),
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

    it('does not skip at exactly 5 candidates (pure_constraint triggers rerank)', () => {
      // pure_constraint always reranks — cross-encoder resolves price/style intent
      // that BM25 cannot. Minimum candidate count guard (rule 2) fires first at < 5.
      const decision = evaluateRerankGate(makeInput({ candidateCount: 5, queryClass: 'pure_constraint' }));
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('pure_constraint');
    });
  });

  describe('mixed route — does not suppress', () => {
    it('does not suppress reranking for mixed route', () => {
      // 'mixed' is not 'entity', so the already_precise rule must NOT fire.
      // With semantic_preference and sufficient candidates, reranking proceeds normally.
      const decision = evaluateRerankGate(
        makeInput({ effectiveRoute: 'mixed', candidateCount: 10, queryClass: 'semantic_preference' }),
      );
      expect(decision.reason).not.toBe('already_precise');
      expect(decision.shouldRerank).toBe(true);
    });
  });

  describe('short_entity / entity route — skip (already precise)', () => {
    it('skips for queryClass short_entity with sufficient candidates', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'short_entity', candidateCount: 25 }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('already_precise');
    });

    it('skips for effectiveRoute entity with sufficient candidates', () => {
      const decision = evaluateRerankGate(
        makeInput({ effectiveRoute: 'entity', candidateCount: 25 }),
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

  describe('semantic_preference — always rerank (ambiguous semantics)', () => {
    it('reranks for semantic_preference with candidateCount 10 (below large_candidate_set threshold)', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'semantic_preference', candidateCount: 10, hasAnchor: false }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('semantic_preference');
    });

    it('reranks for semantic_preference with candidateCount 5 (minimum viable)', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'semantic_preference', candidateCount: 5, hasAnchor: false }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('semantic_preference');
    });

    it('semantic_preference with candidateCount < 5 still skips (too_few_candidates fires first)', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'semantic_preference', candidateCount: 3, hasAnchor: false }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('too_few_candidates');
    });
  });

  describe('candidateCount >= 20', () => {
    it('reranks when candidateCount is exactly 20 (uses an isolating class without overlap)', () => {
      // P1.B: 'unknown' now triggers unknown_class_default_rerank, so we use a
      // non-special class label to isolate the large_candidate_set rule.
      const decision = evaluateRerankGate(
        makeInput({ candidateCount: 20, queryClass: 'isolated_class_for_large_candidate_set_rule' }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('large_candidate_set');
    });

    it('reranks when candidateCount exceeds 20 (isolating class)', () => {
      const decision = evaluateRerankGate(
        makeInput({ candidateCount: 50, queryClass: 'isolated_class_for_large_candidate_set_rule' }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('large_candidate_set');
    });

    it('pure_constraint always reranks — reason is pure_constraint not large_candidate_set', () => {
      // pure_constraint rule fires before large_candidate_set rule.
      const decision = evaluateRerankGate(makeInput({ candidateCount: 20, queryClass: 'pure_constraint' }));
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('pure_constraint');
    });
  });

  describe('pure_constraint — always rerank (price/style/pairing queries)', () => {
    it('reranks pure_constraint with candidateCount 5 (minimum viable)', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'pure_constraint', candidateCount: 5, hasAnchor: false }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('pure_constraint');
    });

    it('reranks pure_constraint with candidateCount 10', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'pure_constraint', candidateCount: 10, hasAnchor: false }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('pure_constraint');
    });

    it('pure_constraint with candidateCount < 5 still skips (too_few_candidates fires first)', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'pure_constraint', candidateCount: 3, hasAnchor: false }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('too_few_candidates');
    });
  });

  describe('ambiguous_short_form — always rerank', () => {
    it('reranks ambiguous_short_form with sufficient candidates', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'ambiguous_short_form', candidateCount: 8, hasAnchor: false }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('ambiguous_short_form');
    });

    it('ambiguous_short_form with candidateCount < 5 still skips', () => {
      const decision = evaluateRerankGate(
        makeInput({ queryClass: 'ambiguous_short_form', candidateCount: 2 }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('too_few_candidates');
    });
  });

  describe('default: skip', () => {
    it('skips when candidateCount is between 5 and 19 with no high-value signal (unclassified, non-special class)', () => {
      // P1.B: 'unknown' is now its own always-rerank class. Use a placeholder
      // class label that matches none of the rule branches to isolate default_skip.
      const decision = evaluateRerankGate(
        makeInput({ candidateCount: 10, queryClass: 'placeholder_default_skip_class', hasAnchor: false }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('default_skip');
    });

    it('skips for candidateCount 19 just below threshold (non-special class)', () => {
      const decision = evaluateRerankGate(
        makeInput({ candidateCount: 19, queryClass: 'placeholder_default_skip_class' }),
      );
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('default_skip');
    });
  });

  describe('topKOverride', () => {
    it('caps topKOverride to the contract rerankLimit when reranking is enabled', () => {
      // P1.B: 'unknown' now triggers its own always-rerank rule; use a
      // placeholder class label so the large_candidate_set path is exercised
      // for topKOverride coverage.
      const decision = evaluateRerankGate(
        makeInput({ candidateCount: 20, queryClass: 'isolated_class_for_topk_override' }),
      );
      expect(decision.topKOverride).toBe(20);
    });

    it('caps topKOverride for forced rerank as well', () => {
      const decision = evaluateRerankGate(makeInput({ rerankForced: true, rerankLimit: 3 }));
      expect(decision.topKOverride).toBe(3);
    });

    it('blocks reranking when the compiled budget disables rerank fanout', () => {
      const decision = evaluateRerankGate(makeInput({ rerankLimit: 0 }));
      expect(decision.shouldRerank).toBe(false);
      expect(decision.reason).toBe('budget_disabled');
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
    it('empty string effectiveRoute does not match entity route (pure_constraint still reranks)', () => {
      // effectiveRoute='' must NOT trigger already_precise.
      // pure_constraint always reranks regardless of effectiveRoute.
      const decision = evaluateRerankGate(
        makeInput({ effectiveRoute: '', candidateCount: 10, queryClass: 'pure_constraint' }),
      );
      expect(decision.shouldRerank).toBe(true);
      expect(decision.reason).toBe('pure_constraint');
    });

    it('empty string effectiveRoute does not match entity route (non-special class falls to default_skip)', () => {
      // effectiveRoute='' must NOT trigger already_precise; falls through to default_skip.
      // P1.B: 'unknown' is no longer the empty-class baseline; use a placeholder
      // class label that matches no special rule.
      const decision = evaluateRerankGate(
        makeInput({ effectiveRoute: '', candidateCount: 10, queryClass: 'placeholder_no_special_rule' }),
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
