/**
 * ADR-011 Phase 1b.3a: decision-input graph migration parity.
 *
 * With the Phase-1a trivial ConstraintGraph threaded through
 * `executionContext.constraintGraph`, `buildSearchDecisionInput`'s
 * `matchedRequiredAttributes` / `unmetRequiredAttributes` MUST equal the
 * flat-bundle computation byte-for-byte.
 *
 * Also locks XOR / OR graph-aware behaviour so provenance-closure and
 * decision-input cannot drift.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { buildSearchDecisionInput } from '../../src/application/search/search-usecase-decision-input.js';
import { buildTrivialGraphFromAtoms } from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import { liftBundleToAtoms } from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';
import type { ConstraintGraph, ConstraintGraphNode } from '../../src/domain/query/model/constraint-graph.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../src/domain/ranking/model/ranked-result.js';

const BUNDLE: ConstraintBundle = {
  hard: [
    { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
    { attribute: 'region', operator: '=', value: 'Bordeaux', source_phrase: 'Bordeaux', confidence: 1 },
  ],
  soft: [],
  inferred: [],
};

function makePlan(bundle: ConstraintBundle = BUNDLE): QueryPlanV1 {
  return {
    rawQuery: 'red Bordeaux',
    normalizedQuery: 'red bordeaux',
    intent: 'search' as QueryPlanV1['intent'],
    anchors: [],
    constraints: bundle,
    expansions: { lexical: [], semantic: [] },
    uncertainty: { parsing: 'low', anchoring: 'low', constraints: 'low' } as QueryPlanV1['uncertainty'],
    queryClass: 'constraint_only' as QueryPlanV1['queryClass'],
    plannerVersion: '0',
    policyRuleVersion: '0',
    thresholdProfileId: 'default',
    suggestedRoute: 'hybrid',
    suggestedRetrievalMode: 'attribute_search',
    route: 'hybrid',
  } as QueryPlanV1;
}

function makeResolveResult(): EntityResolveResult {
  return {
    candidates: [],
    topEntity: undefined,
    aliasMiss: false,
    decisionTrace: {
      outcomeReasonCodes: [],
      identityCorroboration: [],
      confidenceBands: [],
    },
  } as unknown as EntityResolveResult;
}

function makeRanked(matched: readonly string[], unmet: readonly string[]): RankedResult {
  return {
    entityId: 'e1',
    publicEntityId: 'e1',
    rank: 1,
    componentScores: {
      entityIntegrity: 1,
      hardConstraintPass: true,
      softConstraint: 1,
      uncertaintyPenalty: 0,
    },
    evidenceItems: [],
    matchedConstraints: matched,
    unmetConstraints: unmet,
    inferredConstraints: [],
    retrievalProvenance: { channels: [] },
  } as unknown as RankedResult;
}

function slot(id: string, attribute: string): ConstraintGraphNode {
  return {
    kind: 'slot', nodeId: id, atomRef: id, attribute,
    operator: '=', value: 'x', sourceTier: 'hard',
    sourceKind: 'explicit_utterance', confidence: 1,
  };
}

describe('buildSearchDecisionInput — trivial graph parity with flat', () => {
  const plan = makePlan();
  const resolveResult = makeResolveResult();
  const atoms = liftBundleToAtoms(BUNDLE);
  const graph = buildTrivialGraphFromAtoms(atoms);

  it('all matched: graph path === flat path (matched + unmet)', () => {
    const ranked = [makeRanked(['wine_type', 'region'], [])];
    const flat = buildSearchDecisionInput({
      plan,
      resolveResult,
      rankedResults: ranked,
      effectiveRoute: 'hybrid',
      executionContext: {
        provenancePolicy: { requireIdentitySeal: false, requireConstraintEvidence: false, requireAnchorEvidence: false },
      },
    });
    const withGraph = buildSearchDecisionInput({
      plan,
      resolveResult,
      rankedResults: ranked,
      effectiveRoute: 'hybrid',
      executionContext: {
        provenancePolicy: { requireIdentitySeal: false, requireConstraintEvidence: false, requireAnchorEvidence: false },
        constraintGraph: graph,
      },
    });
    expect([...(withGraph.evidenceSummary.constraintEvidence?.matchedRequiredAttributes ?? [])].sort()).toEqual(
      [...(flat.evidenceSummary.constraintEvidence?.matchedRequiredAttributes ?? [])].sort(),
    );
    expect(withGraph.evidenceSummary.constraintEvidence?.unmetRequiredAttributes ?? []).toEqual(
      flat.evidenceSummary.constraintEvidence?.unmetRequiredAttributes ?? [],
    );
  });

  it('partial match: graph === flat (one region slot unmet)', () => {
    const ranked = [makeRanked(['wine_type'], ['region'])];
    const flat = buildSearchDecisionInput({ plan, resolveResult, rankedResults: ranked, effectiveRoute: 'hybrid' });
    const withGraph = buildSearchDecisionInput({
      plan,
      resolveResult,
      rankedResults: ranked,
      effectiveRoute: 'hybrid',
      executionContext: { constraintGraph: graph },
    });
    expect([...(withGraph.evidenceSummary.constraintEvidence?.matchedRequiredAttributes ?? [])].sort()).toEqual(
      [...(flat.evidenceSummary.constraintEvidence?.matchedRequiredAttributes ?? [])].sort(),
    );
    expect([...(withGraph.evidenceSummary.constraintEvidence?.unmetRequiredAttributes ?? [])].sort()).toEqual(
      [...(flat.evidenceSummary.constraintEvidence?.unmetRequiredAttributes ?? [])].sort(),
    );
  });

  it('no rankedResults: graph path falls back to flat (no graph computation without a topResult)', () => {
    const flat = buildSearchDecisionInput({ plan, resolveResult, rankedResults: [], effectiveRoute: 'hybrid' });
    const withGraph = buildSearchDecisionInput({
      plan,
      resolveResult,
      rankedResults: [],
      effectiveRoute: 'hybrid',
      executionContext: { constraintGraph: graph },
    });
    // Both return `constraintEvidence: undefined` when topResult is absent.
    expect(withGraph.evidenceSummary.constraintEvidence).toEqual(flat.evidenceSummary.constraintEvidence);
  });
});

describe('buildSearchDecisionInput — graph-aware XOR/OR semantics', () => {
  const plan = makePlan();
  const resolveResult = makeResolveResult();

  it('XOR group: candidate matches one branch → matched carries it, unmet empty', () => {
    const graph: ConstraintGraph = {
      graphSchemaVersion: 'constraint_graph_v1',
      origin: 'deterministic_from_atoms',
      rootNodeId: 'root',
      nodes: [
        { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
        slot('s1', 'wine_type_red'),
        slot('s2', 'wine_type_white'),
      ],
      edges: [],
      globalBudgets: {},
    };
    const ranked = [makeRanked(['wine_type_red'], [])];
    const input = buildSearchDecisionInput({
      plan,
      resolveResult,
      rankedResults: ranked,
      effectiveRoute: 'hybrid',
      executionContext: { constraintGraph: graph },
    });
    expect([...(input.evidenceSummary.constraintEvidence?.matchedRequiredAttributes ?? [])]).toEqual(['wine_type_red']);
    expect(input.evidenceSummary.constraintEvidence?.unmetRequiredAttributes ?? []).toEqual([]);
  });

  it('OR group: one child matched → other child is NOT reported as unmet', () => {
    const graph: ConstraintGraph = {
      graphSchemaVersion: 'constraint_graph_v1',
      origin: 'deterministic_from_atoms',
      rootNodeId: 'root',
      nodes: [
        { kind: 'group_or', nodeId: 'root', children: ['s1', 's2'] },
        slot('s1', 'region_bordeaux'),
        slot('s2', 'region_burgundy'),
      ],
      edges: [],
      globalBudgets: {},
    };
    const ranked = [makeRanked(['region_bordeaux'], [])];
    const input = buildSearchDecisionInput({
      plan,
      resolveResult,
      rankedResults: ranked,
      effectiveRoute: 'hybrid',
      executionContext: { constraintGraph: graph },
    });
    expect(input.evidenceSummary.constraintEvidence?.matchedRequiredAttributes).toEqual(['region_bordeaux']);
    expect(input.evidenceSummary.constraintEvidence?.unmetRequiredAttributes ?? []).toEqual([]);
  });
});
