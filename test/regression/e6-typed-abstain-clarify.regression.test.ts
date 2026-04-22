/**
 * Regression: EPIC-6 Typed Abstain/Clarify
 *
 * Guards:
 *  E6-1:  TypedAbstainDecision shape — shouldAbstain, reason, detail, recoverableBy
 *  E6-2:  AbstainReason union — 4 valid literals
 *  E6-3:  RecoveryAction union — 4 valid literals
 *  E6-4:  ClarifyKind union — 4 valid literals
 *  E6-5:  StructuredClarifyPayload — kind + question required; options/conflictingAtoms optional
 *  E6-6:  ChannelDegradationSummary shape — 3 required booleans
 *  E6-7:  AbstainPolicy.evaluate() — no_match when topKScores empty
 *  E6-8:  AbstainPolicy.evaluate() — semantic_conflict when soft_tension relation present
 *  E6-9:  AbstainPolicy.evaluate() — semantic_conflict when contradiction relation present
 *  E6-10: AbstainPolicy.evaluate() — insufficient_evidence when dense+anchor both degraded
 *  E6-11: AbstainPolicy.evaluate() — low_confidence when entropy gate fires (ltrAvailable=true)
 *  E6-12: AbstainPolicy.evaluate() — returns false (no abstain) for healthy, confident results
 *  E6-13: AbstainPolicy.evaluate() — no_match takes priority over semantic_conflict
 *  E6-14: AbstainPolicy.evaluate() — semantic_conflict takes priority over insufficient_evidence
 *  E6-15: TypedAbstainDecision.conflictingRelations populated for semantic_conflict
 *  E6-16: ClarificationPayload.structuredPayload optional field type-checks
 *  E6-17: AbstainPolicy.shouldAbstain() legacy API still works (no regression)
 *  E6-18: StructuredClarifyPayload.conflictingAtoms is [string, string] tuple
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, expect, it } from 'vitest';
import { AbstainPolicy } from '../../src/domain/query/service/abstain-policy.js';
import type {
  TypedAbstainDecision,
  AbstainReason,
  RecoveryAction,
  ClarifyKind,
  StructuredClarifyPayload,
  ChannelDegradationSummary,
} from '../../src/domain/query/model/abstain-decision.js';
import type { ConstraintRelation } from '../../src/domain/query/service/constraint-reasoner.js';
import type { ClarificationPayload } from '../../src/domain/response/model/clarification.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NO_RELATIONS: readonly ConstraintRelation[] = [];
const HEALTHY_CHANNELS: ChannelDegradationSummary = {
  denseDegraded: false,
  anchorDegraded: false,
  sparseDegraded: false,
};
const LTR_CTX = { ltrAvailable: true };

// Dominant scores: one clear winner → entropy well below 0.95
const CONFIDENT_SCORES = [10.0, 0.1, 0.1, 0.1, 0.1];
// Near-uniform scores → entropy ≈ 1.0 → abstain
const UNIFORM_SCORES = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];

function makeSoftTension(): ConstraintRelation {
  return {
    type: 'soft_tension',
    atomIndexA: 0,
    atomIndexB: 1,
    explanation: "Soft tension on 'sweetness': opposing operators '>=' vs '<='",
  };
}

function makeContradiction(): ConstraintRelation {
  return {
    type: 'contradiction',
    atomIndexA: 0,
    atomIndexB: 1,
    winner: 'a',
    explanation: "Hard constraint contradiction on 'region': 'Bordeaux' vs 'Burgundy'",
  };
}

// ─── E6-1: TypedAbstainDecision shape ─────────────────────────────────────────

describe('E6: TypedAbstainDecision type', () => {
  it('E6-1: TypedAbstainDecision has shouldAbstain=true, reason, detail, optional recoverableBy', () => {
    const decision: TypedAbstainDecision = {
      shouldAbstain: true,
      reason: 'no_match',
      detail: 'Zero candidates after hard filter.',
      recoverableBy: 'relax_constraints',
    };
    expect(decision.shouldAbstain).toBe(true);
    expect(decision.reason).toBe('no_match');
    expect(typeof decision.detail).toBe('string');
    expect(decision.recoverableBy).toBe('relax_constraints');
  });

  it('E6-2: AbstainReason — all 4 literals are valid', () => {
    const reasons: AbstainReason[] = [
      'no_match',
      'low_confidence',
      'semantic_conflict',
      'insufficient_evidence',
    ];
    expect(reasons).toHaveLength(4);
    for (const r of reasons) expect(typeof r).toBe('string');
  });

  it('E6-3: RecoveryAction — all 4 literals are valid', () => {
    const actions: RecoveryAction[] = [
      'relax_constraints',
      'clarify',
      'retry_with_dense',
      'split_query',
    ];
    expect(actions).toHaveLength(4);
  });
});

// ─── E6-4/5: ClarifyKind + StructuredClarifyPayload ──────────────────────────

describe('E6: StructuredClarifyPayload', () => {
  it('E6-4: ClarifyKind — all 4 literals valid', () => {
    const kinds: ClarifyKind[] = [
      'anchor_disambiguation',
      'constraint_conflict',
      'preference_gap',
      'budget_gap',
    ];
    expect(kinds).toHaveLength(4);
  });

  it('E6-5: StructuredClarifyPayload requires kind + question; options optional', () => {
    const payload: StructuredClarifyPayload = {
      kind: 'anchor_disambiguation',
      question: '마르고라고 하신 게 Château Margaux인가요?',
      options: ['Château Margaux', 'Margaux AOC wines'],
      optionEntities: [
        {
          entityId: 'chateau-margaux-2015' as never,
          label: 'Château Margaux',
        },
      ],
    };
    expect(payload.kind).toBe('anchor_disambiguation');
    expect(typeof payload.question).toBe('string');
    expect(payload.options).toHaveLength(2);
    expect(payload.optionEntities).toHaveLength(1);
  });

  it('E6-18: StructuredClarifyPayload.conflictingAtoms is [string, string] tuple', () => {
    const payload: StructuredClarifyPayload = {
      kind: 'constraint_conflict',
      question: '드라이하면서 달달한 와인을 원하시나요?',
      conflictingAtoms: ['sweetness', 'dryness'],
    };
    expect(payload.conflictingAtoms).toHaveLength(2);
    expect(payload.conflictingAtoms![0]).toBe('sweetness');
    expect(payload.conflictingAtoms![1]).toBe('dryness');
  });

  it('E6-5b: budget_gap payload has gapDescription', () => {
    const payload: StructuredClarifyPayload = {
      kind: 'budget_gap',
      question: '5만원 이하에서 Grand Cru는 찾기 어렵습니다. 예산을 조정하시겠어요?',
      gapDescription: 'Grand Cru wines start at ₩80,000; your budget cap is ₩50,000.',
      options: ['Relax budget to ₩100,000', 'Search Premier Cru instead'],
    };
    expect(payload.gapDescription).toBeDefined();
    expect(payload.kind).toBe('budget_gap');
  });
});

// ─── E6-6: ChannelDegradationSummary ─────────────────────────────────────────

describe('E6: ChannelDegradationSummary', () => {
  it('E6-6: ChannelDegradationSummary has 3 required boolean fields', () => {
    const summary: ChannelDegradationSummary = {
      denseDegraded: true,
      anchorDegraded: true,
      sparseDegraded: false,
    };
    expect(typeof summary.denseDegraded).toBe('boolean');
    expect(typeof summary.anchorDegraded).toBe('boolean');
    expect(typeof summary.sparseDegraded).toBe('boolean');
  });
});

// ─── E6-7 to E6-15: AbstainPolicy.evaluate() ─────────────────────────────────

describe('E6: AbstainPolicy.evaluate()', () => {
  const policy = new AbstainPolicy(0.95, 3);

  it('E6-7: no_match when topKScores is empty', () => {
    const result = policy.evaluate([], NO_RELATIONS, HEALTHY_CHANNELS, LTR_CTX);
    expect(result).not.toBe(false);
    const decision = result as TypedAbstainDecision;
    expect(decision.shouldAbstain).toBe(true);
    expect(decision.reason).toBe('no_match');
    expect(decision.recoverableBy).toBe('relax_constraints');
  });

  it('E6-8: semantic_conflict when soft_tension relation present', () => {
    const relations = [makeSoftTension()];
    const result = policy.evaluate(CONFIDENT_SCORES, relations, HEALTHY_CHANNELS, LTR_CTX);
    expect(result).not.toBe(false);
    const decision = result as TypedAbstainDecision;
    expect(decision.reason).toBe('semantic_conflict');
    expect(decision.recoverableBy).toBe('clarify');
  });

  it('E6-9: semantic_conflict when contradiction relation present', () => {
    const relations = [makeContradiction()];
    const result = policy.evaluate(CONFIDENT_SCORES, relations, HEALTHY_CHANNELS, LTR_CTX);
    expect(result).not.toBe(false);
    const decision = result as TypedAbstainDecision;
    expect(decision.reason).toBe('semantic_conflict');
  });

  it('E6-10: insufficient_evidence when dense+anchor both degraded', () => {
    const degraded: ChannelDegradationSummary = {
      denseDegraded: true,
      anchorDegraded: true,
      sparseDegraded: false,
    };
    const result = policy.evaluate(CONFIDENT_SCORES, NO_RELATIONS, degraded, LTR_CTX);
    expect(result).not.toBe(false);
    const decision = result as TypedAbstainDecision;
    expect(decision.reason).toBe('insufficient_evidence');
    expect(decision.recoverableBy).toBe('retry_with_dense');
  });

  it('E6-10b: does NOT abstain when only dense degraded (anchor still available)', () => {
    const partialDegraded: ChannelDegradationSummary = {
      denseDegraded: true,
      anchorDegraded: false,
      sparseDegraded: false,
    };
    const result = policy.evaluate(CONFIDENT_SCORES, NO_RELATIONS, partialDegraded, LTR_CTX);
    expect(result).toBe(false);
  });

  it('E6-11: low_confidence when entropy gate fires with ltrAvailable=true', () => {
    const result = policy.evaluate(UNIFORM_SCORES, NO_RELATIONS, HEALTHY_CHANNELS, LTR_CTX);
    expect(result).not.toBe(false);
    const decision = result as TypedAbstainDecision;
    expect(decision.reason).toBe('low_confidence');
    expect(decision.recoverableBy).toBe('clarify');
    expect(decision.detail).toContain('entropy=');
  });

  it('E6-12: returns false for healthy, confident results', () => {
    const result = policy.evaluate(CONFIDENT_SCORES, NO_RELATIONS, HEALTHY_CHANNELS, LTR_CTX);
    expect(result).toBe(false);
  });

  it('E6-13: no_match takes priority over semantic_conflict', () => {
    const relations = [makeSoftTension()];
    // Empty scores + conflict → no_match wins
    const result = policy.evaluate([], relations, HEALTHY_CHANNELS, LTR_CTX);
    expect(result).not.toBe(false);
    const decision = result as TypedAbstainDecision;
    expect(decision.reason).toBe('no_match');
  });

  it('E6-14: semantic_conflict takes priority over insufficient_evidence', () => {
    const relations = [makeSoftTension()];
    const degraded: ChannelDegradationSummary = {
      denseDegraded: true,
      anchorDegraded: true,
      sparseDegraded: false,
    };
    const result = policy.evaluate(CONFIDENT_SCORES, relations, degraded, LTR_CTX);
    expect(result).not.toBe(false);
    const decision = result as TypedAbstainDecision;
    expect(decision.reason).toBe('semantic_conflict');
  });

  it('E6-15: conflictingRelations populated for semantic_conflict', () => {
    const tension = makeSoftTension();
    const result = policy.evaluate(CONFIDENT_SCORES, [tension], HEALTHY_CHANNELS, LTR_CTX);
    expect(result).not.toBe(false);
    const decision = result as TypedAbstainDecision;
    expect(decision.conflictingRelations).toBeDefined();
    expect(decision.conflictingRelations!).toHaveLength(1);
    expect(decision.conflictingRelations![0]!.type).toBe('soft_tension');
  });

  it('E6-15b: conflictingRelations includes multiple relations when 2+ conflicts exist', () => {
    const relations = [makeSoftTension(), makeContradiction()];
    const result = policy.evaluate(CONFIDENT_SCORES, relations, HEALTHY_CHANNELS, LTR_CTX);
    const decision = result as TypedAbstainDecision;
    expect(decision.conflictingRelations!).toHaveLength(2);
  });
});

// ─── E6-16/17: ClarificationPayload + legacy shouldAbstain ───────────────────

describe('E6: ClarificationPayload + legacy compatibility', () => {
  it('E6-16: ClarificationPayload.structuredPayload is optional', () => {
    const legacy: ClarificationPayload = {
      reason: 'Multiple matches for "Margaux"',
      candidates: [],
      suggestionType: 'disambiguation',
    };
    expect(legacy.structuredPayload).toBeUndefined();

    const structured: ClarificationPayload = {
      reason: 'Multiple matches for "Margaux"',
      candidates: [],
      suggestionType: 'disambiguation',
      structuredPayload: {
        kind: 'anchor_disambiguation',
        question: '어떤 마르고를 찾으시나요?',
        options: ['Château Margaux', 'Margaux AOC'],
        optionEntities: [
          {
            entityId: 'chateau-margaux-2015' as never,
            label: 'Château Margaux',
          },
        ],
      },
    };
    expect(structured.structuredPayload?.kind).toBe('anchor_disambiguation');
    expect(structured.structuredPayload?.optionEntities?.[0]?.entityId).toBe('chateau-margaux-2015');
  });

  it('E6-17: AbstainPolicy.shouldAbstain() legacy API still returns AbstainDecision', () => {
    const policy = new AbstainPolicy();
    // Legacy API — no TypedAbstainDecision, no context
    const result = policy.shouldAbstain([1.0, 1.0, 1.0, 1.0, 1.0]);
    expect(typeof result.abstain).toBe('boolean');
    if (result.abstain) {
      expect(typeof result.entropy).toBe('number');
    }
  });
});

// ─── E6-19 to E6-25: Additional coverage from critical audit ─────────────────

describe('E6: Additional regression coverage (critical audit findings)', () => {
  const policy = new AbstainPolicy(0.95, 3);
  const CONFIDENT_SCORES = [10.0, 0.1, 0.1, 0.1, 0.1];
  const UNIFORM_SCORES = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
  const LTR_CTX = { ltrAvailable: true };
  const HEALTHY: ChannelDegradationSummary = { denseDegraded: false, anchorDegraded: false, sparseDegraded: false };
  const DEGRADED: ChannelDegradationSummary = { denseDegraded: true, anchorDegraded: true, sparseDegraded: false };

  it('E6-19: no_match result has no entropy field', () => {
    const result = policy.evaluate([], [], HEALTHY, LTR_CTX);
    expect(result).not.toBe(false);
    const d = result as TypedAbstainDecision;
    expect(d.reason).toBe('no_match');
    expect(d.entropy).toBeUndefined();
  });

  it('E6-20: insufficient_evidence result has no entropy field', () => {
    const result = policy.evaluate(CONFIDENT_SCORES, [], DEGRADED, LTR_CTX);
    expect(result).not.toBe(false);
    const d = result as TypedAbstainDecision;
    expect(d.reason).toBe('insufficient_evidence');
    expect(d.entropy).toBeUndefined();
  });

  it('E6-21: low_confidence detail contains a valid float string', () => {
    const result = policy.evaluate(UNIFORM_SCORES, [], HEALTHY, LTR_CTX);
    expect(result).not.toBe(false);
    const d = result as TypedAbstainDecision;
    expect(d.reason).toBe('low_confidence');
    // entropy= followed by a 4-decimal float
    expect(d.detail).toMatch(/entropy=\d+\.\d{4}/);
    expect(d.entropy).toBeDefined();
    expect(Number.isFinite(d.entropy)).toBe(true);
    expect(d.entropy).toBeGreaterThan(0);
    expect(d.entropy).toBeLessThanOrEqual(1);
  });

  it('E6-22: sparse-only with 1 score + both channels degraded → insufficient_evidence', () => {
    const result = policy.evaluate([5.0], [], DEGRADED, LTR_CTX);
    expect(result).not.toBe(false);
    const d = result as TypedAbstainDecision;
    expect(d.reason).toBe('insufficient_evidence');
  });

  it('E6-23: sparse-only with 2 scores + both channels degraded → insufficient_evidence (precedes entropy gate)', () => {
    const result = policy.evaluate([5.0, 4.0], [], DEGRADED, LTR_CTX);
    expect(result).not.toBe(false);
    const d = result as TypedAbstainDecision;
    expect(d.reason).toBe('insufficient_evidence');
  });

  it('E6-24: redundancy/overshadow relations do NOT trigger semantic_conflict', () => {
    const redundancy: ConstraintRelation = {
      type: 'redundancy',
      atomIndexA: 0,
      atomIndexB: 1,
      winner: 'a',
      explanation: 'duplicate',
    };
    const overshadow: ConstraintRelation = {
      type: 'overshadow',
      atomIndexA: 0,
      atomIndexB: 1,
      winner: 'a',
      explanation: 'overshadow',
    };
    const result = policy.evaluate(CONFIDENT_SCORES, [redundancy, overshadow], HEALTHY, LTR_CTX);
    expect(result).toBe(false);
  });

  it('E6-25: entropy field on TypedAbstainDecision matches the entropy from shouldAbstain', () => {
    const result = policy.evaluate(UNIFORM_SCORES, [], HEALTHY, LTR_CTX);
    expect(result).not.toBe(false);
    const d = result as TypedAbstainDecision;
    // Cross-check: run shouldAbstain directly and compare entropy
    const legacy = policy.shouldAbstain(UNIFORM_SCORES, LTR_CTX);
    expect(legacy.abstain).toBe(true);
    if (legacy.abstain) {
      expect(d.entropy).toBe(legacy.entropy);
    }
  });
});
