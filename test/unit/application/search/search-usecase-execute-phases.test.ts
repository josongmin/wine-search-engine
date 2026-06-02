import { describe, it, expect, vi } from 'vitest';
import { formatConstraintConflictDescription } from '../../../../src/application/search/search-usecase-constraint-conflict.js';
import { mergeCachedSearchResponseMeta } from '../../../../src/application/search/search-usecase-cache-hit.js';
import {
  buildEmptySearchExecutionLaneArtifacts,
  buildSearchExecutionLaneTrace,
  dispatchSearchRouteExecution,
} from '../../../../src/application/search/search-usecase-route-dispatch.js';
import { SearchUseCase } from '../../../../src/application/search/search.usecase.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

describe('formatConstraintConflictDescription', () => {
  it('joins pairwise conflicts with semicolons', () => {
    const desc = formatConstraintConflictDescription([
      [
        { attribute: 'color', operator: 'eq', value: 'red' },
        { attribute: 'color', operator: 'eq', value: 'white' },
      ],
    ]);
    expect(desc).toContain('color');
    expect(desc).toContain('"red"');
    expect(desc).toContain('"white"');
  });
});

describe('mergeCachedSearchResponseMeta', () => {
  it('updates requestId and queryTimeMs', () => {
    const base = {
      queryType: 'search' as const,
      engineDecision: {} as import('../../../../src/domain/decision/model/decision-output.js').EngineDecisionOutput,
      results: [],
      meta: {
        requestId: 'old',
        queryTimeMs: 1,
      },
    };
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const merged = mergeCachedSearchResponseMeta(base, 'new-req', 9000);
    expect(merged.meta.requestId).toBe('new-req');
    expect(merged.meta.queryTimeMs).toBe(1000);
    vi.restoreAllMocks();
  });
});

describe('dispatchSearchRouteExecution', () => {
  const minimalResolve = (): EntityResolveResult => ({
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: 'unknown',
      top1CalibratedScore: 0,
      top2CalibratedScore: 0,
      calibratedGap: 0,
      decisionConfidenceC: 0,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: [],
    },
    conformalSetSize: 0,
  });

  it('entity route returns empty ranked results', async () => {
    const laneArtifacts = buildEmptySearchExecutionLaneArtifacts();
    const fusedResolveResult = minimalResolve();
    const entity = vi.fn(async () => ({
      executionTopology: 'entity_only' as const,
      identityResolveResult: fusedResolveResult,
      fusedResolveResult,
      laneArtifacts,
      laneTrace: buildSearchExecutionLaneTrace({
        executionTopology: 'entity_only',
        identityResolveResult: fusedResolveResult,
        fusedResolveResult,
        laneArtifacts,
      }),
      rankedResults: [],
      effectiveRetrievalMode: 'entity_lookup',
      retrievalKind: 'entity_lookup',
      sparseExecuted: false,
      specializedRouteExecuted: null,
      usedCompiledExecution: false,
    }));
    const out = await dispatchSearchRouteExecution('entity', {
      executeEntity: entity,
      executeHybrid: async () => {
        throw new Error('no hybrid');
      },
      executeMixed: async () => {
        throw new Error('no mixed');
      },
    });
    expect(entity).toHaveBeenCalledOnce();
    expect(out.rankedResults).toEqual([]);
    expect(out.effectiveRetrievalMode).toBe('entity_lookup');
    expect(out.retrievalKind).toBe('entity_lookup');
    expect(out.sparseExecuted).toBe(false);
    expect(out.specializedRouteExecuted).toBeNull();
    expect(out.usedCompiledExecution).toBe(false);
    expect(out.laneTrace.fused.participated).toBe(false);
    expect(out.laneTrace.fused.resolveStatus).toBeUndefined();
  });

  it('delegates hybrid and mixed', async () => {
    const eid = createEntityId();
    const hybridLaneArtifacts = buildEmptySearchExecutionLaneArtifacts();
    const hybridResolveResult = minimalResolve();
    const hybridOut = {
      executionTopology: 'general_only' as const,
      identityResolveResult: null,
      fusedResolveResult: hybridResolveResult,
      laneArtifacts: hybridLaneArtifacts,
      laneTrace: buildSearchExecutionLaneTrace({
        executionTopology: 'general_only',
        identityResolveResult: null,
        fusedResolveResult: hybridResolveResult,
        laneArtifacts: hybridLaneArtifacts,
      }),
      rankedResults: [{ entityId: eid } as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult],
      effectiveRetrievalMode: 'attribute_search' as const,
      retrievalKind: 'generic_hybrid' as const,
      sparseExecuted: true,
      specializedRouteExecuted: null,
      usedCompiledExecution: false,
    };
    const hybrid = vi.fn(async () => hybridOut);
    const mixed = vi.fn(async () => hybridOut);
    const entityLaneArtifacts = buildEmptySearchExecutionLaneArtifacts();
    const entityResolveResult = minimalResolve();
    const ent = vi.fn(async () => ({
      executionTopology: 'entity_only' as const,
      identityResolveResult: entityResolveResult,
      fusedResolveResult: entityResolveResult,
      laneArtifacts: entityLaneArtifacts,
      laneTrace: buildSearchExecutionLaneTrace({
        executionTopology: 'entity_only',
        identityResolveResult: entityResolveResult,
        fusedResolveResult: entityResolveResult,
        laneArtifacts: entityLaneArtifacts,
      }),
      rankedResults: [],
      effectiveRetrievalMode: 'entity_lookup',
      retrievalKind: 'entity_lookup',
      sparseExecuted: false,
      specializedRouteExecuted: null,
      usedCompiledExecution: false,
    }));

    await expect(
      dispatchSearchRouteExecution('hybrid', {
        executeEntity: ent,
        executeHybrid: hybrid,
        executeMixed: mixed,
      }),
    ).resolves.toBe(hybridOut);
    expect(hybrid).toHaveBeenCalledOnce();

    await expect(
      dispatchSearchRouteExecution('mixed', {
        executeEntity: ent,
        executeHybrid: hybrid,
        executeMixed: mixed,
      }),
    ).resolves.toBe(hybridOut);
    expect(mixed).toHaveBeenCalledOnce();
  });
});

describe('SearchUseCase unexpected error fallback', () => {
  it('throws DomainError when pre-route planning throws (propagated as 500)', async () => {
    const useCase = new SearchUseCase({
      queryPlanner: {
        plan: vi.fn().mockRejectedValue(new Error('planner exploded')),
      } as never,
      entityResolver: {
        resolve: vi.fn(),
      } as never,
      candidatePool: {
        generate: vi.fn(),
      } as never,
      ranker: {
        rank: vi.fn(),
      } as never,
      decisionEngine: {
        decide: vi.fn(),
      } as never,
      responseBuilder: {
        build: vi.fn(),
      } as never,
      mixedSolver: {
        solve: vi.fn(),
      } as never,
      querySanitizer: {
        sanitize: vi.fn((query: string) => ({
          safe: true,
          sanitizedQuery: query.trim(),
        })),
      } as never,
    });

    // The refactored search use case now throws instead of returning a
    // degraded 200 response when the pipeline fails unexpectedly.
    await expect(
      useCase.execute({ query: '  ridge cabernet  ' }, 'req-search-unexpected'),
    ).rejects.toThrow();
  });
});

describe('SearchUseCase lookup_wine authority routing', () => {
  it('routes direct lookup_wine primitives through the compatibility authority by default', async () => {
    const compatResponse = {
      queryType: 'search' as const,
      engineDecision: {
        decisionStatus: 'resolved' as const,
        nextAction: 'return_result' as const,
        route: 'entity' as const,
        decisionConfidence: 1,
        confidenceSemantics: 'calibrated_decision_confidence' as const,
        decisionTraceRef: 'trace-ref',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: 'test',
          threshold_profile_id: 'default',
          planner_version: 'test',
          feature_flags: {},
        },
      },
      results: [],
      clarification: null,
      meta: {
        requestId: 'req-lookup',
        queryTimeMs: 1,
        route: 'entity' as const,
        version: 'test',
        engine_schema_version: 'search_response_v1' as const,
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: 'test',
          threshold_profile_id: 'default',
          planner_version: 'test',
          feature_flags: {},
        },
        response_hash: 'hash',
      },
    };

    const compatExecute = vi.fn().mockResolvedValue(compatResponse);
    const queryPlanner = { plan: vi.fn() };
    const useCase = new SearchUseCase({
      queryPlanner: queryPlanner as never,
      entityResolver: { resolve: vi.fn() } as never,
      candidatePool: { generate: vi.fn() } as never,
      ranker: { rank: vi.fn() } as never,
      decisionEngine: { decide: vi.fn() } as never,
      responseBuilder: { build: vi.fn() } as never,
      mixedSolver: { solve: vi.fn() } as never,
      querySanitizer: {
        sanitize: vi.fn((query: string) => ({ safe: true, sanitizedQuery: query.trim() })),
      } as never,
      lookupWineV2CompatibilityUseCase: {
        execute: compatExecute,
      },
    });

    const response = await useCase.execute(
      { query: 'Opus One', primitiveRoute: 'lookup_wine', limit: 2 },
      'req-lookup',
    );

    expect(response).toBe(compatResponse);
    expect(compatExecute).toHaveBeenCalledWith(
      { query: 'Opus One', limit: 2, requestId: 'req-lookup' },
      undefined,
    );
    expect(queryPlanner.plan).not.toHaveBeenCalled();
  });

  it('allows explicit legacy_core opt-in for benchmark/debug callers', async () => {
    const compatExecute = vi.fn();
    const entityResolver = {
      resolve: vi.fn().mockRejectedValue(new Error('legacy entity stack reached')),
    };
    const useCase = new SearchUseCase({
      queryPlanner: { plan: vi.fn() } as never,
      entityResolver: entityResolver as never,
      candidatePool: { generate: vi.fn() } as never,
      ranker: { rank: vi.fn() } as never,
      decisionEngine: { decide: vi.fn() } as never,
      responseBuilder: { build: vi.fn() } as never,
      mixedSolver: { solve: vi.fn() } as never,
      querySanitizer: {
        sanitize: vi.fn((query: string) => ({ safe: true, sanitizedQuery: query.trim() })),
      } as never,
      lookupWineV2CompatibilityUseCase: {
        execute: compatExecute,
      },
    });

    await expect(
      useCase.execute(
        { query: 'Opus One', primitiveRoute: 'lookup_wine' },
        'req-legacy',
        { lookupAuthorityMode: 'legacy_core' },
      ),
    ).rejects.toThrow();

    expect(compatExecute).not.toHaveBeenCalled();
    expect(entityResolver.resolve).toHaveBeenCalledOnce();
  });
});

describe('SearchUseCase hybrid execution topology', () => {
  function buildPlan(): QueryPlanV1 {
    return {
      rawQuery: 'napa cabernet',
      normalizedQuery: 'napa cabernet',
      intent: 'search',
      route: 'hybrid',
      retrievalMode: 'attribute_search',
      queryClass: 'known_item',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {} as QueryPlanV1['policy'],
      uncertainty: {} as QueryPlanV1['uncertainty'],
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
    } as QueryPlanV1;
  }

  function buildCompiled(
    plan: QueryPlanV1,
    overrides?: Partial<CompiledWineQuery['execution']>,
  ): CompiledWineQuery {
    return {
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
        executionTopology: 'general_only',
        effectiveRetrievalMode: 'attribute_search',
        routeSource: 'api_override',
        budget: {
          maxCandidates: 20,
          enablePrecisionRerank: true,
        },
        provenancePolicy: {
          requireIdentitySeal: false,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
        ...overrides,
      },
    };
  }

  it('keeps api_override hybrid on general_only without invoking identity lane', async () => {
    const plan = buildPlan();
    const compiled = buildCompiled(plan);
    const entityResolver = {
      resolve: vi.fn(async () => {
        throw new Error('identity lane should not run for general_only hybrid execution');
      }),
    };
    const candidatePool = {
      execute: vi.fn(async () => ({
        candidates: [
          {
            entityId: createEntityId('wine-1'),
            canonicalLabel: 'Wine One',
            fusionRrfTotal: 0.84,
            matchedConstraints: [],
            retrievalTrace: {
              retrievalProfile: 'generic_hybrid',
              lexicalQueriesUsed: [],
              semanticQueriesUsed: [],
              filtersApplied: [],
              candidateSources: ['candidate_pool'],
            },
          },
        ],
      })),
    };
    const ranker = {
      rank: vi.fn(async (input: { candidates: readonly { entityId: string; canonicalLabel?: string }[] }) => ({
        results: input.candidates.map((candidate, index) => ({
          entityId: candidate.entityId,
          canonicalLabel: candidate.canonicalLabel ?? `Candidate ${index + 1}`,
          finalScore: 0.88,
          rank: index + 1,
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
          evidenceItems: [],
          matchedConstraints: [],
          unmetConstraints: [],
          inferredConstraints: [],
        })),
        metadata: { runtimeSignal: undefined, funnelMetrics: undefined },
      })),
    };
    const useCase = new SearchUseCase({
      queryPlanner: { plan: vi.fn() } as never,
      allowCompiledFallback: true,
      entityResolver: entityResolver as never,
      candidatePool: candidatePool as never,
      ranker: ranker as never,
      decisionEngine: { decide: vi.fn() } as never,
      responseBuilder: { build: vi.fn() } as never,
      mixedSolver: { solve: vi.fn() } as never,
      querySanitizer: {
        sanitize: vi.fn((query: string) => ({
          safe: true,
          sanitizedQuery: query.trim(),
        })),
      } as never,
    });

    const result = await (useCase as any).executeHybridRoute(plan, compiled);

    expect(entityResolver.resolve).not.toHaveBeenCalled();
    expect(candidatePool.execute).toHaveBeenCalledTimes(1);
    expect(result.executionTopology).toBe('general_only');
    expect(result.executedCompiled.execution.executionTopology).toBe('general_only');
    expect(result.identityResolveResult).toBeNull();
    expect(result.laneArtifacts.identity).toEqual([]);
    expect(result.laneTrace.identity.participated).toBe(false);
    expect(result.laneTrace.general.participated).toBe(true);
  });

  it('promotes auto hybrid execution onto the dual-lane live route', async () => {
    const plan = buildPlan();
    const compiled = buildCompiled(plan, {
      executionTopology: 'dual_lane',
      routeSource: 'planner',
    });
    const identityResolveResult: EntityResolveResult = {
      status: 'resolved',
      topEntity: {
        entityId: createEntityId('wine-1'),
        canonicalLabel: 'Wine One',
        calibratedScore: 0.96,
      },
      candidates: [
        {
          entityId: createEntityId('wine-1'),
          canonicalLabel: 'Wine One',
          calibratedScore: 0.96,
          rank: 1,
          evidenceRefs: ['identity:1'],
        },
      ],
      decisionConfidenceC: 0.96,
      decisionTrace: {
        queryClass: 'known_item',
        top1CalibratedScore: 0.96,
        top2CalibratedScore: undefined,
        calibratedGap: undefined,
        decisionConfidenceC: 0.96,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.05 },
        outcomeReasonCodes: ['EXACT_MATCH'],
      },
      conformalSetSize: 1,
    };
    const entityResolver = {
      resolve: vi.fn(async () => identityResolveResult),
    };
    const candidatePool = {
      execute: vi.fn(async () => ({
        candidates: [
          {
            entityId: createEntityId('wine-1'),
            canonicalLabel: 'Wine One',
            fusionRrfTotal: 0.91,
            matchedConstraints: [],
            retrievalTrace: {
              retrievalProfile: 'generic_hybrid',
              lexicalQueriesUsed: [],
              semanticQueriesUsed: [],
              filtersApplied: [],
              candidateSources: ['candidate_pool'],
            },
          },
        ],
      })),
    };
    const ranker = {
      rank: vi.fn(async (input: { candidates: readonly { entityId: string; canonicalLabel?: string }[] }) => ({
        results: input.candidates.map((candidate, index) => ({
          entityId: candidate.entityId,
          canonicalLabel: candidate.canonicalLabel ?? `Candidate ${index + 1}`,
          finalScore: 0.89,
          rank: index + 1,
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
          evidenceItems: [],
          matchedConstraints: [],
          unmetConstraints: [],
          inferredConstraints: [],
        })),
        metadata: { runtimeSignal: undefined, funnelMetrics: undefined },
      })),
    };
    const useCase = new SearchUseCase({
      queryPlanner: { plan: vi.fn() } as never,
      allowCompiledFallback: true,
      entityResolver: entityResolver as never,
      candidatePool: candidatePool as never,
      ranker: ranker as never,
      decisionEngine: { decide: vi.fn() } as never,
      responseBuilder: { build: vi.fn() } as never,
      mixedSolver: { solve: vi.fn() } as never,
      querySanitizer: {
        sanitize: vi.fn((query: string) => ({
          safe: true,
          sanitizedQuery: query.trim(),
        })),
      } as never,
    });

    const result = await (useCase as any).executeHybridRoute(plan, compiled);

    expect(entityResolver.resolve).toHaveBeenCalledTimes(1);
    expect(candidatePool.execute).toHaveBeenCalledTimes(1);
    expect(result.executionTopology).toBe('dual_lane');
    expect(result.executedCompiled.execution.executionTopology).toBe('dual_lane');
    expect(result.identityResolveResult).toBe(identityResolveResult);
    expect(result.laneTrace.identity.participated).toBe(true);
    expect(result.laneTrace.general.participated).toBe(true);
  });
});
