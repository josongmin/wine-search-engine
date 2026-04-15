/**
 * ADR-011 Phase 1b.1: provenance-closure migration parity.
 *
 * The trivial ConstraintGraph from ADR-010 Phase 1a is logically equivalent
 * to a flat `bundle.hard` for coverage purposes (one group_and root over
 * every slot). Therefore the graph-path output MUST be byte-identical to
 * the flat-path output for any scenario where the graph is a trivial
 * projection of the same bundle.
 *
 * Locks: rollback via `CONSTRAINT_GRAPH_EMIT=false` is a no-behaviour-change.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHybridCandidateCoverageStage,
  buildRankedResultCoverageStage,
} from '../../src/application/search/search-usecase-provenance-closure.js';
import { buildTrivialGraphFromAtoms } from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import { liftBundleToAtoms } from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { RankedResult } from '../../src/domain/ranking/model/ranked-result.js';
import type { ProvenancePolicy } from '../../src/domain/query/model/engine-execution-contract.js';

const BUNDLE: ConstraintBundle = {
  hard: [
    { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
    { attribute: 'region', operator: '=', value: 'Bordeaux', source_phrase: 'Bordeaux', confidence: 1 },
  ],
  soft: [],
  inferred: [],
};

function makePlan(): QueryPlanV1 {
  return {
    rawQuery: 'red Bordeaux',
    normalizedQuery: 'red bordeaux',
    intent: 'search' as QueryPlanV1['intent'],
    anchors: [],
    constraints: BUNDLE,
    expansions: { lexical: [], semantic: [] },
    uncertainty: {
      parsing: 'low',
      anchoring: 'low',
      constraints: 'low',
    } as QueryPlanV1['uncertainty'],
    queryClass: 'constraint_only' as QueryPlanV1['queryClass'],
    plannerVersion: '0',
    policyRuleVersion: '0',
    thresholdProfileId: 'default',
    suggestedRoute: 'hybrid',
    suggestedRetrievalMode: 'attribute_search',
  } as QueryPlanV1;
}

const POLICY: ProvenancePolicy = {
  requireIdentitySeal: false,
  requireConstraintEvidence: true,
  requireAnchorEvidence: false,
};

function makeCandidate(matched: readonly string[]): HybridCandidate {
  return {
    entityId: 'e1' as HybridCandidate['entityId'],
    publicEntityId: 'e1',
    baseScore: 1,
    retrievalProvenance: { channels: [] },
    matchedConstraints: matched,
  } as HybridCandidate;
}

function makeRanked(matched: readonly string[], unmet: readonly string[]): RankedResult {
  return {
    entityId: 'e1',
    publicEntityId: 'e1',
    rank: 1,
    componentScores: {},
    evidenceItems: [],
    matchedConstraints: matched,
    unmetConstraints: unmet,
  } as unknown as RankedResult;
}

describe('provenance-closure — graph path parity with flat path', () => {
  const plan = makePlan();
  const atoms = liftBundleToAtoms(BUNDLE);
  const graph = buildTrivialGraphFromAtoms(atoms);

  it('buildHybridCandidateCoverageStage — all matched: graph === flat', () => {
    const candidates = [makeCandidate(['wine_type', 'region'])];
    const flat = buildHybridCandidateCoverageStage(plan, candidates, POLICY);
    const withGraph = buildHybridCandidateCoverageStage(plan, candidates, POLICY, graph);
    expect([...withGraph.matchedConstraintAttributes].sort()).toEqual(
      [...flat.matchedConstraintAttributes].sort(),
    );
    expect(withGraph.unmetConstraintAttributes).toEqual(flat.unmetConstraintAttributes);
    expect(withGraph.constraintEvidenceSatisfied).toBe(flat.constraintEvidenceSatisfied);
  });

  it('buildHybridCandidateCoverageStage — partial match: graph === flat', () => {
    const candidates = [makeCandidate(['wine_type'])];
    const flat = buildHybridCandidateCoverageStage(plan, candidates, POLICY);
    const withGraph = buildHybridCandidateCoverageStage(plan, candidates, POLICY, graph);
    expect([...withGraph.matchedConstraintAttributes].sort()).toEqual(
      [...flat.matchedConstraintAttributes].sort(),
    );
    expect([...withGraph.unmetConstraintAttributes].sort()).toEqual(
      [...flat.unmetConstraintAttributes].sort(),
    );
    expect(withGraph.constraintEvidenceSatisfied).toBe(flat.constraintEvidenceSatisfied);
    // Flat path: unmet = ['region']; graph path: same (trivial graph is AND of all slots).
    expect(withGraph.unmetConstraintAttributes).toContain('region');
  });

  it('buildHybridCandidateCoverageStage — no candidates: graph === flat', () => {
    const flat = buildHybridCandidateCoverageStage(plan, [], POLICY);
    const withGraph = buildHybridCandidateCoverageStage(plan, [], POLICY, graph);
    expect([...withGraph.unmetConstraintAttributes].sort()).toEqual(
      [...flat.unmetConstraintAttributes].sort(),
    );
    expect(withGraph.constraintEvidenceSatisfied).toBe(flat.constraintEvidenceSatisfied);
  });

  it('buildRankedResultCoverageStage — top result matched: graph === flat', () => {
    const ranked = [makeRanked(['wine_type', 'region'], [])];
    const flat = buildRankedResultCoverageStage(plan, ranked, POLICY);
    const withGraph = buildRankedResultCoverageStage(plan, ranked, POLICY, graph);
    expect([...withGraph.matchedConstraintAttributes].sort()).toEqual(
      [...flat.matchedConstraintAttributes].sort(),
    );
    expect([...withGraph.unmetConstraintAttributes].sort()).toEqual(
      [...flat.unmetConstraintAttributes].sort(),
    );
    expect(withGraph.constraintEvidenceSatisfied).toBe(flat.constraintEvidenceSatisfied);
  });

  it('buildRankedResultCoverageStage — empty results: graph === flat (flat path reports all unmet)', () => {
    const flat = buildRankedResultCoverageStage(plan, [], POLICY);
    const withGraph = buildRankedResultCoverageStage(plan, [], POLICY, graph);
    // With an empty result set AND the trivial graph, the graph path sees
    // satisfiedAttributes = ∅ and every slot is unmet — matches the flat path.
    expect([...withGraph.unmetConstraintAttributes].sort()).toEqual(
      [...flat.unmetConstraintAttributes].sort(),
    );
    expect(withGraph.constraintEvidenceSatisfied).toBe(flat.constraintEvidenceSatisfied);
  });
});
