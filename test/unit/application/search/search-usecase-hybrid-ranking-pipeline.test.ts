import { describe, expect, it, vi } from 'vitest';
import {
  executeHybridRouteRankingPipeline,
  resolveEntityRouteForPlan,
} from '../../../../src/application/search/search-usecase-hybrid-ranking-pipeline.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function minimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'Kalaris Merlot',
    normalizedQuery: 'kalaris merlot',
    intent: 'entity_exact',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'unknown',
    anchors: [],
    constraints: {
      hard: [{
        attribute: 'region',
        operator: '=',
        value: 'Bordeaux',
        source_phrase: 'Bordeaux',
        confidence: 0.95,
      }],
      soft: [],
      inferred: [],
    },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

function minimalResolveResult(): EntityResolveResult {
  return {
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
  };
}

function buildCompiled(plan: QueryPlanV1): CompiledWineQuery {
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
        hardFilterTokens: ['region:original'],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'recommendation',
      routeSource: 'planner',
      budget: {
        maxCandidates: 20,
        enablePrecisionRerank: true,
      },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: true,
        requireAnchorEvidence: false,
      },
    },
  };
}

describe('executeHybridRouteRankingPipeline', () => {
  it('preserves compiled execution mode while regenerating only relaxed retrieval planning', async () => {
    const plan = minimalPlan();
    const compiled = buildCompiled(plan);
    const candidatePool = {
      execute: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          entityId: createEntityId('wine-1'),
          canonicalLabel: 'Recovered Wine',
        }]),
    };
    const ranker = {
      rank: vi.fn().mockImplementation(async (input: { candidates: readonly unknown[] }) => {
        if (input.candidates.length === 0) {
          return {
            results: [],
            metadata: { runtimeSignal: undefined, funnelMetrics: undefined },
          };
        }
        return {
          results: [{
            entityId: createEntityId('wine-1'),
            canonicalLabel: 'Recovered Wine',
            finalScore: 0.91,
            rank: 1,
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
            matchedConstraints: ['region'],
            unmetConstraints: [],
            inferredConstraints: [],
          }],
          metadata: { runtimeSignal: undefined, funnelMetrics: undefined },
        };
      }),
    };

    const result = await executeHybridRouteRankingPipeline(
      plan,
      {
        candidatePool: candidatePool as never,
        ranker: ranker as never,
      },
      async () => minimalResolveResult(),
      compiled,
    );

    expect(candidatePool.execute).toHaveBeenCalledTimes(2);
    expect(ranker.rank).toHaveBeenCalledTimes(2);
    expect(candidatePool.execute.mock.calls[0]?.[0]?.compiledRetrievalMode).toBe('recommendation');
    expect(candidatePool.execute.mock.calls[1]?.[0]?.compiledRetrievalMode).toBe('recommendation');
    expect(candidatePool.execute.mock.calls[1]?.[0]?.retrievalPlan?.hardFilterTokens).toEqual([]);
    expect(ranker.rank.mock.calls[1]?.[0]?.compiled?.execution.effectiveRetrievalMode).toBe('recommendation');
    expect(ranker.rank.mock.calls[1]?.[0]?.compiled?.query.retrievalPlan?.hardFilterTokens).toEqual([]);
    expect(result.effectiveRetrievalMode).toBe('recommendation');
    expect(result.retrievalKind).toBe('generic_hybrid');
    expect(result.sparseExecuted).toBe(true);
    expect(result.usedCompiledExecution).toBe(true);
    expect(result.rankingMetadata?.provenanceClosure).toEqual({
      policy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: true,
        requireAnchorEvidence: false,
      },
      preRank: {
        candidateCount: 1,
        identityEvidenceSatisfied: true,
        constraintEvidenceSatisfied: false,
        anchorEvidenceSatisfied: true,
        matchedConstraintAttributes: [],
        unmetConstraintAttributes: [],
        anchorSignalTypes: [],
      },
      postRank: {
        candidateCount: 1,
        identityEvidenceSatisfied: true,
        constraintEvidenceSatisfied: false,
        anchorEvidenceSatisfied: true,
        matchedConstraintAttributes: [],
        unmetConstraintAttributes: [],
        anchorSignalTypes: [],
      },
      missing: ['constraint_evidence'],
      satisfied: false,
    });
  });

  it('materializes provenance shortfall into ranking metadata and route degradation before decision', async () => {
    const plan = minimalPlan();
    const baseCompiled = buildCompiled(plan);
    const compiled: CompiledWineQuery = {
      ...baseCompiled,
      execution: {
        ...baseCompiled.execution,
        provenancePolicy: {
          requireIdentitySeal: true,
          requireConstraintEvidence: true,
          requireAnchorEvidence: false,
        },
      },
    };
    const candidatePool = {
      execute: vi.fn().mockResolvedValue([{
        entityId: createEntityId('wine-shortfall'),
        canonicalLabel: 'Shortfall Wine',
        matchedConstraints: ['region'],
      }]),
    };
    const ranker = {
      rank: vi.fn().mockResolvedValue({
        results: [{
          entityId: createEntityId('wine-shortfall'),
          canonicalLabel: 'Shortfall Wine',
          finalScore: 0.77,
          rank: 1,
          componentScores: {
            entityIntegrity: 1,
            semantic: 0.7,
            hardConstraintPass: true,
            softConstraint: 0,
            attributeAlignment: 0,
            preferenceAlignment: 0,
            popularity: 0,
            availability: 1,
            uncertaintyPenalty: 0,
          },
          evidenceItems: [],
          matchedConstraints: ['region'],
          unmetConstraints: [],
          inferredConstraints: [],
        }],
        metadata: {
          coarsePruneSummary: undefined,
          rerankExecuted: false,
          rerankGateReason: undefined,
          runtimeSignal: undefined,
          preRerankTop5: [],
        },
      }),
    };

    const result = await executeHybridRouteRankingPipeline(
      plan,
      {
        candidatePool: candidatePool as never,
        ranker: ranker as never,
      },
      async () => minimalResolveResult(),
      compiled,
    );

    expect(result.rankingMetadata?.provenanceClosure?.missing).toEqual(['identity_evidence']);
    expect(result.routeDegradation?.degradationReasons).toContain(
      'provenance_shortfall:identity_evidence',
    );
  });

  it('caps hybrid anchor blocker recall using compiled execution budget', async () => {
    const anchorEntityId = createEntityId('anchor-entity');
    const blockerEntityIdA = createEntityId('blocker-a');
    const blockerEntityIdB = createEntityId('blocker-b');
    const plan: QueryPlanV1 = {
      ...minimalPlan(),
      anchors: [{
        surfaceForm: 'Opus One',
        normalizedForm: 'opus one',
        candidateEntityIds: [anchorEntityId],
        lookupStrategies: ['exact'],
        confidence: 0.99,
        source: 'alias',
      }],
    };
    const baseCompiled = buildCompiled(plan);
    const compiled: CompiledWineQuery = {
      ...baseCompiled,
      execution: {
        ...baseCompiled.execution,
        budget: {
          maxCandidates: 2,
          enablePrecisionRerank: true,
        },
      },
    };
    const getDocuments = vi.fn().mockResolvedValue(new Map([
      [anchorEntityId, {
        entityId: anchorEntityId,
        entityType: 'wine',
        canonicalLabel: 'Anchor Wine',
      }],
      [blockerEntityIdA, {
        entityId: blockerEntityIdA,
        entityType: 'wine',
        canonicalLabel: 'Blocker Wine A',
      }],
      [blockerEntityIdB, {
        entityId: blockerEntityIdB,
        entityType: 'wine',
        canonicalLabel: 'Blocker Wine B',
      }],
    ]));
    const resolve = vi.fn().mockResolvedValue(minimalResolveResult());
    const blocker = {
      block: vi.fn().mockResolvedValue([blockerEntityIdA, blockerEntityIdB]),
    };

    await resolveEntityRouteForPlan(
      plan,
      {
        entityResolver: { resolve } as never,
        entityLookup: { getDocument: vi.fn(), getDocuments } as never,
        blocker: blocker as never,
      },
      compiled,
    );

    expect(blocker.block).toHaveBeenCalledTimes(1);
    expect(getDocuments).toHaveBeenCalledWith([anchorEntityId, blockerEntityIdA]);
    expect(resolve.mock.calls[0]?.[0]?.candidateEntities).toHaveLength(2);
    expect(resolve.mock.calls[0]?.[0]?.candidateEntities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: anchorEntityId }),
      expect.objectContaining({ entityId: blockerEntityIdA }),
    ]));
  });
});
