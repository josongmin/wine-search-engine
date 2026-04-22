import { describe, expect, it, vi } from 'vitest';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import {
  executeDualLaneHybridRoute,
  executeDualLaneSearch,
} from '../../../../src/application/search/search-usecase-dual-lane-execution.js';

function buildPlan(): QueryPlanV1 {
  return {
    rawQuery: 'Kalaris Merlot',
    normalizedQuery: 'kalaris merlot',
    intent: 'entity_exact',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'unknown',
    anchors: [],
    constraints: {
      hard: [],
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

function buildCompiled(
  plan: QueryPlanV1,
  effectiveRetrievalMode: CompiledWineQuery['execution']['effectiveRetrievalMode'] = 'recommendation',
  executionTopology: CompiledWineQuery['execution']['executionTopology'] = 'dual_lane',
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
      executionTopology,
      effectiveRetrievalMode,
      routeSource: 'planner',
      budget: {
        maxCandidates: 20,
        enablePrecisionRerank: true,
      },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  };
}

function buildResolveResult(): EntityResolveResult {
  return {
    status: 'resolved',
    topEntity: {
      entityId: createEntityId('wine-1'),
      canonicalLabel: 'Wine One',
      calibratedScore: 0.97,
    },
    candidates: [
      {
        entityId: createEntityId('wine-1'),
        canonicalLabel: 'Wine One',
        calibratedScore: 0.97,
        rank: 1,
        evidenceRefs: [],
      },
      {
        entityId: createEntityId('wine-2'),
        canonicalLabel: 'Wine Two',
        calibratedScore: 0.76,
        rank: 2,
        evidenceRefs: [],
      },
    ],
    decisionConfidenceC: 0.97,
    decisionTrace: {
      queryClass: 'unknown',
      top1CalibratedScore: 0.97,
      top2CalibratedScore: 0.76,
      calibratedGap: 0.21,
      decisionConfidenceC: 0.97,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.05 },
      outcomeReasonCodes: ['EXACT_MATCH'],
    },
    conformalSetSize: 1,
  };
}

function buildGeneralCandidate(
  entityId: string,
  canonicalLabel: string,
  fusionRrfTotal: number,
) {
  return {
    entityId: createEntityId(entityId),
    canonicalLabel,
    fusionRrfTotal,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'generic_hybrid',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: ['candidate_pool'],
    },
  };
}

describe('search-usecase-dual-lane-execution', () => {
  it('runs identity and general lanes together and materializes fused SSOT artifacts', async () => {
    const plan = buildPlan();
    const compiled = buildCompiled(plan);
    const entityResolver = {
      resolve: vi.fn(async () => buildResolveResult()),
    };
    const candidatePool = {
      execute: vi.fn(async () => ([
        buildGeneralCandidate('wine-1', 'Wine One', 0.91),
        buildGeneralCandidate('wine-3', 'Wine Three', 0.63),
        buildGeneralCandidate('wine-3', 'Wine Three Duplicate', 0.12),
      ])),
    };

    const executionPromise = executeDualLaneSearch(
      plan,
      {
        entityResolver: entityResolver as never,
        candidatePool: candidatePool as never,
        ranker: {} as never,
      },
      compiled,
    );

    await Promise.resolve();

    expect(entityResolver.resolve).toHaveBeenCalledTimes(1);
    expect(candidatePool.execute).toHaveBeenCalledTimes(1);

    const execution = await executionPromise;

    expect(execution.executionTopology).toBe('dual_lane');
    expect(execution.generalRetrievalResult.candidates).toHaveLength(3);
    expect(execution.fusedCandidates.map((candidate) => String(candidate.entityId))).toEqual([
      'wine-1',
      'wine-3',
      'wine-2',
    ]);
    expect(
      execution.laneArtifacts.map((artifact) => ({
        entityId: String(artifact.entityId),
        lanePresence: artifact.lanePresence,
      })),
    ).toEqual([
      { entityId: 'wine-1', lanePresence: 'corroborated' },
      { entityId: 'wine-3', lanePresence: 'general_only' },
      { entityId: 'wine-2', lanePresence: 'entity_only' },
    ]);
  });

  it('reuses the same identity resolution when the general lane requires a compare anchor', async () => {
    const plan = buildPlan();
    const compiled = buildCompiled(plan, 'compare_candidates');
    const resolveResult = buildResolveResult();
    const entityResolver = {
      resolve: vi.fn(async () => resolveResult),
    };
    const compareRetriever = {
      compareAgainstAnchor: vi.fn(async () => ([
        buildGeneralCandidate('wine-1', 'Wine One', 0.81),
        buildGeneralCandidate('wine-9', 'Wine Nine', 0.77),
      ])),
    };
    const ranker = {
      rank: vi.fn(async (input: { candidates: readonly { entityId: string; canonicalLabel?: string }[] }) => ({
        results: input.candidates.map((candidate, index) => ({
          entityId: candidate.entityId,
          canonicalLabel: candidate.canonicalLabel ?? `Candidate ${index + 1}`,
          finalScore: index === 0 ? 0.92 : 0.84,
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

    const execution = await executeDualLaneHybridRoute(
      plan,
      {
        entityResolver: entityResolver as never,
        compareRetriever: compareRetriever as never,
        candidatePool: {} as never,
        ranker: ranker as never,
      },
      compiled,
    );

    expect(entityResolver.resolve).toHaveBeenCalledTimes(1);
    expect(compareRetriever.compareAgainstAnchor).toHaveBeenCalledWith(
      createEntityId('wine-1'),
      plan.constraints,
      20,
      undefined,
    );
    expect(execution.dualLaneExecution.identityResolveResult).toBe(resolveResult);
    expect(execution.routeExecution.executionTopology).toBe('dual_lane');
    expect(execution.routeExecution.identityResolveResult).toBe(resolveResult);
    expect(execution.routeExecution.dualLaneExecutionAttemptId).toMatch(/^dual-lane-attempt-/u);
    expect(execution.routeExecution.laneArtifacts.identity).toHaveLength(2);
    expect(execution.routeExecution.laneArtifacts.general).toHaveLength(2);
    expect(execution.routeExecution.laneArtifacts.fused).toHaveLength(3);
    expect(execution.routeExecution.laneTrace).toEqual({
      identity: {
        participated: true,
        artifactCount: 2,
        resolveStatus: 'resolved',
      },
      general: {
        participated: true,
        artifactCount: 2,
      },
      fused: {
        participated: true,
        artifactCount: 3,
        resolveStatus: 'resolved',
      },
    });
    expect(execution.routeExecution.rankedResults.map((result) => String(result.entityId))).toEqual([
      'wine-1',
      'wine-9',
      'wine-2',
    ]);
  });

  it('rejects general-only compiled carriers instead of upgrading them into dual-lane', async () => {
    const plan = buildPlan();
    const compiled = buildCompiled(plan, 'recommendation', 'general_only');
    const entityResolver = {
      resolve: vi.fn(async () => buildResolveResult()),
    };
    const candidatePool = {
      execute: vi.fn(async () => [
        buildGeneralCandidate('wine-1', 'Wine One', 0.91),
        buildGeneralCandidate('wine-3', 'Wine Three', 0.63),
      ]),
    };
    const ranker = {
      rank: vi.fn(async (input: { candidates: readonly { entityId: string; canonicalLabel?: string }[] }) => ({
        results: input.candidates.map((candidate, index) => ({
          entityId: candidate.entityId,
          canonicalLabel: candidate.canonicalLabel ?? `Candidate ${index + 1}`,
          finalScore: index === 0 ? 0.92 : 0.84,
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

    await expect(
      executeDualLaneHybridRoute(
        plan,
        {
          entityResolver: entityResolver as never,
          candidatePool: candidatePool as never,
          ranker: ranker as never,
        },
        compiled,
      ),
    ).rejects.toThrow('Dual-lane executor requires executionTopology=dual_lane');
  });

  it('keeps the selected dual-lane attempt aligned with the retrieval attempt chosen after relaxation', async () => {
    const plan = {
      ...buildPlan(),
      constraints: {
        hard: [{
          attribute: 'region',
          operator: 'eq',
          value: 'Napa Valley',
        }],
        soft: [],
        inferred: [],
      },
    } as QueryPlanV1;
    const compiled = buildCompiled(plan);
    const firstResolveResult = buildResolveResult();
    const relaxedResolveResult: EntityResolveResult = {
      ...buildResolveResult(),
      topEntity: {
        entityId: createEntityId('wine-9'),
        canonicalLabel: 'Relaxed Wine',
        calibratedScore: 0.88,
      },
      candidates: [{
        entityId: createEntityId('wine-9'),
        canonicalLabel: 'Relaxed Wine',
        calibratedScore: 0.88,
        rank: 1,
        evidenceRefs: [],
      }],
      decisionConfidenceC: 0.88,
      decisionTrace: {
        ...buildResolveResult().decisionTrace,
        top1CalibratedScore: 0.88,
        top2CalibratedScore: undefined,
        calibratedGap: undefined,
        decisionConfidenceC: 0.88,
      },
    };
    const entityResolver = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce(firstResolveResult)
        .mockResolvedValueOnce(relaxedResolveResult),
    };
    const candidatePool = {
      execute: vi.fn(async () => [
        buildGeneralCandidate('wine-9', 'Relaxed Wine', 0.93),
      ]),
    };
    const ranker = {
      rank: vi
        .fn()
        .mockResolvedValueOnce({
          results: [],
          metadata: { runtimeSignal: undefined, funnelMetrics: undefined },
        })
        .mockResolvedValueOnce({
          results: [{
            entityId: createEntityId('wine-9'),
            canonicalLabel: 'Relaxed Wine',
            finalScore: 0.93,
            rank: 1,
            componentScores: {
              entityIntegrity: 1,
              semantic: 0.9,
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
          }],
          metadata: { runtimeSignal: undefined, funnelMetrics: undefined },
        }),
    };

    const execution = await executeDualLaneHybridRoute(
      plan,
      {
        entityResolver: entityResolver as never,
        candidatePool: candidatePool as never,
        ranker: ranker as never,
      },
      compiled,
    );

    expect(entityResolver.resolve).toHaveBeenCalledTimes(2);
    expect(candidatePool.execute).toHaveBeenCalledTimes(2);
    expect(execution.dualLaneExecution.identityResolveResult).toBe(relaxedResolveResult);
    expect(execution.routeExecution.identityResolveResult).toBe(relaxedResolveResult);
    expect(
      execution.routeExecution.rankedResults.map((result) => String(result.entityId)),
    ).toEqual(['wine-9']);
    expect(
      execution.routeExecution.laneArtifacts.fused.map((artifact) => String(artifact.entityId)),
    ).toEqual(['wine-9']);
  });
});
