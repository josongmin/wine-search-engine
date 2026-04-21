import { describe, it, expect, vi } from 'vitest';
import {
  runRankedRouteDecisionPhase,
  runSearchPostRoutePhase,
} from '../../../../src/application/search/search-usecase-post-route-phase.js';
import { DomainError } from '../../../../src/domain/shared/error/domain-error.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { SearchRequest } from '../../../../src/application/search/search-request.dto.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import type { RankingMetadata } from '../../../../src/domain/ranking/port/ranker.port.js';
import { AbstainPolicy } from '../../../../src/domain/query/service/abstain-policy.js';
import { buildDeterminismFingerprint } from '../../../../src/domain/shared/utils/determinism-fingerprint.js';

const GENERIC_HYBRID_EXECUTION_FACTS = {
  effectiveRetrievalMode: 'attribute_search',
  retrievalKind: 'generic_hybrid',
  sparseExecuted: true,
  specializedRouteExecuted: null,
  usedCompiledExecution: false,
} as const;

// Kept as reference scaffolding for future test cases that exercise the
// entity-route / specialized-hybrid branches; prefixed with `_` so the lint
// rule allows the declaration without an import site.
const _ENTITY_ROUTE_EXECUTION_FACTS = {
  effectiveRetrievalMode: 'entity_lookup',
  retrievalKind: 'entity_lookup',
  sparseExecuted: false,
  specializedRouteExecuted: null,
  usedCompiledExecution: false,
} as const;

const _SPECIALIZED_HYBRID_EXECUTION_FACTS = {
  effectiveRetrievalMode: 'region_browse',
  retrievalKind: 'specialized_hybrid',
  sparseExecuted: false,
  specializedRouteExecuted: 'region_browse',
  usedCompiledExecution: false,
} as const;

function minimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'unknown',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

function makeTestCompiled(overrides?: Partial<CompiledWineQuery>): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'q', normalizedQuery: 'q', intent: 'semantic_discovery',
      queryClass: 'unknown', anchors: [], constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] }, uncertainty: {} as never,
      plannerVersion: '1', policyRuleVersion: '1', thresholdProfileId: 'default',
      retrievalPlan: { hardFilterTokens: [], softBoosts: [], inferredBoosts: [], sensoryPriors: [], planVersion: 'retrieval-plan-v1.0' },
    },
    execution: {
      effectiveRoute: 'hybrid', effectiveRetrievalMode: 'attribute_search', routeSource: 'planner',
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: { requireIdentitySeal: false, requireConstraintEvidence: false, requireAnchorEvidence: false },
    },
    ...overrides,
  } as CompiledWineQuery;
}

function makeRankedResult(overrides: Record<string, unknown> = {}) {
  return {
    entityId: createEntityId('entity-ranked'),
    canonicalLabel: 'Ranked Wine',
    finalScore: 0.91,
    rank: 1,
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.82,
      hardConstraintPass: true,
      softConstraint: 0.2,
      attributeAlignment: 0.1,
      preferenceAlignment: 0.1,
      popularity: 0.4,
      availability: 1,
      uncertaintyPenalty: 0,
    },
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    evidenceItems: [{
      type: 'semantic_relevance',
      source: 'ranker',
      contribution: '+0.82',
      strength: 'high' as const,
      provenance: 'semantic match',
    }],
    ...overrides,
  };
}

function makeDecisionSnapshot(feature_flags: Record<string, unknown> = {}) {
  return {
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1',
    threshold_profile_id: 'default',
    planner_version: '1',
    feature_flags,
  };
}

function makeResolveResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'resolved' as const,
    topEntity: {
      entityId: createEntityId('entity-ranked'),
      canonicalLabel: 'Ranked Wine',
      calibratedScore: 0.94,
    },
    candidates: [{
      entityId: createEntityId('entity-ranked'),
      canonicalLabel: 'Ranked Wine',
      calibratedScore: 0.94,
      rank: 1,
      evidenceRefs: ['alias:ranked'],
    }],
    decisionTrace: {
      queryClass: 'unknown' as const,
      top1CalibratedScore: 0.94,
      top2CalibratedScore: 0.52,
      calibratedGap: 0.42,
      decisionConfidenceC: 0.94,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: [],
    },
    conformalSetSize: 1,
    ...overrides,
  };
}

function makeDecisionOutput(overrides: Record<string, unknown> = {}) {
  return {
    decisionStatus: 'resolved' as const,
    nextAction: 'return_result' as const,
    decisionConfidence: 0.9,
    confidenceSemantics: 'calibrated_decision_confidence' as const,
    signalSet: {
      entity_integrity_score: 1,
      hard_constraint_pass: 1,
      soft_constraint_score: 1,
      semantic_relevance_score: 1,
      preference_alignment_score: 1,
      popularity_score: 1,
      availability_score: 1,
      uncertainty_penalty: 0,
    },
    evidenceItems: [],
    decisionTraceRef: 'trace',
    decisionSnapshot: makeDecisionSnapshot(),
    decisionTrace: {
      decisionStatus: 'resolved' as const,
      nextAction: 'return_result' as const,
      inputs: {
        queryClass: 'unknown',
        policy: minimalPlan().policy,
      },
      signals: {
        decisionConfidence: 0.9,
        calibratedGap: 0.8,
        ambiguity: false,
      },
      thresholds: {
        resolveThreshold: 0.7,
        gapThreshold: 0.2,
      },
      versions: {
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
      },
      rulesApplied: [],
      finalReason: 'ok',
    },
    ...overrides,
  };
}

function makeResponseBuilder(returnValue: unknown = { queryType: 'search' as const, meta: {} }) {
  return { build: vi.fn(() => returnValue) };
}

function makeDecisionEngine(output = makeDecisionOutput()) {
  return { decide: vi.fn().mockResolvedValue(output) };
}

function makeAbstainPolicy(abstain = false, entropy = 0.1) {
  const typedDecision = abstain
    ? { shouldAbstain: true as const, reason: 'low_confidence' as const, detail: `entropy=${entropy}`, recoverableBy: 'clarify' as const, entropy }
    : false;
  return {
    shouldAbstain: vi.fn(() => ({ abstain, entropy })),
    evaluate: vi.fn(() => typedDecision),
  };
}

async function runRankedPhaseForContract(
  responseBuilder: { build: ReturnType<typeof vi.fn> },
  options: {
    snapshotVersions?: {
      modelVersions: Record<string, unknown>;
      indexVersions: Record<string, unknown>;
      featureFlags: Record<string, unknown>;
    };
    routeDegradation?: {
      executionMode: 'degraded';
      degradationReasons: string[];
    };
  } = {},
) {
  await runRankedRouteDecisionPhase({
    plan: minimalPlan(),
    compiled: makeTestCompiled(),
    requestId: 'req-contract',
    startTime: Date.now() - 10,
    resolveResult: makeResolveResult({
      topEntity: undefined,
      candidates: [],
      decisionTrace: {
        queryClass: 'unknown',
        top1CalibratedScore: 0.9,
        top2CalibratedScore: 0.1,
        calibratedGap: 0.8,
        decisionConfidenceC: 0.9,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0.7, gapThreshold: 0.2 },
        outcomeReasonCodes: [],
      },
    }),
    rankedResults: [],
    fullRankedResults: [],
    effectiveRoute: 'hybrid',
    snapshotVersions: options.snapshotVersions,
    decisionEngine: makeDecisionEngine(
      makeDecisionOutput({
        decisionSnapshot: makeDecisionSnapshot(options.snapshotVersions?.featureFlags ?? {}),
      }),
    ) as never,
    responseBuilder: responseBuilder as never,
    routeDegradation: options.routeDegradation,
    ...GENERIC_HYBRID_EXECUTION_FACTS,
  });
}

describe('runSearchPostRoutePhase', () => {
  it('returns entropy abstain response when policy abstains', async () => {
    const built = { queryType: 'search' as const, meta: {} } as import('../../../../src/domain/response/model/search-response.js').SearchResponseV1;
    const responseBuilder = makeResponseBuilder(built);
    const decisionEngine = makeDecisionEngine();
    const abstainPolicy = makeAbstainPolicy(true, 0.95);
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const eid = createEntityId();
    const rankedResults = [
      makeRankedResult({
        entityId: eid,
        canonicalLabel: 'W',
        finalScore: 0.5,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.5,
          hardConstraintPass: true,
          softConstraint: 0,
          attributeAlignment: 0,
          preferenceAlignment: 0,
          popularity: 0,
          availability: 1,
          uncertaintyPenalty: 0,
        },
        evidenceItems: [{
          type: 'semantic_relevance',
          source: 'ranker',
          contribution: '+0.50',
          strength: 'medium' as const,
          provenance: 'ranked evidence for abstain path',
        }],
      }),
    ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];

    const out = await runSearchPostRoutePhase({
      plan,
      compiled: makeTestCompiled(),
      request,
      requestId: 'r1',
      startTime: Date.now() - 10,
      resolveResult: {
        status: 'resolved',
        candidates: [],
        decisionTrace: {
          queryClass: 'unknown',
          top1CalibratedScore: 0.5,
          top2CalibratedScore: 0.5,
          calibratedGap: 0,
          decisionConfidenceC: 0.5,
          ambiguityDetected: true,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 2,
      },
      rankedResults,
      effectiveRoute: 'hybrid',
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'attribute_search',
      retrievalModeSource: 'planner',
      abstainPolicy: abstainPolicy as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
      snapshotVersions: undefined,
      drinkingWindow: undefined,
      decisionEngine,
      responseBuilder: responseBuilder as import('../../../../src/domain/response/service/response-builder.js').ResponseBuilder,
      cacheService: undefined,
    });

    expect(out).toBe(built);
    expect(responseBuilder.build).toHaveBeenCalledOnce();
    expect(responseBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionOutput: expect.objectContaining({
          evidenceItems: rankedResults[0]!.evidenceItems,
        }),
      }),
    );
    expect(decisionEngine.decide).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    'entropy-abstain path includes counterfactuals when queryFamily requires them even if includeCounterfactuals=%s',
    async (includeCounterfactuals) => {
      const built = { queryType: 'search' as const, meta: {} } as import('../../../../src/domain/response/model/search-response.js').SearchResponseV1;
      const responseBuilder = makeResponseBuilder(built);
      const decisionEngine = makeDecisionEngine();
      const abstainPolicy = makeAbstainPolicy(true, 0.95);
      const plan = minimalPlan();
      const request: SearchRequest = { query: 'x' };
      const rankedResults = [
        makeRankedResult({
          entityId: createEntityId('e-abstain-cf-top'),
          canonicalLabel: 'TopWine',
          finalScore: 0.6,
          componentScores: {
            entityIntegrity: 1,
            semantic: 0.5,
            hardConstraintPass: true,
            softConstraint: 0,
            attributeAlignment: 0,
            preferenceAlignment: 0,
            popularity: 0,
            availability: 1,
            uncertaintyPenalty: 0,
          },
          evidenceItems: [{
            type: 'semantic_relevance',
            source: 'ranker',
            contribution: '+0.50',
            strength: 'medium' as const,
            provenance: 'top',
          }],
        }),
        makeRankedResult({
          entityId: createEntityId('e-abstain-cf-tail'),
          canonicalLabel: 'TailWine',
          finalScore: 0.4,
          componentScores: {
            entityIntegrity: 1,
            semantic: 0.4,
            hardConstraintPass: true,
            softConstraint: 0,
            attributeAlignment: 0,
            preferenceAlignment: 0,
            popularity: 0,
            availability: 1,
            uncertaintyPenalty: 0,
          },
          evidenceItems: [{
            type: 'semantic_relevance',
            source: 'ranker',
            contribution: '+0.40',
            strength: 'medium' as const,
            provenance: 'tail',
          }],
        }),
      ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];

      await runSearchPostRoutePhase({
        plan,
        compiled: {
          query: {
            rawQuery: plan.rawQuery,
            normalizedQuery: plan.normalizedQuery,
            intent: plan.intent,
            queryClass: plan.queryClass,
            anchors: plan.anchors,
            constraints: plan.constraints,
            expansions: plan.expansions,
            uncertainty: plan.uncertainty,
            plannerVersion: plan.plannerVersion,
            policyRuleVersion: plan.policyRuleVersion,
            thresholdProfileId: plan.thresholdProfileId,
          },
          execution: {
            effectiveRoute: 'hybrid',
            effectiveRetrievalMode: 'recommendation',
            routeSource: 'planner',
            budget: { maxCandidates: 20, enablePrecisionRerank: true },
            provenancePolicy: {
              requireIdentitySeal: true,
              requireConstraintEvidence: false,
              requireAnchorEvidence: false,
            },
          },
        },
        request,
        requestId: `r-explain-abstain-${String(includeCounterfactuals)}`,
        startTime: Date.now() - 10,
        resolveResult: {
          status: 'resolved',
          topEntity: { entityId: createEntityId('e-abstain-cf-top'), confidence: 0.6 },
          candidates: [
            {
              entityId: createEntityId('e-abstain-cf-top'),
              canonicalLabel: 'TopWine',
              calibratedScore: 0.6,
              rank: 1,
              evidenceRefs: [],
            },
            {
              entityId: createEntityId('e-abstain-cf-tail'),
              canonicalLabel: 'TailWine',
              calibratedScore: 0.4,
              rank: 2,
              evidenceRefs: [],
            },
          ],
          decisionTrace: {
            queryClass: 'unknown',
            top1CalibratedScore: 0.6,
            top2CalibratedScore: 0.4,
            calibratedGap: 0.2,
            decisionConfidenceC: 0.5,
            ambiguityDetected: true,
            ambiguityTypes: [],
            appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
            outcomeReasonCodes: [],
          },
          conformalSetSize: 2,
        } as never,
        rankedResults,
        effectiveRoute: 'hybrid',
        effectiveRetrievalMode: 'recommendation',
        retrievalKind: 'generic_hybrid',
        sparseExecuted: true,
        specializedRouteExecuted: null,
        usedCompiledExecution: true,
        plannerSuggestedMode: 'recommendation',
        retrievalModeSource: 'planner',
        abstainPolicy: abstainPolicy as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
        snapshotVersions: undefined,
        drinkingWindow: undefined,
        decisionEngine,
        responseBuilder: responseBuilder as import('../../../../src/domain/response/service/response-builder.js').ResponseBuilder,
        cacheService: undefined,
        includeCounterfactuals,
      });

      expect(responseBuilder.build).toHaveBeenCalledOnce();
      const callArg = (responseBuilder.build as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { counterfactuals?: unknown[] };
      expect(callArg?.counterfactuals).toBeDefined();
      expect(Array.isArray(callArg?.counterfactuals)).toBe(true);
      expect((callArg?.counterfactuals ?? []).length).toBeGreaterThan(0);
    },
  );

  it.each([false, undefined, true])(
    'entropy-abstain path mirrors ranked-path counterfactual policy for non-required query families when includeCounterfactuals=%s',
    async (includeCounterfactuals) => {
      const built = { queryType: 'search' as const, meta: {} } as import('../../../../src/domain/response/model/search-response.js').SearchResponseV1;
      const responseBuilder = makeResponseBuilder(built);
      const decisionEngine = makeDecisionEngine();
      const abstainPolicy = makeAbstainPolicy(true, 0.95);
      const plan = minimalPlan();
      const request: SearchRequest = { query: 'x' };
      const rankedResults = [
        makeRankedResult({
          entityId: createEntityId('e-noexplain-top'),
          canonicalLabel: 'TopWine',
          finalScore: 0.6,
          componentScores: {
            entityIntegrity: 1,
            semantic: 0.5,
            hardConstraintPass: true,
            softConstraint: 0,
            attributeAlignment: 0,
            preferenceAlignment: 0,
            popularity: 0,
            availability: 1,
            uncertaintyPenalty: 0,
          },
          evidenceItems: [{
            type: 'semantic_relevance',
            source: 'ranker',
            contribution: '+0.50',
            strength: 'medium' as const,
            provenance: 'top',
          }],
        }),
        makeRankedResult({
          entityId: createEntityId('e-noexplain-tail'),
          canonicalLabel: 'TailWine',
          finalScore: 0.4,
          componentScores: {
            entityIntegrity: 1,
            semantic: 0.4,
            hardConstraintPass: true,
            softConstraint: 0,
            attributeAlignment: 0,
            preferenceAlignment: 0,
            popularity: 0,
            availability: 1,
            uncertaintyPenalty: 0,
          },
          evidenceItems: [{
            type: 'semantic_relevance',
            source: 'ranker',
            contribution: '+0.40',
            strength: 'medium' as const,
            provenance: 'tail',
          }],
        }),
      ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];

      await runSearchPostRoutePhase({
        plan,
        compiled: makeTestCompiled(),
        request,
        requestId: `r-no-explain-${String(includeCounterfactuals)}`,
        startTime: Date.now() - 10,
        resolveResult: {
          status: 'resolved',
          topEntity: { entityId: createEntityId('e-noexplain-top'), confidence: 0.6 },
          candidates: [
            {
              entityId: createEntityId('e-noexplain-top'),
              canonicalLabel: 'TopWine',
              calibratedScore: 0.6,
              rank: 1,
              evidenceRefs: [],
            },
            {
              entityId: createEntityId('e-noexplain-tail'),
              canonicalLabel: 'TailWine',
              calibratedScore: 0.4,
              rank: 2,
              evidenceRefs: [],
            },
          ],
          decisionTrace: {
            queryClass: 'unknown',
            top1CalibratedScore: 0.6,
            top2CalibratedScore: 0.4,
            calibratedGap: 0.2,
            decisionConfidenceC: 0.5,
            ambiguityDetected: true,
            ambiguityTypes: [],
            appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
            outcomeReasonCodes: [],
          },
          conformalSetSize: 2,
        } as never,
        rankedResults,
        effectiveRoute: 'hybrid',
        ...GENERIC_HYBRID_EXECUTION_FACTS,
        plannerSuggestedMode: 'attribute_search',
        retrievalModeSource: 'planner',
        abstainPolicy: abstainPolicy as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
        snapshotVersions: undefined,
        drinkingWindow: undefined,
        decisionEngine,
        responseBuilder: responseBuilder as import('../../../../src/domain/response/service/response-builder.js').ResponseBuilder,
        cacheService: undefined,
        includeCounterfactuals,
      });

      expect(responseBuilder.build).toHaveBeenCalledOnce();
      const callArg = (responseBuilder.build as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { counterfactuals?: unknown[] };
      if (includeCounterfactuals === false) {
        expect(callArg?.counterfactuals).toBeUndefined();
      } else {
        expect(callArg?.counterfactuals).toBeDefined();
        expect(Array.isArray(callArg?.counterfactuals)).toBe(true);
        expect((callArg?.counterfactuals ?? []).length).toBeGreaterThan(0);
      }
    },
  );

  it('passes richer identity evidence into the shared decision input for ranked routes', async () => {
    const eid = createEntityId('entity-top');
    const otherId = createEntityId('entity-other');
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const rankedResults = [
      makeRankedResult({
        entityId: otherId,
        canonicalLabel: 'Other',
        finalScore: 0.9,
        componentScores: {
          entityIntegrity: 1,
          semantic: 0.8,
          hardConstraintPass: true,
          softConstraint: 0,
          attributeAlignment: 0,
          preferenceAlignment: 0,
          popularity: 0,
          availability: 1,
          uncertaintyPenalty: 0,
        },
        evidenceItems: [{
          type: 'semantic_relevance',
          source: 'ranker',
          contribution: '+0.80',
          strength: 'high' as const,
          provenance: 'semantic match',
        }],
      }),
    ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];
    const decisionEngine = {
      decide: vi.fn().mockResolvedValue({
        decisionStatus: 'ambiguous' as const,
        nextAction: 'clarify' as const,
        decisionConfidence: 0.4,
        confidenceSemantics: 'calibrated_decision_confidence' as const,
        candidates: [],
        signalSet: {
          entity_integrity_score: 0,
          hard_constraint_pass: 0,
          soft_constraint_score: 0,
          semantic_relevance_score: 0,
          preference_alignment_score: 0,
          popularity_score: 0,
          availability_score: 0,
          uncertainty_penalty: 0,
        },
        evidenceItems: [],
        decisionTraceRef: 'trace-1',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1',
          threshold_profile_id: 'default',
          planner_version: '1',
          feature_flags: {},
        },
        decisionTrace: {
          decisionStatus: 'ambiguous' as const,
          nextAction: 'clarify' as const,
          inputs: {
            queryClass: 'unknown' as const,
            effectiveRoute: 'hybrid' as const,
            policy: {
              requireExact: false,
              allowApproximate: true,
              requireClarification: false, clarificationBias: 0,
              fallbackMode: 'hybrid' as const,
            },
          },
          signals: {
            decisionConfidence: 0.4,
            calibratedGap: 0.1,
            ambiguity: true,
          },
          thresholds: {
            resolveThreshold: 0.75,
            gapThreshold: 0.15,
          },
          versions: {
            plannerVersion: '1',
            policyRuleVersion: '1',
            thresholdProfileId: 'default',
          },
          rulesApplied: ['EVIDENCE_GATE_DOWNGRADE'],
          finalReason: 'test',
        },
      }),
    };
    const responseBuilder = makeResponseBuilder();

    await runSearchPostRoutePhase({
      plan,
      compiled: makeTestCompiled(),
      request,
      requestId: 'r2',
      startTime: Date.now() - 10,
      resolveResult: {
        status: 'resolved',
        topEntity: { entityId: eid, canonicalLabel: 'Top', calibratedScore: 0.92 },
        candidates: [{
          entityId: eid,
          canonicalLabel: 'Top',
          calibratedScore: 0.92,
          rank: 1,
          evidenceRefs: ['alias:top'],
        }],
        decisionTrace: {
          queryClass: 'unknown',
          top1CalibratedScore: 0.92,
          top2CalibratedScore: 0.6,
          calibratedGap: 0.32,
          decisionConfidenceC: 0.92,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      },
      rankedResults,
      effectiveRoute: 'hybrid',
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'attribute_search',
      retrievalModeSource: 'planner',
      abstainPolicy: makeAbstainPolicy() as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
      snapshotVersions: undefined,
      drinkingWindow: undefined,
      decisionEngine: decisionEngine as import('../../../../src/application/search/port/search-pipeline-deps.port.js').DecisionEnginePort,
      responseBuilder: responseBuilder as import('../../../../src/domain/response/service/response-builder.js').ResponseBuilder,
      cacheService: undefined,
    });

    const decisionInput = decisionEngine.decide.mock.calls[0]?.[0];
    const responseParams = responseBuilder.build.mock.calls[0]?.[0];
    expect(decisionInput?.evidenceSummary?.identityEvidencePresent).toBe(false);
    expect(decisionInput?.evidenceSummary?.identityEvidence?.rankedTopResultMatchesTopEntity).toBe(
      false,
    );
    expect(responseParams?.retrievalModeSource).toBe('planner');
    expect(responseParams?.plannerSuggestedMode).toBe('attribute_search');
  });

  it('forwards compiled retrieval mode into decision input and response building', async () => {
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const rankedResults = [makeRankedResult()] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];
    const decisionEngine = { decide: vi.fn().mockResolvedValue(makeDecisionOutput()) };
    const responseBuilder = makeResponseBuilder();

    await runSearchPostRoutePhase({
      plan,
      compiled: {
        query: {
          rawQuery: plan.rawQuery,
          normalizedQuery: plan.normalizedQuery,
          intent: plan.intent,
          queryClass: plan.queryClass,
          anchors: plan.anchors,
          constraints: plan.constraints,
          expansions: plan.expansions,
          uncertainty: plan.uncertainty,
          plannerVersion: plan.plannerVersion,
          policyRuleVersion: plan.policyRuleVersion,
          thresholdProfileId: plan.thresholdProfileId,
        },
        execution: {
          effectiveRoute: 'hybrid',
          effectiveRetrievalMode: 'recommendation',
          routeSource: 'planner',
          budget: { maxCandidates: 20, enablePrecisionRerank: true },
          provenancePolicy: {
            requireIdentitySeal: true,
            requireConstraintEvidence: false,
            requireAnchorEvidence: false,
          },
        },
      },
      request,
      requestId: 'r-compiled',
      startTime: Date.now() - 10,
      resolveResult: makeResolveResult(),
      rankedResults,
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'recommendation',
      retrievalKind: 'generic_hybrid',
      sparseExecuted: true,
      specializedRouteExecuted: null,
      usedCompiledExecution: true,
      plannerSuggestedMode: 'recommendation',
      retrievalModeSource: 'planner',
      abstainPolicy: makeAbstainPolicy() as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
      snapshotVersions: undefined,
      drinkingWindow: undefined,
      decisionEngine: decisionEngine as import('../../../../src/application/search/port/search-pipeline-deps.port.js').DecisionEnginePort,
      responseBuilder: responseBuilder as import('../../../../src/domain/response/service/response-builder.js').ResponseBuilder,
      cacheService: undefined,
    });

    const decisionInput = decisionEngine.decide.mock.calls[0]?.[0];
    const responseParams = responseBuilder.build.mock.calls[0]?.[0];

    expect(decisionInput?.effectiveRetrievalMode).toBe('recommendation');
    expect(responseParams?.compiled?.execution.effectiveRetrievalMode).toBe('recommendation');
  });

  it('keeps the shared ranked-route decision phase aligned with the main post-route response shape', async () => {
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const rankedResults = [makeRankedResult()] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];
    const resolveResult = makeResolveResult();
    const decisionOutput = {
      ...makeDecisionOutput({
        nextAction: 'respond',
        decisionConfidence: 0.94,
        decisionTraceRef: 'trace-1',
      }),
      route: 'hybrid' as const,
    };
    const responseBuilder = { build: vi.fn((params: Record<string, unknown>) => params) };
    const decisionEngine = { decide: vi.fn().mockResolvedValue(decisionOutput) };
    const abstainPolicy = makeAbstainPolicy();
    const startTime = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_010);

    const rankedRouteResponse = await runRankedRouteDecisionPhase({
      plan,
      compiled: makeTestCompiled(),
      requestId: 'req-ranked',
      startTime,
      resolveResult,
      rankedResults,
      fullRankedResults: rankedResults,
      effectiveRoute: 'hybrid',
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
      drinkingWindow: undefined,
      includeCounterfactuals: false,
      plannerSuggestedMode: 'attribute_search',
      retrievalModeSource: 'planner',
      ...GENERIC_HYBRID_EXECUTION_FACTS,
    });

    const mainRouteResponse = await runSearchPostRoutePhase({
      plan,
      compiled: makeTestCompiled(),
      request,
      requestId: 'req-ranked',
      startTime,
      resolveResult,
      rankedResults,
      effectiveRoute: 'hybrid',
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'attribute_search',
      retrievalModeSource: 'planner',
      abstainPolicy: abstainPolicy as never,
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
      drinkingWindow: undefined,
      cacheService: undefined,
    });

    nowSpy.mockRestore();

    const {
      retrievalModeSource: _rankedRetrievalModeSource,
      plannerSuggestedMode: _rankedPlannerSuggestedMode,
      ...sharedRankedRouteResponse
    } = rankedRouteResponse as Record<string, unknown>;

    const {
      retrievalModeSource: _retrievalModeSource,
      plannerSuggestedMode: _plannerSuggestedMode,
      counterfactuals: _counterfactuals,
      ...sharedMainRouteResponse
    } = mainRouteResponse as Record<string, unknown>;

    expect(sharedRankedRouteResponse).toEqual(sharedMainRouteResponse);
    expect(responseBuilder.build).toHaveBeenCalledTimes(2);
    expect(decisionEngine.decide).toHaveBeenCalledTimes(2);
  });

  it('keeps determinism fingerprint stable when only query text changes', async () => {
    const responseBuilder = { build: vi.fn((params: Record<string, unknown>) => params) };
    const decisionEngine = makeDecisionEngine();
    const snapshotVersions = {
      modelVersions: { query_understanding: 'model-a' },
      indexVersions: { retrieval: 'index-a' },
      featureFlags: {},
    };

    await runRankedRouteDecisionPhase({
      plan: { ...minimalPlan(), rawQuery: '오퍼스원', normalizedQuery: 'opus one' },
      compiled: makeTestCompiled(),
      requestId: 'req-fingerprint-a',
      startTime: Date.now() - 10,
      resolveResult: makeResolveResult(),
      rankedResults: [] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      fullRankedResults: [] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      effectiveRoute: 'hybrid',
      snapshotVersions,
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
    });

    await runRankedRouteDecisionPhase({
      plan: { ...minimalPlan(), rawQuery: '샤또 마고', normalizedQuery: 'chateau margaux' },
      compiled: makeTestCompiled(),
      requestId: 'req-fingerprint-b',
      startTime: Date.now() - 10,
      resolveResult: makeResolveResult(),
      rankedResults: [] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      fullRankedResults: [] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      effectiveRoute: 'hybrid',
      snapshotVersions,
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
    });

    const firstParams = responseBuilder.build.mock.calls[0]?.[0] as {
      determinismFingerprintParams?: Parameters<typeof buildDeterminismFingerprint>[0];
    };
    const secondParams = responseBuilder.build.mock.calls[1]?.[0] as {
      determinismFingerprintParams?: Parameters<typeof buildDeterminismFingerprint>[0];
    };

    expect(firstParams.determinismFingerprintParams).toBeDefined();
    expect(secondParams.determinismFingerprintParams).toBeDefined();
    expect(buildDeterminismFingerprint(firstParams.determinismFingerprintParams!)).toBe(
      buildDeterminismFingerprint(secondParams.determinismFingerprintParams!),
    );
  });

  it('wires scoreDriftRecord into auditExtension ranking traces', async () => {
    const responseBuilder = { build: vi.fn((params: Record<string, unknown>) => params) };
    const scoreDriftRecord = {
      queryClass: 'semantic_preference',
      heuristicTop3EntityIds: ['wine:1', 'wine:2', 'wine:3'],
      ltrTop3EntityIds: ['wine:2', 'wine:1', 'wine:3'],
      rankOrderChanges: 0.33,
      averageRerankDeltaNormalized: 0.12,
      safetyEnvelopeBlocks: 1,
    };
    const rankingMetadata: RankingMetadata = {
      coarsePruneSummary: undefined,
      rerankExecuted: true,
      rerankGateReason: 'semantic_preference',
      runtimeSignal: undefined,
      preRerankTop5: ['wine:1', 'wine:2', 'wine:3'],
      // E1-T4: scoreDriftRecord now lives in rerankDecision (typed contract)
      rerankDecision: {
        applied: true,
        decision: 'applied',
        reason: 'semantic_preference',
        scoreDriftRecord,
      },
    };

    await runRankedRouteDecisionPhase({
      plan: minimalPlan(),
      compiled: makeTestCompiled(),
      requestId: 'req-audit',
      startTime: Date.now() - 10,
      resolveResult: makeResolveResult(),
      rankedResults: [
        makeRankedResult({ entityId: createEntityId('wine:2') }),
        makeRankedResult({ entityId: createEntityId('wine:1'), rank: 2, finalScore: 0.82 }),
        makeRankedResult({ entityId: createEntityId('wine:3'), rank: 3, finalScore: 0.7 }),
      ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      fullRankedResults: [
        makeRankedResult({ entityId: createEntityId('wine:2') }),
        makeRankedResult({ entityId: createEntityId('wine:1'), rank: 2, finalScore: 0.82 }),
        makeRankedResult({ entityId: createEntityId('wine:3'), rank: 3, finalScore: 0.7 }),
      ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      effectiveRoute: 'hybrid',
      rankingMetadata,
      decisionEngine: makeDecisionEngine() as never,
      responseBuilder: responseBuilder as never,
    });

    const buildParams = responseBuilder.build.mock.calls[0]?.[0] as { auditExtension?: Record<string, unknown> };
    const auditExtension = buildParams.auditExtension as {
      ranking_delta_trace?: { preRerankTop5: string[]; postRerankTop5: string[]; safetyEnvelopeBlocks: number };
      rerank_decision_trace?: { gateDecision: string; scoreContract: string };
    } | undefined;

    expect(auditExtension?.ranking_delta_trace?.preRerankTop5).toEqual(['wine:1', 'wine:2', 'wine:3']);
    expect(auditExtension?.ranking_delta_trace?.postRerankTop5).toEqual(['wine:2', 'wine:1', 'wine:3']);
    expect(auditExtension?.ranking_delta_trace?.safetyEnvelopeBlocks).toBe(1);
    expect(auditExtension?.rerank_decision_trace).toEqual({
      gateDecision: 'applied',
      scoreContract: 'bounded_normalized_0_1',
    });
  });

  it('emits execution trace in auditExtension from compiled execution facts', async () => {
    const responseBuilder = { build: vi.fn((params: Record<string, unknown>) => params) };

    await runRankedRouteDecisionPhase({
      plan: minimalPlan(),
      compiled: {
        execution: {
          effectiveRoute: 'hybrid',
          effectiveRetrievalMode: 'recommendation',
          routeSource: 'planner',
          budget: {
            maxCandidates: 24,
            rerankLimit: 12,
            enablePrecisionRerank: true,
          },
          provenancePolicy: {
            requireIdentitySeal: false,
            requireConstraintEvidence: true,
            requireAnchorEvidence: false,
          },
        },
        query: {
          retrievalPlan: {
            mode: 'recommendation',
            sensoryPriors: [],
          },
        },
      } as never,
      requestId: 'req-execution-trace',
      startTime: Date.now() - 10,
      resolveResult: makeResolveResult(),
      rankedResults: [
        makeRankedResult({ entityId: createEntityId('wine:2') }),
      ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      fullRankedResults: [
        makeRankedResult({ entityId: createEntityId('wine:2') }),
      ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      effectiveRoute: 'hybrid',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'recommendation',
      effectiveRetrievalMode: 'recommendation',
      retrievalKind: 'generic_hybrid',
      sparseExecuted: true,
      specializedRouteExecuted: null,
      usedCompiledExecution: true,
      rankingMetadata: {
        coarsePruneSummary: undefined,
        rerankExecuted: false,
        rerankGateReason: undefined,
        runtimeSignal: undefined,
        preRerankTop5: [],
        provenanceClosure: {
          policy: {
            requireIdentitySeal: false,
            requireConstraintEvidence: true,
            requireAnchorEvidence: false,
          },
          preRank: {
            candidateCount: 12,
            identityEvidenceSatisfied: true,
            constraintEvidenceSatisfied: true,
            anchorEvidenceSatisfied: true,
            matchedConstraintAttributes: ['region'],
            unmetConstraintAttributes: [],
            anchorSignalTypes: [],
          },
          postRank: {
            candidateCount: 1,
            identityEvidenceSatisfied: false,
            constraintEvidenceSatisfied: true,
            anchorEvidenceSatisfied: true,
            matchedConstraintAttributes: ['region'],
            unmetConstraintAttributes: [],
            anchorSignalTypes: [],
          },
          missing: [],
          satisfied: true,
        },
      },
      decisionEngine: makeDecisionEngine() as never,
      responseBuilder: responseBuilder as never,
    });

    const buildParams = responseBuilder.build.mock.calls[0]?.[0] as { auditExtension?: Record<string, unknown> };
    const auditExtension = buildParams.auditExtension as {
      execution_trace?: {
        effective_route?: string;
        retrieval_mode_source?: string;
        effective_retrieval_mode?: string;
        retrieval_kind?: string;
        sparse_executed?: boolean;
        used_compiled_execution?: boolean;
        compiled_budget?: {
          max_candidates?: number;
          enable_precision_rerank?: boolean;
        };
        provenance_policy?: {
          require_identity_seal?: boolean;
          require_constraint_evidence?: boolean;
          require_anchor_evidence?: boolean;
        };
        provenance_closure?: {
          satisfied?: boolean;
          post_rank?: {
            candidate_count?: number;
          };
        };
      };
    } | undefined;

    expect(auditExtension?.execution_trace).toEqual({
      effective_route: 'hybrid',
      retrieval_mode_source: 'planner',
      effective_retrieval_mode: 'recommendation',
      retrieval_kind: 'generic_hybrid',
      sparse_executed: true,
      specialized_route_executed: null,
      used_compiled_execution: true,
      compiled_budget: {
        max_candidates: 24,
        rerank_limit: 12,
        enable_precision_rerank: true,
      },
      provenance_policy: {
        require_identity_seal: false,
        require_constraint_evidence: true,
        require_anchor_evidence: false,
      },
      provenance_closure: {
        policy: {
          requireIdentitySeal: false,
          requireConstraintEvidence: true,
          requireAnchorEvidence: false,
        },
        preRank: {
          candidateCount: 12,
          identityEvidenceSatisfied: true,
          constraintEvidenceSatisfied: true,
          anchorEvidenceSatisfied: true,
          matchedConstraintAttributes: ['region'],
          unmetConstraintAttributes: [],
          anchorSignalTypes: [],
        },
        postRank: {
          candidateCount: 1,
          identityEvidenceSatisfied: false,
          constraintEvidenceSatisfied: true,
          anchorEvidenceSatisfied: true,
          matchedConstraintAttributes: ['region'],
          unmetConstraintAttributes: [],
          anchorSignalTypes: [],
        },
        missing: [],
        satisfied: true,
      },
    });
  });

  it('derives rerank_decision_trace gateDecision from the shared typed rerank decision', async () => {
    const responseBuilder = { build: vi.fn((params: Record<string, unknown>) => params) };
    const rankingMetadata: RankingMetadata = {
      coarsePruneSummary: undefined,
      rerankExecuted: false,
      rerankGateReason: 'forced',
      runtimeSignal: undefined,
      preRerankTop5: [],
      rerankDecision: {
        applied: false,
        decision: 'no_model_for_query_class',
      },
    };

    await runRankedRouteDecisionPhase({
      plan: minimalPlan(),
      compiled: makeTestCompiled({
        execution: {
          effectiveRoute: 'hybrid',
          effectiveRetrievalMode: 'semantic_hybrid',
          routeSource: 'planner',
          budget: { maxCandidates: 20, enablePrecisionRerank: true },
          provenancePolicy: { requireIdentitySeal: false, requireConstraintEvidence: false, requireAnchorEvidence: false },
        },
        plannerTrace: [
          {
            stage: 'route_resolution',
            inputFacts: { explain: true },
            rulesEvaluated: [],
            rejectedBranches: [],
            decision: 'emit_trace',
            confidence: 1,
          },
        ],
      } as Partial<CompiledWineQuery>),
      requestId: 'req-rerank-trace',
      startTime: Date.now() - 10,
      resolveResult: makeResolveResult(),
      rankedResults: [] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      fullRankedResults: [] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      effectiveRoute: 'hybrid',
      rankingMetadata,
      decisionEngine: makeDecisionEngine() as never,
      responseBuilder: responseBuilder as never,
    });

    const buildParams = responseBuilder.build.mock.calls[0]?.[0] as { auditExtension?: Record<string, unknown> };
    const auditExtension = buildParams.auditExtension as {
      rerank_decision_trace?: { gateDecision: string; scoreContract?: string };
    } | undefined;

    expect(auditExtension?.rerank_decision_trace).toEqual({
      gateDecision: 'no_model_for_query_class',
    });
  });

  it('treats no_model_for_query_class as ltr unavailable for the entropy gate', async () => {
    const responseBuilder = makeResponseBuilder({ queryType: 'search' as const, meta: {} });
    const abstainPolicy = makeAbstainPolicy(false);

    await runSearchPostRoutePhase({
      plan: minimalPlan(),
      compiled: makeTestCompiled(),
      request: { query: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로' },
      requestId: 'req-no-ltr-entropy',
      startTime: Date.now() - 10,
      resolveResult: makeResolveResult(),
      rankedResults: [makeRankedResult()] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      effectiveRoute: 'hybrid',
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'attribute_search',
      retrievalModeSource: 'planner',
      abstainPolicy: abstainPolicy as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
      snapshotVersions: undefined,
      drinkingWindow: undefined,
      decisionEngine: makeDecisionEngine() as never,
      responseBuilder: responseBuilder as never,
      cacheService: undefined,
      rankingMetadata: {
        coarsePruneSummary: undefined,
        rerankExecuted: false,
        rerankGateReason: undefined,
        runtimeSignal: undefined,
        preRerankTop5: [],
        rerankDecision: {
          applied: false,
          decision: 'no_model_for_query_class',
        },
      },
    });

    expect(abstainPolicy.evaluate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.any(Object),
      { ltrAvailable: false },
      expect.any(Array),
    );
  });

  it('wires constraint_resolution_trace when explain/planner trace is enabled', async () => {
    const responseBuilder = { build: vi.fn((params: Record<string, unknown>) => params) };

    await runRankedRouteDecisionPhase({
      plan: {
        ...minimalPlan(),
        constraints: {
          hard: [
            {
              attribute: 'region',
              operator: '=',
              value: 'Bordeaux',
              confidence: 1,
              sourceText: '보르도',
              source_tier: 'hard',
              authority_level: 100,
            },
            {
              attribute: 'region',
              operator: '=',
              value: 'Burgundy',
              confidence: 1,
              sourceText: '부르고뉴',
              source_tier: 'hard',
              authority_level: 50,
            },
          ],
          soft: [],
          inferred: [],
        },
      },
      compiled: makeTestCompiled({
        execution: {
          effectiveRoute: 'hybrid',
          effectiveRetrievalMode: 'semantic_hybrid',
          routeSource: 'planner',
          budget: { maxCandidates: 20, enablePrecisionRerank: true },
          provenancePolicy: { requireIdentitySeal: false, requireConstraintEvidence: false, requireAnchorEvidence: false },
        },
        plannerTrace: [
          {
            stage: 'constraint_resolution',
            inputFacts: { rawConstraintCount: 2 },
            rulesEvaluated: [],
            rejectedBranches: [],
            decision: 'emit_trace',
            confidence: 1,
          },
        ],
      } as Partial<CompiledWineQuery>),
      requestId: 'req-constraint-trace',
      startTime: Date.now() - 10,
      resolveResult: makeResolveResult(),
      rankedResults: [] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      fullRankedResults: [] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      effectiveRoute: 'hybrid',
      decisionEngine: makeDecisionEngine() as never,
      responseBuilder: responseBuilder as never,
    });

    const buildParams = responseBuilder.build.mock.calls[0]?.[0] as { auditExtension?: Record<string, unknown> };
    const auditExtension = buildParams.auditExtension as {
      constraint_resolution_trace?: {
        atoms: Array<{ attribute: string }>;
        relations: Array<{ type: string }>;
        policy_outcomes: Array<{ outcome: string }>;
      };
    } | undefined;

    expect(auditExtension?.constraint_resolution_trace?.atoms).toHaveLength(2);
    expect(auditExtension?.constraint_resolution_trace?.relations[0]?.type).toBe('contradiction');
    expect(auditExtension?.constraint_resolution_trace?.policy_outcomes.map((outcome) => outcome.outcome)).toContain('dropped');
    expect(auditExtension?.constraint_resolution_trace?.policy_outcomes.map((outcome) => outcome.outcome)).toContain('kept');
  });

  it('wires structured clarify payload and runtime degradation into the entropy-abstain path', async () => {
    const responseBuilder = { build: vi.fn((params: Record<string, unknown>) => params) };
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const rankedResults = [
      makeRankedResult({
        entityId: createEntityId('wine:structured-clarify'),
        canonicalLabel: 'Structured Clarify Wine',
        finalScore: 0.51,
      }),
    ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];
    const decisionEngine = makeDecisionEngine();

    await runSearchPostRoutePhase({
      plan,
      compiled: makeTestCompiled(),
      request,
      requestId: 'req-clarify',
      startTime: Date.now() - 10,
      resolveResult: {
        ...makeResolveResult({
          candidates: rankedResults.map((result) => ({
            entityId: result.entityId,
            canonicalLabel: result.canonicalLabel,
            calibratedScore: 0.51,
            rank: 1,
            evidenceRefs: ['alias:structured'],
          })),
          degradation: { reasons: ['entity_resolver_unavailable'] },
        }),
        status: 'failed',
      },
      rankedResults,
      effectiveRoute: 'hybrid',
      routeDegradation: {
        executionMode: 'degraded',
        degradationReasons: ['dense_retrieval_disabled'],
      },
      ...GENERIC_HYBRID_EXECUTION_FACTS,
      plannerSuggestedMode: 'attribute_search',
      retrievalModeSource: 'planner',
      abstainPolicy: new AbstainPolicy(0.95, 3),
      snapshotVersions: {
        modelVersions: {},
        indexVersions: {},
        featureFlags: {},
      },
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
      drinkingWindow: undefined,
      cacheService: undefined,
    });

    const buildParams = responseBuilder.build.mock.calls[0]?.[0] as {
      clarification?: {
        structuredPayload?: {
          kind: string;
          question: string;
          options?: string[];
        };
      };
      decisionOutput?: { nextAction?: string };
    };

    expect(buildParams.decisionOutput?.nextAction).toBe('clarify');
    expect(buildParams.clarification?.structuredPayload?.kind).toBe('preference_gap');
    expect(buildParams.clarification?.structuredPayload?.question).toContain('검색 신호가 부족합니다');
    expect(buildParams.clarification?.structuredPayload?.options).toEqual([
      'Structured Clarify Wine',
    ]);
  });

  it.each([
    [
      'passes route degradation into the response contract for ranked routes',
      {
        routeDegradation: {
          executionMode: 'degraded' as const,
          degradationReasons: ['reranker_timeout'],
        },
      },
      {
        executionMode: 'degraded',
        degradationReasons: ['reranker_timeout'],
      },
    ],
    [
      'marks learning kill switch as degraded in the surfaced response contract',
      {
        snapshotVersions: {
          modelVersions: {},
          indexVersions: {},
          featureFlags: { killSwitchLearning: true },
        },
      },
      {
        executionMode: 'degraded',
        degradationReasons: ['learning_kill_switch'],
      },
    ],
  ] as const)('%s', async (_label, options, expectedContract) => {
    const responseBuilder = makeResponseBuilder();
    await runRankedPhaseForContract(responseBuilder, options);
    expect(responseBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: expectedContract,
      }),
    );
  });

  it('throws DomainError(INTERNAL_INCONSISTENCY) when ranked-route response building throws unexpectedly', async () => {
    // Previously this test expected a fabricated degraded-200 response. After the
    // fix in search-usecase-post-route-phase.ts, unexpected builder errors are
    // propagated as DomainError('INTERNAL_INCONSISTENCY') so the HTTP error handler
    // can return a proper 500 instead of silently swallowing the failure.
    const plan = minimalPlan();
    const request: SearchRequest = { query: 'x' };
    const rankedResults = [makeRankedResult()] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];
    const decisionEngine = { decide: vi.fn().mockResolvedValue(makeDecisionOutput()) };
    const responseBuilder = {
      build: vi.fn(() => {
        throw new Error('builder exploded');
      }),
    };

    await expect(
      runSearchPostRoutePhase({
        plan,
        compiled: {
          query: {
            rawQuery: plan.rawQuery,
            normalizedQuery: plan.normalizedQuery,
            intent: plan.intent,
            queryClass: plan.queryClass,
            anchors: plan.anchors,
            constraints: plan.constraints,
            expansions: plan.expansions,
            uncertainty: plan.uncertainty,
            plannerVersion: plan.plannerVersion,
            policyRuleVersion: plan.policyRuleVersion,
            thresholdProfileId: plan.thresholdProfileId,
          },
          execution: {
            effectiveRoute: 'hybrid',
            effectiveRetrievalMode: 'recommendation',
            routeSource: 'planner',
            budget: { maxCandidates: 20, enablePrecisionRerank: true },
            provenancePolicy: {
              requireIdentitySeal: true,
              requireConstraintEvidence: false,
              requireAnchorEvidence: false,
            },
          },
        },
        request,
        requestId: 'req-post-route-builder-error',
        startTime: Date.now() - 10,
        resolveResult: makeResolveResult(),
        rankedResults,
        effectiveRoute: 'hybrid',
        effectiveRetrievalMode: 'recommendation',
        retrievalKind: 'generic_hybrid',
        sparseExecuted: true,
        specializedRouteExecuted: null,
        usedCompiledExecution: true,
        plannerSuggestedMode: 'recommendation',
        retrievalModeSource: 'planner',
        abstainPolicy: makeAbstainPolicy() as import('../../../../src/domain/query/service/abstain-policy.js').AbstainPolicy,
        snapshotVersions: undefined,
        drinkingWindow: undefined,
        decisionEngine: decisionEngine as import('../../../../src/application/search/port/search-pipeline-deps.port.js').DecisionEnginePort,
        responseBuilder: responseBuilder as import('../../../../src/domain/response/service/response-builder.js').ResponseBuilder,
        cacheService: undefined,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DomainError &&
        err.code === 'INTERNAL_INCONSISTENCY' &&
        err.message.includes('builder exploded')
      );
    });
  });

  it('carries top-ranked evidence into degraded failed decision output when the decision engine throws', async () => {
    const rankedResults = [
      makeRankedResult({
        evidenceItems: [{
          type: 'semantic_relevance',
          source: 'ranker',
          contribution: '+0.82',
          strength: 'high' as const,
          provenance: 'semantic match',
        }],
      }),
    ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[];
    const responseBuilder = makeResponseBuilder({
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'failed',
        nextAction: 'fail',
        route: 'hybrid',
        decisionConfidence: 0,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace',
        authorityTraceRef: 'trace',
        decisionSnapshot: makeDecisionSnapshot(),
        executionMode: 'degraded',
        blockingEligible: false,
      },
      results: [],
      clarification: null,
      meta: {
        requestId: 'req-decision-throw',
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
        decisionSnapshot: makeDecisionSnapshot(),
        authorityTraceRef: 'trace',
        executionMode: 'degraded',
        blockingEligible: false,
      },
    } as import('../../../../src/domain/response/model/search-response.js').SearchResponseV1);

    // Decision engine failures now propagate as throws (see comment in
    // search-usecase-post-route-phase.ts:187-191) — they are pipeline defects
    // that should surface as HTTP 500, not fabricated 200 with 'failed' status.
    await expect(
      runRankedRouteDecisionPhase({
        plan: minimalPlan(),
        compiled: makeTestCompiled(),
        requestId: 'req-decision-throw',
        startTime: Date.now() - 10,
        resolveResult: makeResolveResult(),
        rankedResults,
        fullRankedResults: rankedResults,
        effectiveRoute: 'hybrid',
        decisionEngine: {
          decide: vi.fn().mockRejectedValue(new Error('decision exploded')),
        } as never,
        responseBuilder: responseBuilder as never,
      }),
    ).rejects.toThrow('decision exploded');
  });

  it('comparison counterfactuals: symmetric API — explicit false suppresses', async () => {
    const responseBuilder = makeResponseBuilder();

    await runRankedRouteDecisionPhase({
      plan: {
        ...minimalPlan(),
        intent: 'comparison_search',
        retrievalMode: 'compare_candidates',
        queryClass: 'comparison_query',
      },
      compiled: makeTestCompiled({
        execution: {
          effectiveRoute: 'hybrid',
          effectiveRetrievalMode: 'compare_candidates',
          routeSource: 'planner',
          budget: { maxCandidates: 20, enablePrecisionRerank: true },
          provenancePolicy: { requireIdentitySeal: false, requireConstraintEvidence: false, requireAnchorEvidence: false },
        },
      } as Partial<CompiledWineQuery>),
      requestId: 'req-comparison-suppress',
      startTime: Date.now() - 10,
      resolveResult: makeResolveResult({
        candidates: [
          {
            entityId: createEntityId('entity-top'),
            canonicalLabel: 'Top',
            calibratedScore: 0.94,
            rank: 1,
            evidenceRefs: ['alias:top'],
          },
          {
            entityId: createEntityId('entity-alt'),
            canonicalLabel: 'Alt',
            calibratedScore: 0.73,
            rank: 2,
            evidenceRefs: ['alias:alt'],
          },
        ],
      }),
      rankedResults: [
        makeRankedResult({
          entityId: createEntityId('entity-top'),
          canonicalLabel: 'Top',
          rank: 1,
        }),
        makeRankedResult({
          entityId: createEntityId('entity-alt'),
          canonicalLabel: 'Alt',
          rank: 2,
          finalScore: 0.71,
        }),
      ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      fullRankedResults: [
        makeRankedResult({
          entityId: createEntityId('entity-top'),
          canonicalLabel: 'Top',
          rank: 1,
        }),
        makeRankedResult({
          entityId: createEntityId('entity-alt'),
          canonicalLabel: 'Alt',
          rank: 2,
          finalScore: 0.71,
        }),
      ] as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult[],
      effectiveRoute: 'hybrid',
      decisionEngine: makeDecisionEngine() as never,
      responseBuilder: responseBuilder as never,
      includeCounterfactuals: false,
    });

    expect(responseBuilder.build).toHaveBeenCalledWith(
      expect.not.objectContaining({
        counterfactuals: expect.anything(),
      }),
    );
  });
});
