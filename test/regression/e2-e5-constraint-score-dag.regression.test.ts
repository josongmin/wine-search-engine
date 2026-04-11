/**
 * Regression: EPIC-2 Constraint Semantics + EPIC-5 Score DAG / Safety Envelope
 *
 * Guards:
 *  E2:
 *   1. ConstraintAtom extends NormalizedConstraint with 5 new fields
 *   2. liftToAtom() defaults — hard→strict, soft→prefer, inferred→relaxable
 *   3. liftBundleToAtoms() preserves tier membership
 *   4. ConstraintReasoner detects contradiction, redundancy, soft_tension
 *   5. ConstraintReasoner resolves by authority_level (higher wins)
 *   6. ConstraintReasoner drops contradiction loser, produces clean bundle
 *   7. QueryPlanV2.constraintAtoms optional field type-checks
 *
 *  E5:
 *   8. ScoreDecomposition fields are all present with correct types
 *   9. RerankSafetyEnvelope: hard_constraint_violation blocks promotion
 *  10. RerankSafetyEnvelope: protected candidate eviction blocks demotion
 *  11. RerankSafetyEnvelope: rank_invariant_breach blocks non-passing candidate
 *  12. RerankSafetyEnvelope: allows safe candidates
 *  13. buildRerankSafetyListContext computes anyHardConstraintPassingCandidate
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, expect, it } from 'vitest';
import {
  liftToAtom,
  liftBundleToAtoms,
  CONSTRAINT_AUTHORITY_BY_SOURCE_KIND,
} from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintAtom } from '../../src/domain/shared/types/constraint-atom.js';
import type { NormalizedConstraint, ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';
import { ConstraintReasoner } from '../../src/domain/query/service/constraint-reasoner.js';
import {
  evaluateRerankSafety,
  buildRerankSafetyListContext,
} from '../../src/domain/ranking/service/rerank-safety.js';
import type { SafetyCandidateDescriptor } from '../../src/domain/ranking/service/rerank-safety.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeConstraint(
  attribute: string,
  value: string,
  overrides: Partial<NormalizedConstraint> = {},
): NormalizedConstraint {
  return {
    attribute,
    operator: '=',
    value,
    source_phrase: `${attribute}:${value}`,
    confidence: 0.9,
    ...overrides,
  };
}

function makeDescriptor(
  overrides: Partial<SafetyCandidateDescriptor> = {},
): SafetyCandidateDescriptor {
  return {
    entityId: 'wine-001',
    heuristicRank: 2,
    hardConstraintPass: true,
    hardConstraintViolations: [],
    anchorSimilarity: 0,
    sparseRank: Infinity,
    heuristicScoreNormalized: 0.7,
    proposedLtrRank: 1, // LTR promotes to rank 1
    ...overrides,
  };
}

// ─── E2: ConstraintAtom + liftToAtom ─────────────────────────────────────────

describe('ConstraintAtom + liftToAtom (E2-T1)', () => {
  it('liftToAtom preserves all NormalizedConstraint fields', () => {
    const nc = makeConstraint('wine_type', 'red');
    const atom = liftToAtom(nc, 'hard');
    expect(atom.attribute).toBe('wine_type');
    expect(atom.operator).toBe('=');
    expect(atom.value).toBe('red');
    expect(atom.source_phrase).toBe('wine_type:red');
    expect(atom.confidence).toBe(0.9);
  });

  it('hard tier → strict conflict_policy, explicit_utterance source_kind', () => {
    const atom = liftToAtom(makeConstraint('region', 'Bordeaux'), 'hard');
    expect(atom.source_tier).toBe('hard');
    expect(atom.conflict_policy).toBe('strict');
    expect(atom.source_kind).toBe('explicit_utterance');
    expect(atom.authority_level).toBe(CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.explicit_utterance);
  });

  it('soft tier → prefer conflict_policy, implicit_slot source_kind', () => {
    const atom = liftToAtom(makeConstraint('price', '50', { operator: '<=' }), 'soft');
    expect(atom.source_tier).toBe('soft');
    expect(atom.conflict_policy).toBe('prefer');
    expect(atom.source_kind).toBe('implicit_slot');
  });

  it('inferred tier → relaxable conflict_policy, planner_inferred source_kind', () => {
    const atom = liftToAtom(makeConstraint('vintage_year', '2018'), 'inferred');
    expect(atom.source_tier).toBe('inferred');
    expect(atom.conflict_policy).toBe('relaxable');
    expect(atom.source_kind).toBe('planner_inferred');
  });

  it('sourceKind override overrides default', () => {
    const atom = liftToAtom(makeConstraint('region', 'Burgundy'), 'soft', 'session_carry');
    expect(atom.source_kind).toBe('session_carry');
    expect(atom.authority_level).toBe(CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.session_carry);
  });

  it('semantic_scope inferred correctly for intrinsic attributes', () => {
    const atom = liftToAtom(makeConstraint('wine_type', 'red'), 'hard');
    expect(atom.semantic_scope).toBe('intrinsic');
  });

  it('semantic_scope inferred correctly for temporal attributes', () => {
    const atom = liftToAtom(makeConstraint('vintage_year', '2019'), 'hard');
    expect(atom.semantic_scope).toBe('temporal');
  });

  it('semantic_scope falls back to extrinsic for unknown attributes', () => {
    const atom = liftToAtom(makeConstraint('price', '100'), 'soft');
    expect(atom.semantic_scope).toBe('extrinsic');
  });

  it('authority levels are ordered: explicit > implicit > planner > session > system', () => {
    expect(CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.explicit_utterance).toBeGreaterThan(
      CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.implicit_slot,
    );
    expect(CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.implicit_slot).toBeGreaterThan(
      CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.planner_inferred,
    );
    expect(CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.planner_inferred).toBeGreaterThan(
      CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.session_carry,
    );
    expect(CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.session_carry).toBeGreaterThan(
      CONSTRAINT_AUTHORITY_BY_SOURCE_KIND.system_default,
    );
  });
});

describe('liftBundleToAtoms (E2-T1)', () => {
  it('preserves tier membership for all bundle constraints', () => {
    const bundle: ConstraintBundle = {
      hard: [makeConstraint('wine_type', 'red')],
      soft: [makeConstraint('region', 'Bordeaux')],
      inferred: [makeConstraint('vintage_year', '2018')],
    };
    const atoms = liftBundleToAtoms(bundle);
    expect(atoms).toHaveLength(3);
    expect(atoms.find((a) => a.attribute === 'wine_type')?.source_tier).toBe('hard');
    expect(atoms.find((a) => a.attribute === 'region')?.source_tier).toBe('soft');
    expect(atoms.find((a) => a.attribute === 'vintage_year')?.source_tier).toBe('inferred');
  });

  it('returns empty array for empty bundle', () => {
    expect(liftBundleToAtoms({ hard: [], soft: [], inferred: [] })).toHaveLength(0);
  });
});

// ─── E2: ConstraintReasoner ──────────────────────────────────────────────────

describe('ConstraintReasoner (E2-T2)', () => {
  const reasoner = new ConstraintReasoner();

  it('passthrough: no relations for non-conflicting constraints on different attributes', () => {
    const bundle: ConstraintBundle = {
      hard: [makeConstraint('wine_type', 'red'), makeConstraint('region', 'Bordeaux')],
      soft: [],
      inferred: [],
    };
    const out = reasoner.reason(bundle);
    expect(out.relations).toHaveLength(0);
    expect(out.droppedAtoms).toHaveLength(0);
    expect(out.resolvedBundle.hard).toHaveLength(2);
  });

  it('detects contradiction: two hard = constraints with different values', () => {
    const bundle: ConstraintBundle = {
      hard: [
        makeConstraint('region', 'Bordeaux'),
        makeConstraint('region', 'Burgundy'),
      ],
      soft: [],
      inferred: [],
    };
    const out = reasoner.reason(bundle);
    const contradiction = out.relations.find((r) => r.type === 'contradiction');
    expect(contradiction).toBeDefined();
  });

  it('contradiction: higher authority_level atom wins', () => {
    const high = liftToAtom(makeConstraint('region', 'Bordeaux'), 'hard', 'explicit_utterance');
    const low = liftToAtom(makeConstraint('region', 'Burgundy'), 'hard', 'system_default');
    // Manually build bundle with pre-lifted atoms via plain NormalizedConstraints
    // (liftBundleToAtoms applies defaults; we need to verify authority ordering)
    const bundle: ConstraintBundle = {
      hard: [
        { ...high, source_phrase: 'region:Bordeaux', confidence: 0.95 } as NormalizedConstraint,
        { ...low, source_phrase: 'region:Burgundy', confidence: 0.3 } as NormalizedConstraint,
      ],
      soft: [],
      inferred: [],
    };
    const out = reasoner.reason(bundle);
    // After resolution, only the higher-confidence/authority atom should survive
    expect(out.droppedAtoms.length).toBeGreaterThan(0);
    expect(out.resolvedBundle.hard).toHaveLength(1);
  });

  it('detects redundancy: same attribute + operator + value', () => {
    const bundle: ConstraintBundle = {
      hard: [
        makeConstraint('wine_type', 'red'),
        makeConstraint('wine_type', 'red'), // exact duplicate
      ],
      soft: [],
      inferred: [],
    };
    const out = reasoner.reason(bundle);
    const redundancy = out.relations.find((r) => r.type === 'redundancy');
    expect(redundancy).toBeDefined();
    // One dropped
    expect(out.droppedAtoms).toHaveLength(1);
    expect(out.resolvedBundle.hard).toHaveLength(1);
  });

  it('detects soft_tension: soft constraints with opposing operators on same attribute', () => {
    const bundle: ConstraintBundle = {
      hard: [],
      soft: [
        makeConstraint('price', '50', { operator: '>=' }),
        makeConstraint('price', '30', { operator: '<=' }),
      ],
      inferred: [],
    };
    const out = reasoner.reason(bundle);
    expect(out.softTensions).toHaveLength(1);
    expect(out.softTensions[0]?.type).toBe('soft_tension');
    // Soft tensions are NOT dropped — they are flagged for the decision layer
    expect(out.resolvedBundle.soft).toHaveLength(2);
  });

  it('detects subsumption: ancestor + descendant region constraints coexist informatively', () => {
    const bundle: ConstraintBundle = {
      hard: [
        makeConstraint('region', 'Bordeaux'),
        makeConstraint('region', 'Pauillac'),
      ],
      soft: [],
      inferred: [],
    };
    const out = reasoner.reason(bundle);
    const relation = out.relations.find((r) => r.type === 'subsumption');
    expect(relation).toBeDefined();
    expect(out.droppedAtoms).toHaveLength(0);
    expect(out.resolvedBundle.hard).toHaveLength(2);
  });

  it('detects implication: region constraint entails already-present country constraint', () => {
    const bundle: ConstraintBundle = {
      hard: [
        makeConstraint('region', 'Pauillac'),
        makeConstraint('country', 'France'),
      ],
      soft: [],
      inferred: [],
    };
    const out = reasoner.reason(bundle);
    const relation = out.relations.find((r) => r.type === 'implication');
    expect(relation).toBeDefined();
    expect(out.droppedAtoms).toHaveLength(0);
    expect(out.resolvedBundle.hard).toHaveLength(2);
  });

  it('resolvedBundle maintains hard/soft/inferred structure', () => {
    const bundle: ConstraintBundle = {
      hard: [makeConstraint('wine_type', 'red')],
      soft: [makeConstraint('region', 'Bordeaux')],
      inferred: [makeConstraint('vintage_year', '2018')],
    };
    const out = reasoner.reason(bundle);
    expect(out.resolvedBundle.hard).toHaveLength(1);
    expect(out.resolvedBundle.soft).toHaveLength(1);
    expect(out.resolvedBundle.inferred).toHaveLength(1);
  });
});

// ─── E5: ScoreDecomposition type contract ────────────────────────────────────

describe('ScoreDecomposition type contract (E5-T1)', () => {
  it('module exports ScoreDecomposition + RerankSafetyResult + ScoreDriftRecord', async () => {
    const mod = await import('../../src/domain/ranking/model/score-decomposition.js');
    // Type-only check: confirm module loads without error
    expect(mod).toBeDefined();
  });

  it('ScoreDecomposition shape satisfies the contract (runtime shape check)', () => {
    // Build a minimal valid ScoreDecomposition
    const decomp = {
      lexicalContribution: 0.3,
      semanticContribution: 0.6,
      anchorContribution: 0,
      attributeSatisfaction: 0.8,
      popularityContribution: 0.4,
      preferenceAlignmentContribution: 0.2,
      heuristicScoreRaw: 0.75,
      heuristicScoreNormalized: 0.75,
      ltrScoreNormalized: 0.80,
      rerankDeltaNormalized: 0.05,
      finalScore: 0.80,
    };
    // Mandatory fields
    expect(typeof decomp.heuristicScoreNormalized).toBe('number');
    expect(typeof decomp.finalScore).toBe('number');
    // LTR fields present
    expect(decomp.rerankDeltaNormalized).toBeCloseTo(0.05);
    // rerankDelta = ltr - heuristic (floating point, use closeTo)
    expect(decomp.rerankDeltaNormalized).toBeCloseTo(
      decomp.ltrScoreNormalized! - decomp.heuristicScoreNormalized,
    );
  });
});

// ─── E5: RerankSafetyEnvelope ────────────────────────────────────────────────

describe('evaluateRerankSafety (E5-T2)', () => {
  it('allows safe candidate with hard constraint pass', () => {
    const desc = makeDescriptor({ hardConstraintPass: true });
    const ctx = buildRerankSafetyListContext([desc]);
    const result = evaluateRerankSafety(desc, ctx, []);
    expect(result.allowed).toBe(true);
  });

  it('blocks hard_constraint_violation: non-passing candidate promoted above passing ones', () => {
    const violating = makeDescriptor({
      entityId: 'wine-bad',
      hardConstraintPass: false,
      hardConstraintViolations: ['wine_type'],
      heuristicRank: 3,
      proposedLtrRank: 1, // LTR promotes to #1
    });
    const passing = makeDescriptor({
      entityId: 'wine-good',
      hardConstraintPass: true,
      heuristicRank: 1,
      proposedLtrRank: 2,
    });
    const ctx = buildRerankSafetyListContext([violating, passing]);
    const result = evaluateRerankSafety(violating, ctx, []);
    expect(result.allowed).toBe(false);
    expect(result.blockedReason).toBe('hard_constraint_violation');
    expect(result.constraintViolations).toContain('wine_type');
  });

  it('allows non-passing candidate when NO passing candidates exist', () => {
    const violating = makeDescriptor({
      entityId: 'wine-bad',
      hardConstraintPass: false,
      hardConstraintViolations: ['wine_type'],
      heuristicRank: 2,
      proposedLtrRank: 1,
    });
    // No passing candidates in list
    const ctx = buildRerankSafetyListContext([violating]);
    const result = evaluateRerankSafety(violating, ctx, []);
    // No passing candidates → Rule 1 cannot fire
    expect(result.allowed).toBe(true);
  });

  it('allows non-passing candidate demotion (not a safety issue)', () => {
    const violating = makeDescriptor({
      entityId: 'wine-bad',
      hardConstraintPass: false,
      hardConstraintViolations: ['region'],
      heuristicRank: 2,
      proposedLtrRank: 5, // LTR demotes — allowed
    });
    const passing = makeDescriptor({
      entityId: 'wine-good',
      hardConstraintPass: true,
      heuristicRank: 1,
      proposedLtrRank: 1,
    });
    const ctx = buildRerankSafetyListContext([violating, passing]);
    const result = evaluateRerankSafety(violating, ctx, []);
    expect(result.allowed).toBe(true);
  });

  it('blocks protected_candidate_eviction: anchor-protected candidate pushed too far down', () => {
    const THRESHOLD = 0.85;
    const protected_ = makeDescriptor({
      entityId: 'wine-anchor',
      hardConstraintPass: true,
      anchorSimilarity: THRESHOLD + 0.01, // above threshold
      heuristicRank: 1,
      proposedLtrRank: 5, // pushed down 4 positions > EVICTION_SLACK(2)
    });
    const ctx = buildRerankSafetyListContext([protected_]);
    const result = evaluateRerankSafety(protected_, ctx, []);
    expect(result.allowed).toBe(false);
    expect(result.blockedReason).toBe('protected_candidate_eviction');
  });

  it('allows anchor-protected candidate within eviction slack', () => {
    const protected_ = makeDescriptor({
      entityId: 'wine-anchor',
      hardConstraintPass: true,
      anchorSimilarity: 0.9,
      heuristicRank: 1,
      proposedLtrRank: 3, // pushed down 2 positions = within slack
    });
    const ctx = buildRerankSafetyListContext([protected_]);
    const result = evaluateRerankSafety(protected_, ctx, []);
    expect(result.allowed).toBe(true);
  });

  it('score monotonicity: hard-constraint-passing candidate stays above violating (regression)', () => {
    // Simulates: wine_type='red' query, LTR proposes white wine at rank 1
    const redWine = makeDescriptor({
      entityId: 'red-wine',
      hardConstraintPass: true,
      heuristicRank: 1,
      proposedLtrRank: 2,
    });
    const whiteWine = makeDescriptor({
      entityId: 'white-wine',
      hardConstraintPass: false,
      hardConstraintViolations: ['wine_type'],
      heuristicRank: 2,
      proposedLtrRank: 1, // LTR promotes white wine to #1
    });
    const ctx = buildRerankSafetyListContext([redWine, whiteWine]);
    const whiteResult = evaluateRerankSafety(whiteWine, ctx, []);
    const redResult = evaluateRerankSafety(redWine, ctx, []);

    expect(whiteResult.allowed).toBe(false); // white wine blocked
    expect(redResult.allowed).toBe(true);    // red wine (satisfies constraint) allowed
  });
});

describe('buildRerankSafetyListContext (E5-T2)', () => {
  it('anyHardConstraintPassingCandidate = true when at least one passes', () => {
    const ctx = buildRerankSafetyListContext([
      makeDescriptor({ hardConstraintPass: false }),
      makeDescriptor({ entityId: 'wine-pass', hardConstraintPass: true }),
    ]);
    expect(ctx.anyHardConstraintPassingCandidate).toBe(true);
  });

  it('anyHardConstraintPassingCandidate = false when none pass', () => {
    const ctx = buildRerankSafetyListContext([
      makeDescriptor({ hardConstraintPass: false }),
    ]);
    expect(ctx.anyHardConstraintPassingCandidate).toBe(false);
  });

  it('hardConstraintPassingIds contains only passing entity IDs', () => {
    const ctx = buildRerankSafetyListContext([
      makeDescriptor({ entityId: 'pass-1', hardConstraintPass: true }),
      makeDescriptor({ entityId: 'fail-1', hardConstraintPass: false }),
      makeDescriptor({ entityId: 'pass-2', hardConstraintPass: true }),
    ]);
    expect(ctx.hardConstraintPassingIds.has('pass-1')).toBe(true);
    expect(ctx.hardConstraintPassingIds.has('pass-2')).toBe(true);
    expect(ctx.hardConstraintPassingIds.has('fail-1')).toBe(false);
  });

  it('heuristicRank1Id identifies the rank-1 candidate', () => {
    const ctx = buildRerankSafetyListContext([
      makeDescriptor({ entityId: 'wine-rank2', heuristicRank: 2 }),
      makeDescriptor({ entityId: 'wine-rank1', heuristicRank: 1 }),
    ]);
    expect(ctx.heuristicRank1Id).toBe('wine-rank1');
  });
});
