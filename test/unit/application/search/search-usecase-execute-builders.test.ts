import { describe, expect, it } from 'vitest';
import {
  buildConstraintContradictionResponseParams,
  buildEntropyAbstainResponseParams,
} from '../../../../src/application/search/search-usecase-execute-builders.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { RankedResult } from '../../../../src/domain/ranking/model/ranked-result.js';
import type { DecisionSnapshot } from '../../../../src/domain/shared/types/index.js';
import type { TypedAbstainDecision } from '../../../../src/domain/query/model/abstain-decision.js';
import type { ResultItem } from '../../../../src/domain/response/model/result-item.js';

function makePlan(): QueryPlanV1 {
  return {
    rawQuery: 'find bordeaux',
    normalizedQuery: 'find bordeaux',
    intent: 'search',
    additionalIntents: [],
    queryClass: 'short_entity',
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    anchors: [],
    uncertainty: { terms: [], confidence: 0 },
    route: 'hybrid',
    retrievalMode: 'attribute_search',
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    plannerVersion: '1.0.0',
  } as QueryPlanV1;
}

function makeCompiled(): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'find bordeaux',
      normalizedQuery: 'find bordeaux',
      intent: 'semantic_discovery',
      queryClass: 'short_entity',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {} as never,
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'attribute_search',
      routeSource: 'planner',
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  } as CompiledWineQuery;
}

function makeRankedResult(canonicalLabel: string, rank: number): RankedResult {
  return {
    entityId: createEntityId(`wine:${canonicalLabel}:${rank}`),
    canonicalLabel,
    finalScore: 0.9 - rank * 0.01,
    rank,
    componentScores: {
      entityIntegrity: 1,
      hardConstraintPass: true,
      softConstraint: 0.5,
      uncertaintyPenalty: 0,
    },
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
  };
}

function makeSnapshot(): DecisionSnapshot {
  return {
    snapshot_id: 'snapshot-1',
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
    response_contract_version: 'v1',
  };
}

function makeResultItem(
  ranked: RankedResult,
  matchType: ResultItem['match']['matchType'],
): ResultItem {
  return {
    entity: {
      entityId: ranked.entityId,
      canonicalLabel: ranked.canonicalLabel,
      type: 'wine',
    },
    relevanceScore: ranked.finalScore,
    match: {
      matchType,
      scoreComponents: {
        lexical: matchType === 'hybrid' ? 0.2 : 1,
        semantic: matchType === 'hybrid' ? 0.8 : 0,
        attribute: 0,
        popularity: 0,
      },
    },
    constraints: {
      matched: [],
      unmet: [],
      inferred: [],
    },
    uncertainty: {
      missingInfo: [],
      approximationUsed: matchType === 'hybrid',
    },
    evidenceItems: [{
      type: 'identity',
      source: 'test',
      contribution: '+0.90',
      strength: 'high',
      provenance: 'test evidence',
    }],
  };
}

describe('search-usecase-execute-builders synthetic decision traces', () => {
  it('keeps calibratedGap undefined for constraint contradiction failures', () => {
    const params = buildConstraintContradictionResponseParams({
      plan: makePlan(),
      compiled: makeCompiled(),
      snapshot: makeSnapshot(),
      requestId: 'req-1',
      startTime: Date.now(),
      conflictDesc: 'producer=foo AND producer=bar',
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'attribute_search',
    });

    expect(params.decisionOutput.decisionTrace.signals.calibratedGap).toBeUndefined();
  });

  it('keeps calibratedGap undefined for entropy abstain clarify responses', () => {
    const params = buildEntropyAbstainResponseParams({
      plan: makePlan(),
      compiled: makeCompiled(),
      snapshot: makeSnapshot(),
      requestId: 'req-2',
      startTime: Date.now(),
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'attribute_search',
      abstainDecision: {
        shouldAbstain: true,
        reason: 'low_confidence',
        detail: 'entropy=0.99',
        recoverableBy: 'clarify',
        entropy: 0.99,
      },
      entropy: 0.99,
      results: [],
      rankedResults: [],
    });

    expect(params.decisionOutput.decisionTrace.signals.calibratedGap).toBeUndefined();
  });

  it('emits abstain-specific trace semantics for insufficient_evidence responses', () => {
    const params = buildEntropyAbstainResponseParams({
      plan: makePlan(),
      compiled: makeCompiled(),
      snapshot: makeSnapshot(),
      requestId: 'req-insufficient-evidence',
      startTime: Date.now(),
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'attribute_search',
      abstainDecision: {
        shouldAbstain: true,
        reason: 'insufficient_evidence',
        detail: 'Dense and anchor retrieval channels are both degraded; sparse-only results are insufficient for confident ranking.',
        recoverableBy: 'retry_with_dense',
      },
      entropy: Number.NaN,
      results: [],
      rankedResults: [],
    });

    expect(params.decisionOutput.decisionTrace.rulesApplied).toEqual([
      'ABSTAIN_INSUFFICIENT_EVIDENCE',
    ]);
    expect(params.decisionOutput.decisionTrace.finalReason).toBe(
      'Dense and anchor retrieval channels are both degraded; sparse-only results are insufficient for confident ranking.',
    );
    expect(params.clarification.reason).toBe(
      'Dense and anchor retrieval channels are both degraded; sparse-only results are insufficient for confident ranking.',
    );
  });

  it('maps no_match abstains to failed/fail instead of ambiguous/clarify', () => {
    const params = buildEntropyAbstainResponseParams({
      plan: makePlan(),
      compiled: makeCompiled(),
      snapshot: makeSnapshot(),
      requestId: 'req-no-match',
      startTime: Date.now(),
      effectiveRoute: 'entity',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'no_match_detection',
      abstainDecision: {
        shouldAbstain: true,
        reason: 'no_match',
        detail: 'Hard constraint filter produced zero candidates.',
        recoverableBy: 'relax_constraints',
      },
      entropy: Number.NaN,
      results: [],
      rankedResults: [],
    });

    expect(params.decisionOutput.decisionStatus).toBe('failed');
    expect(params.decisionOutput.nextAction).toBe('fail');
    expect(params.decisionOutput.decisionTrace.signals.ambiguity).toBe(false);
    expect(params.abstainReason).toBe('no_match');
  });

  it('uses alias-aware clarification payload for ambiguous short-form low-confidence responses instead of generic top labels', () => {
    const plan = {
      ...makePlan(),
      rawQuery: '피노 추천',
      normalizedQuery: '피노 추천',
      queryClass: 'ambiguous_short_form',
      expansions: {
        lexical: [],
        semantic: [],
        ambiguousEntityHints: [{
          surface: '피노',
          entityType: 'grape_primary',
          retrievalConstraint: {
            attribute: 'grape_family',
            operator: '=',
            value: 'Pinot',
          },
          lexicalExpansions: ['pinot'],
          semanticExpansions: ['pinot noir', 'pinot gris', 'pinot blanc'],
          clarifyOptions: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
          explorationBranches: [
            {
              label: 'Pinot Noir',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Noir',
              },
              matchValues: ['Pinot Noir'],
              lexicalExpansions: ['pinot noir'],
              semanticExpansions: ['pinot noir'],
            },
            {
              label: 'Pinot Gris',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Gris',
              },
              matchValues: ['Pinot Gris', 'Pinot Grigio'],
              lexicalExpansions: ['pinot gris', 'pinot grigio'],
              semanticExpansions: ['pinot gris', 'pinot grigio'],
            },
            {
              label: 'Pinot Blanc',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Blanc',
              },
              matchValues: ['Pinot Blanc'],
              lexicalExpansions: ['pinot blanc'],
              semanticExpansions: ['pinot blanc'],
            },
          ],
        }],
      },
    } as QueryPlanV1;
    const compiled = makeCompiled();
    const rankedResults = [
      makeRankedResult('Generic Top Label A', 1),
      makeRankedResult('Generic Top Label B', 2),
      makeRankedResult('Generic Top Label C', 3),
    ];
    const abstainDecision: TypedAbstainDecision = {
      shouldAbstain: true,
      reason: 'low_confidence',
      detail: 'ambiguous short-form entity requires family disambiguation',
      recoverableBy: 'clarify',
      entropy: 0.97,
    };

    const params = buildEntropyAbstainResponseParams({
      plan,
      compiled,
      snapshot: makeSnapshot(),
      requestId: 'req-alias-aware',
      startTime: Date.now(),
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'attribute_search',
      abstainDecision,
      entropy: 0.97,
      results: [],
      rankedResults,
    });

    expect(params.clarification.structuredPayload).toEqual({
      kind: 'anchor_disambiguation',
      question: '피노는 어떤 계열을 찾으시나요?',
      options: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
    });
    expect(params.clarification.candidates.map((candidate) => candidate.label)).toEqual([
      'Generic Top Label A',
      'Generic Top Label B',
      'Generic Top Label C',
    ]);
  });

  it('fails closed for identity-seal ambiguous short-form clarifications', () => {
    const plan = {
      ...makePlan(),
      rawQuery: 'opus',
      normalizedQuery: 'opus',
      intent: 'entity_fuzzy',
      queryClass: 'ambiguous_short_form',
      admission_context: {
        requires_identity_seal: true,
        requires_constraint_evidence: false,
        requires_anchor_evidence: false,
      },
    } as QueryPlanV1;
    const compiled = {
      ...makeCompiled(),
      execution: {
        ...makeCompiled().execution,
        provenancePolicy: {
          requireIdentitySeal: true,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
      },
    } as CompiledWineQuery;
    const rankedResults = [
      makeRankedResult('Generic Top Label A', 1),
      makeRankedResult('Generic Top Label B', 2),
      makeRankedResult('Generic Top Label C', 3),
    ];
    const results = rankedResults.map((ranked) => makeResultItem(ranked, 'alias_exact'));

    const params = buildEntropyAbstainResponseParams({
      plan,
      compiled,
      snapshot: makeSnapshot(),
      requestId: 'req-opus',
      startTime: Date.now(),
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'entity_resolution',
      abstainDecision: {
        shouldAbstain: true,
        reason: 'low_confidence',
        detail: 'ambiguous short-form entity requires clarification',
        recoverableBy: 'clarify',
        entropy: 0.99,
      },
      entropy: 0.99,
      results,
      rankedResults,
    });

    expect(params.results).toEqual([]);
    expect(params.clarification.candidates).toEqual([]);
    expect(params.clarification.structuredPayload).toEqual({
      kind: 'preference_gap',
      question: '결과가 모호합니다. 조건을 더 구체적으로 알려주세요.',
    });
  });

  it('fails closed for identity-seal ambiguous short-form even when some identity-supported candidates exist', () => {
    // Mixed input: two alias_exact (identity-bearing) + one hybrid (non-identity)
    // candidate. When admission_context requires an identity seal, an ambiguous
    // short form fails closed regardless of whether SOME identity-supported
    // candidates exist — the gate does not surface a partial wine list as if a
    // single entity had resolved. (shouldFailClosedIdentityClarification returns
    // true on requires_identity_seal=true; both results and clarification
    // candidates are emptied, and the payload degrades to preference_gap.) The
    // no-candidate variant is covered separately below.
    const plan = {
      ...makePlan(),
      rawQuery: 'opus',
      normalizedQuery: 'opus',
      intent: 'semantic_discovery',
      queryClass: 'ambiguous_short_form',
      admission_context: {
        requires_identity_seal: true,
        requires_constraint_evidence: false,
        requires_anchor_evidence: false,
      },
    } as QueryPlanV1;
    const rankedResults = [
      {
        ...makeRankedResult('2019 Opus One Overture', 1),
        producer: 'Opus One',
      },
      {
        ...makeRankedResult('Opus One 2018', 2),
        producer: 'Opus One',
      },
      {
        ...makeRankedResult('2023 Domaines Ott Rose de Provence', 3),
        producer: 'Domaines Ott',
      },
    ] as RankedResult[];
    const results = [
      makeResultItem(rankedResults[0]!, 'alias_exact'),
      makeResultItem(rankedResults[1]!, 'alias_exact'),
      makeResultItem(rankedResults[2]!, 'hybrid'),
    ];

    const params = buildEntropyAbstainResponseParams({
      plan,
      compiled: makeCompiled(),
      snapshot: makeSnapshot(),
      requestId: 'req-opus-filter',
      startTime: Date.now(),
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'entity_resolution',
      abstainDecision: {
        shouldAbstain: true,
        reason: 'low_confidence',
        detail: 'ambiguous short-form entity requires clarification',
        recoverableBy: 'clarify',
        entropy: 0.99,
      },
      entropy: 0.99,
      results,
      rankedResults,
    });

    expect(params.results).toEqual([]);
    expect(params.clarification.candidates).toEqual([]);
    expect(params.clarification.structuredPayload).toEqual({
      kind: 'preference_gap',
      question: '결과가 모호합니다. 조건을 더 구체적으로 알려주세요.',
    });
  });

  it('deduplicates ambiguous short-form presentation candidates by display identity', () => {
    const plan = {
      ...makePlan(),
      rawQuery: 'opus',
      normalizedQuery: 'opus',
      intent: 'semantic_discovery',
      queryClass: 'ambiguous_short_form',
    } as QueryPlanV1;
    const overturePrimary = {
      ...makeRankedResult('2019 Opus One Overture', 1),
      entityId: 'wine-opus-overture-a' as never,
      producer: 'Opus One',
      region: 'Napa Valley',
      wineType: 'red',
      vintageYear: 2019,
      finalScore: 0.95,
    };
    const overtureDuplicate = {
      ...makeRankedResult('2019 Opus One Overture', 2),
      entityId: 'wine-opus-overture-b' as never,
      producer: 'Opus One',
      region: 'Napa Valley',
      wineType: 'red',
      vintageYear: 2019,
      finalScore: 0.91,
    };
    const opusOne = {
      ...makeRankedResult('Opus One 2018', 3),
      producer: 'Opus One',
      region: 'Napa Valley',
      wineType: 'red',
      vintageYear: 2018,
    };
    const rankedResults = [overturePrimary, overtureDuplicate, opusOne] as RankedResult[];
    const results = rankedResults.map((ranked) => makeResultItem(ranked, 'alias_exact'));

    const params = buildEntropyAbstainResponseParams({
      plan,
      compiled: makeCompiled(),
      snapshot: makeSnapshot(),
      requestId: 'req-opus-dedupe',
      startTime: Date.now(),
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'entity_resolution',
      abstainDecision: {
        shouldAbstain: true,
        reason: 'low_confidence',
        detail: 'ambiguous short-form entity requires clarification',
        recoverableBy: 'clarify',
        entropy: 0.99,
      },
      entropy: 0.99,
      results,
      rankedResults,
    });

    expect(params.results.map((result) => result.entity.canonicalLabel)).toEqual([
      '2019 Opus One Overture',
      'Opus One 2018',
    ]);
    expect(params.clarification.candidates.map((candidate) => candidate.label)).toEqual([
      '2019 Opus One Overture',
      'Opus One 2018',
    ]);
    expect(params.clarification.structuredPayload).toEqual({
      kind: 'anchor_disambiguation',
      question: '결과가 모호합니다. 어떤 후보를 찾으시나요?',
      options: ['2019 Opus One Overture', 'Opus One 2018'],
      optionEntities: [
        {
          entityId: 'wine-opus-overture-a' as never,
          label: '2019 Opus One Overture',
          distinguishingFeatures: [],
        },
        {
          entityId: createEntityId('wine:Opus One 2018:3'),
          label: 'Opus One 2018',
          distinguishingFeatures: [],
        },
      ],
    });
  });

  it('fails closed when ambiguous short-form presentation has no authoritative identity-supported candidates', () => {
    const plan = {
      ...makePlan(),
      rawQuery: 'opus',
      normalizedQuery: 'opus',
      intent: 'semantic_discovery',
      queryClass: 'ambiguous_short_form',
      admission_context: {
        requires_identity_seal: true,
        requires_constraint_evidence: false,
        requires_anchor_evidence: false,
      },
    } as QueryPlanV1;
    const rankedResults = [
      {
        ...makeRankedResult('2023 Domaines Ott Rose de Provence', 1),
        producer: 'Domaines Ott',
      },
      {
        ...makeRankedResult('2020 Oremus Tokaji Aszu', 2),
        producer: 'Oremus',
      },
    ] as RankedResult[];
    const results = rankedResults.map((ranked) => makeResultItem(ranked, 'hybrid'));

    const params = buildEntropyAbstainResponseParams({
      plan,
      compiled: makeCompiled(),
      snapshot: makeSnapshot(),
      requestId: 'req-opus-filter-empty',
      startTime: Date.now(),
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'entity_resolution',
      abstainDecision: {
        shouldAbstain: true,
        reason: 'low_confidence',
        detail: 'ambiguous short-form entity requires clarification',
        recoverableBy: 'clarify',
        entropy: 0.99,
      },
      entropy: 0.99,
      results,
      rankedResults,
    });

    expect(params.results).toEqual([]);
    expect(params.clarification.candidates).toEqual([]);
    expect(params.clarification.structuredPayload).toEqual({
      kind: 'preference_gap',
      question: '결과가 모호합니다. 조건을 더 구체적으로 알려주세요.',
    });
  });

  it('prefers compiler-authored clarify payload over ambiguity-hint-derived clarification', () => {
    const plan = {
      ...makePlan(),
      rawQuery: '피노 추천',
      normalizedQuery: '피노 추천',
      queryClass: 'ambiguous_short_form',
      expansions: {
        lexical: [],
        semantic: [],
        ambiguousEntityHints: [{
          surface: '피노',
          entityType: 'grape_primary',
          retrievalConstraint: {
            attribute: 'grape_family',
            operator: '=',
            value: 'Pinot',
          },
          lexicalExpansions: ['pinot'],
          semanticExpansions: ['pinot noir', 'pinot gris', 'pinot blanc'],
          clarifyOptions: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
          explorationBranches: [
            {
              label: 'Pinot Noir',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Noir',
              },
              matchValues: ['Pinot Noir'],
              lexicalExpansions: ['pinot noir'],
              semanticExpansions: ['pinot noir'],
            },
            {
              label: 'Pinot Gris',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Gris',
              },
              matchValues: ['Pinot Gris', 'Pinot Grigio'],
              lexicalExpansions: ['pinot gris', 'pinot grigio'],
              semanticExpansions: ['pinot gris', 'pinot grigio'],
            },
          ],
        }],
      },
    } as QueryPlanV1;
    const compiled = makeCompiled();
    const rankedResults = [
      makeRankedResult('Generic Top Label A', 1),
      makeRankedResult('Generic Top Label B', 2),
    ];
    const compilerPayload = {
      kind: 'anchor_disambiguation' as const,
      question: 'compiler-authored prompt wins',
      options: ['Pinot Noir'],
    };
    const abstainDecision: TypedAbstainDecision = {
      shouldAbstain: true,
      reason: 'low_confidence',
      detail: 'compiler-authored clarification should take precedence',
      recoverableBy: 'clarify',
      entropy: 0.97,
      clarifyPayload: compilerPayload,
    };

    const params = buildEntropyAbstainResponseParams({
      plan,
      compiled,
      snapshot: makeSnapshot(),
      requestId: 'req-compiler-priority',
      startTime: Date.now(),
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'attribute_search',
      abstainDecision,
      entropy: 0.97,
      results: [],
      rankedResults,
    });

    expect(params.clarification.structuredPayload).toEqual(compilerPayload);
  });
});
