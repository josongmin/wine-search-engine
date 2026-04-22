/**
 * Integration test: Post-route AuditExtension derivation.
 *
 * Tests that deriveAuditExtension (module-private) is correctly wired through
 * runRankedRouteDecisionPhase() — when explain=true, the response should
 * include typed audit_extension fields built from planner trace, ranking
 * metadata, abstain decisions, drop logs, and corrective retry calibration.
 *
 * Since deriveAuditExtension is not exported, we test it indirectly via
 * runRankedRouteDecisionPhase(), which is the public entry point that calls it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RankedRouteDecisionPhaseContext } from '../../src/application/search/search-usecase-post-route-phase.js';
import { runRankedRouteDecisionPhase } from '../../src/application/search/search-usecase-post-route-phase.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../src/domain/query/model/compiled-wine-query.js';
import type { RankedResult } from '../../src/domain/ranking/model/ranked-result.js';
import type { RankingMetadata, RerankDecision } from '../../src/domain/ranking/port/ranker.port.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import type { DecisionEnginePort, ResponseBuilderPort } from '../../src/application/search/port/search-pipeline-deps.port.js';
import type { CandidateDropRecord, RrfFusionTrace } from '../../src/domain/retrieval/model/candidate-envelope.js';
import type { PolicyDecisionRecord } from '../../src/domain/query/model/policy-decision-record.js';
import type { ScoreDriftRecord } from '../../src/domain/ranking/model/score-decomposition.js';
import type { AuditExtension } from '../../src/domain/audit/model/audit-extension.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import { ResponseBuilder } from '../../src/domain/response/service/response-builder.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeMinimalPlan(overrides?: Partial<QueryPlanV1>): QueryPlanV1 {
  return {
    rawQuery: 'test wine query',
    normalizedQuery: 'test wine query',
    intent: 'facet_search',
    route: 'hybrid',
    retrievalMode: 'attribute_search',
    queryClass: 'pure_constraint',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: { requireExact: false, allowApproximate: true },
    uncertainty: { overall: 0.1, ambiguityDetected: false, ambiguityTypes: [] },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

function makeMinimalCompiled(overrides?: {
  plannerTrace?: readonly PolicyDecisionRecord[];
}): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'test wine query',
      normalizedQuery: 'test wine query',
      intent: 'facet_search',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: { overall: 0.1, ambiguityDetected: false, ambiguityTypes: [] },
      queryClass: 'pure_constraint',
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
    },
    execution: {
      effectiveRoute: 'hybrid',
      executionTopology: 'general_only',
      effectiveRetrievalMode: 'attribute_search',
      routeSource: 'planner',
      budget: { maxCandidates: 50, rerankLimit: 0, enablePrecisionRerank: false },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
    ...(overrides?.plannerTrace !== undefined
      ? { plannerTrace: overrides.plannerTrace }
      : {}),
  } as CompiledWineQuery;
}

function makeRankedResult(entityId: string, finalScore: number, rank: number): RankedResult {
  return {
    entityId,
    canonicalLabel: `Wine ${entityId}`,
    finalScore,
    rank,
    componentScores: {
      entityIntegrity: 0.9,
      semantic: 0.8,
      hardConstraintPass: true,
      softConstraint: 0.7,
      attributeAlignment: 0.6,
      preferenceAlignment: 0.5,
      popularity: 0.3,
      availability: 0.9,
      uncertaintyPenalty: 0,
    },
    evidenceItems: [
      {
        type: 'retrieval',
        source: 'integration-test',
        contribution: '1.0',
        strength: 'high',
        provenance: 'integration-test:evidence',
      },
    ],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
  } as unknown as RankedResult;
}

function makeResolveResult(): EntityResolveResult {
  return {
    status: 'resolved',
    candidates: [],
    decisionTrace: {
      queryClass: 'pure_constraint',
      top1CalibratedScore: 0.9,
      top2CalibratedScore: 0.1,
      calibratedGap: 0.8,
      decisionConfidenceC: 0.9,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.3 },
      outcomeReasonCodes: [],
    },
    conformalSetSize: 1,
  };
}

function makeLaneTrace() {
  return {
    identity: {
      participated: true,
      artifactCount: 1,
      resolveStatus: 'resolved',
    },
    general: {
      participated: true,
      artifactCount: 4,
    },
    fused: {
      participated: true,
      artifactCount: 3,
      resolveStatus: 'resolved',
    },
  } as const;
}

function makeStubDecisionEngine(): DecisionEnginePort {
  return {
    decide: vi.fn().mockResolvedValue({
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      decisionConfidence: 0.95,
      confidenceSemantics: 'calibrated_decision_confidence',
      selectedEntity: {
        entityId: 'e-1',
        canonicalLabel: 'Wine e-1',
        identity_signature: 'sig-e-1',
        snapshot_ref: 'snap-1',
      },
      chosenEntityId: 'e-1',
      signalSet: {
        route: 'hybrid',
        retrievedCount: 1,
        rankedCount: 1,
      },
      evidenceItems: [
        {
          type: 'decision',
          source: 'integration-test',
          contribution: '1.0',
          strength: 'high',
          provenance: 'integration-test:decision',
        },
      ],
      decisionTraceRef: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      decisionSnapshot: {
        snapshot_id: 'snap-1',
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
        response_contract_version: 'search_response_v1',
      },
      decisionTrace: {
        queryClass: 'pure_constraint',
        top1Score: 0.95,
        top2Score: 0.05,
        thresholdApplied: 0.5,
        marginApplied: 0.3,
        finalReason: 'resolved',
      },
    }),
  } as unknown as DecisionEnginePort;
}

function makeStubResponseBuilder(auditCapture?: { value?: AuditExtension }): ResponseBuilderPort {
  return {
    build: vi.fn().mockImplementation((params: Record<string, unknown>) => {
      // Capture the audit extension for assertion.
      if (auditCapture != null && params['auditExtension'] !== undefined) {
        auditCapture.value = params['auditExtension'] as AuditExtension;
      }
      return {
        meta: {
          requestId: 'req-test',
          queryTimeMs: 10,
          route: 'hybrid',
        },
        results: [],
        engineDecision: {
          decisionStatus: 'success',
          nextAction: 'display_results',
        },
      } satisfies Partial<SearchResponseV1> as unknown as SearchResponseV1;
    }),
  } as unknown as ResponseBuilderPort;
}

function makeRealResponseBuilder(): ResponseBuilderPort {
  const builder = new ResponseBuilder();
  return {
    build: vi.fn().mockImplementation((params: Parameters<ResponseBuilder['build']>[0]) => builder.build(params)),
  } as unknown as ResponseBuilderPort;
}

function makeBaseContext(overrides?: Partial<RankedRouteDecisionPhaseContext>): RankedRouteDecisionPhaseContext {
  const auditCapture: { value?: AuditExtension } = {};
  const ctx: RankedRouteDecisionPhaseContext = {
    plan: makeMinimalPlan(),
    compiled: makeMinimalCompiled(),
    requestId: 'req-test',
    startTime: Date.now(),
    resolveResult: makeResolveResult(),
    identityResolveResult: null,
    rankedResults: [makeRankedResult('e-1', 0.9, 1)],
    fullRankedResults: [makeRankedResult('e-1', 0.9, 1)],
    effectiveRoute: 'hybrid',
    snapshotVersions: { modelVersions: { query_understanding: 'v1' }, indexVersions: {} },
    decisionEngine: makeStubDecisionEngine(),
    responseBuilder: makeStubResponseBuilder(auditCapture),
    executionTopology: 'general_only',
    laneTrace: {
      identity: { participated: false, artifactCount: 0 },
      general: { participated: true, artifactCount: 0 },
      fused: { participated: true, artifactCount: 0 },
    },
    laneArtifacts: {
      identity: [],
      general: [],
      fused: [],
    },
    effectiveRetrievalMode: 'attribute_search',
    retrievalKind: 'generic_hybrid',
    sparseExecuted: true,
    specializedRouteExecuted: null,
    usedCompiledExecution: true,
    ...overrides,
  };
  return ctx;
}

/**
 * Extracts the auditExtension from the responseBuilder.build() call args.
 */
function getAuditExtensionFromBuildCall(ctx: RankedRouteDecisionPhaseContext): AuditExtension | undefined {
  const buildFn = ctx.responseBuilder.build as ReturnType<typeof vi.fn>;
  const callArgs = buildFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  return callArgs?.['auditExtension'] as AuditExtension | undefined;
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('Post-route AuditExtension derivation via runRankedRouteDecisionPhase', () => {
  it('emits planner_policy_trace when compiled.plannerTrace is present', async () => {
    const plannerTrace: PolicyDecisionRecord[] = [
      {
        stage: 'query_classification',
        inputFacts: { rawQuery: 'test' },
        rulesEvaluated: [],
        rejectedBranches: [],
        decision: 'pure_constraint',
        confidence: 0.95,
      },
    ];
    const ctx = makeBaseContext({
      compiled: makeMinimalCompiled({ plannerTrace }),
    });

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    expect(audit).toBeDefined();
    expect(audit?.planner_policy_trace).toBeDefined();
    expect(audit!.planner_policy_trace).toHaveLength(1);
    expect(audit!.planner_policy_trace![0]!.stage).toBe('query_classification');
  });

  it('emits rerank_decision_trace when rankingMetadata.rerankDecision is present with scoreDriftRecord', async () => {
    const scoreDriftRecord: ScoreDriftRecord = {
      queryClass: 'pure_constraint',
      heuristicTop3EntityIds: ['e-1', 'e-2', 'e-3'],
      ltrTop3EntityIds: ['e-2', 'e-1', 'e-3'],
      rankOrderChanges: 1,
      averageRerankDeltaNormalized: 0.15,
      safetyEnvelopeBlocks: 0,
    };
    const rerankDecision: RerankDecision = {
      applied: true,
      decision: 'applied',
      reason: 'LTR applied normally',
      scoreDriftRecord,
    };
    const rankingMetadata: RankingMetadata = {
      coarsePruneSummary: undefined,
      rerankExecuted: true,
      rerankGateReason: undefined,
      rerankDecision,
      runtimeSignal: undefined,
      preRerankTop5: ['e-1', 'e-2', 'e-3'],
    };
    const ctx = makeBaseContext({ rankingMetadata });

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    expect(audit).toBeDefined();
    expect(audit?.rerank_decision_trace).toBeDefined();
    expect(audit!.rerank_decision_trace!.gateDecision).toBe('applied');
    expect(audit!.rerank_decision_trace!.scoreContract).toBe('bounded_normalized_0_1');
  });

  it('emits ranking_delta_trace with scoreDriftRecord from rerankDecision', async () => {
    const scoreDriftRecord: ScoreDriftRecord = {
      queryClass: 'pure_constraint',
      heuristicTop3EntityIds: ['e-1', 'e-2', 'e-3'],
      ltrTop3EntityIds: ['e-2', 'e-1', 'e-3'],
      rankOrderChanges: 2,
      averageRerankDeltaNormalized: 0.25,
      safetyEnvelopeBlocks: 1,
    };
    const rerankDecision: RerankDecision = {
      applied: true,
      decision: 'applied',
      reason: 'LTR applied normally',
      scoreDriftRecord,
    };
    const rankingMetadata: RankingMetadata = {
      coarsePruneSummary: undefined,
      rerankExecuted: true,
      rerankGateReason: undefined,
      rerankDecision,
      runtimeSignal: undefined,
      preRerankTop5: ['e-1', 'e-2', 'e-3'],
    };
    const ctx = makeBaseContext({ rankingMetadata });

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    expect(audit).toBeDefined();
    expect(audit?.ranking_delta_trace).toBeDefined();
    expect(audit!.ranking_delta_trace!.safetyEnvelopeBlocks).toBe(1);
    expect(audit!.ranking_delta_trace!.drift).toEqual(scoreDriftRecord);
    expect(audit!.ranking_delta_trace!.preRerankTop5).toEqual(['e-1', 'e-2', 'e-3']);
    // postRerankTop5 comes from rankedResults — we have one result 'e-1'
    expect(audit!.ranking_delta_trace!.postRerankTop5).toEqual(['e-1']);
  });

  it('emits hard_filter_drop_log sampled to top 5 when hardFilterDropLog is provided', async () => {
    const drops: CandidateDropRecord[] = Array.from({ length: 8 }, (_, i) => ({
      entityId: `drop-${i}`,
      dropStage: 'hard_filter' as const,
      dropReason: `filter_${i}`,
      lastKnownScore: i * 0.1,
      channels: [],
    }));
    const ctx = makeBaseContext({ hardFilterDropLog: drops });

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    expect(audit).toBeDefined();
    expect(audit?.hard_filter_drop_log).toBeDefined();
    // Should be sampled to top 5, sorted by lastKnownScore desc
    expect(audit!.hard_filter_drop_log).toHaveLength(5);
    // Highest score first (0.7, 0.6, 0.5, 0.4, 0.3)
    expect(audit!.hard_filter_drop_log![0]!.entityId).toBe('drop-7');
    expect(audit!.hard_filter_drop_log![1]!.entityId).toBe('drop-6');
  });

  it('emits corrective_retry_calibrated_confidence when correctiveRetryCalibration is provided', async () => {
    const ctx = makeBaseContext({ correctiveRetryCalibration: 0.78 });

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    expect(audit).toBeDefined();
    expect(audit?.corrective_retry_calibrated_confidence).toBe(0.78);
  });

  it('does not emit corrective_retry_calibrated_confidence when value is NaN', async () => {
    const ctx = makeBaseContext({ correctiveRetryCalibration: Number.NaN });

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    // NaN is not finite so the field should be omitted
    expect(audit?.corrective_retry_calibrated_confidence).toBeUndefined();
  });

  it('produces minimal audit extension when no optional inputs are present', async () => {
    const ctx = makeBaseContext();

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    // With no plannerTrace, no rankingMetadata, no drops, etc. — the audit
    // extension may be undefined (no trace payload to emit) or contain only
    // the execution_trace (always derived from route facts).
    // execution_trace is always built by the ranked-route decision phase.
    if (audit != null) {
      expect(audit.execution_trace).toBeDefined();
      expect(audit.planner_policy_trace).toBeUndefined();
      expect(audit.rerank_decision_trace).toBeUndefined();
      expect(audit.ranking_delta_trace).toBeUndefined();
      expect(audit.abstain_policy_trace).toBeUndefined();
      expect(audit.hard_filter_drop_log).toBeUndefined();
      expect(audit.corrective_retry_calibrated_confidence).toBeUndefined();
    }
  });

  it('emits execution_trace with route/mode/budget facts', async () => {
    const ctx = makeBaseContext();

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    expect(audit).toBeDefined();
    expect(audit?.execution_trace).toBeDefined();
    expect(audit!.execution_trace!.effective_route).toBe('hybrid');
    expect(audit!.execution_trace!.effective_retrieval_mode).toBe('attribute_search');
    expect(audit!.execution_trace!.sparse_executed).toBe(true);
    expect(audit!.execution_trace!.compiled_budget).toEqual({
      max_candidates: 50,
      rerank_limit: 0,
      enable_precision_rerank: false,
    });
  });

  it('projects execution topology into final response metadata when using the real response builder', async () => {
    const ctx = makeBaseContext({
      responseBuilder: makeRealResponseBuilder(),
      compiled: makeMinimalCompiled(),
    });

    const response = await runRankedRouteDecisionPhase(ctx);

    expect(response.engineDecision.executionTopology).toBe('general_only');
    expect(response.meta.executionContract?.executionTopology).toBe('general_only');
    expect(response.meta.auditExtension?.execution_trace?.execution_topology).toBe('general_only');
  });

  it('projects lane trace from execution contract into engine decision, meta, and audit execution trace', () => {
    const builder = new ResponseBuilder();
    const laneTrace = makeLaneTrace();
    const response = builder.build({
      decisionOutput: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        decisionConfidence: 0.95,
        confidenceSemantics: 'calibrated_decision_confidence',
        selectedEntity: {
          entityId: 'e-1',
          canonicalLabel: 'Wine e-1',
          identity_signature: 'sig-e-1',
          snapshot_ref: 'snap-1',
        },
        chosenEntityId: 'e-1',
        signalSet: {
          route: 'hybrid',
          retrievedCount: 1,
          rankedCount: 1,
        },
        evidenceItems: [
          {
            type: 'decision',
            source: 'integration-test',
            contribution: '1.0',
            strength: 'high',
            provenance: 'integration-test:decision',
          },
        ],
        decisionTraceRef: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        decisionSnapshot: {
          snapshot_id: 'snap-1',
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
          response_contract_version: 'search_response_v1',
        },
        decisionTrace: {
          queryClass: 'pure_constraint',
          top1Score: 0.95,
          top2Score: 0.05,
          thresholdApplied: 0.5,
          marginApplied: 0.3,
          finalReason: 'resolved',
        },
      } as never,
      compiled: makeMinimalCompiled(),
      results: [
        {
          entity: {
            entityId: 'e-1',
            canonicalLabel: 'Wine e-1',
            type: 'wine',
          },
          relevanceScore: 0.95,
          match: {
            matchType: 'exact',
            scoreComponents: {
              lexical: 1,
              semantic: 0,
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
            approximationUsed: false,
          },
          evidenceItems: [
            {
              type: 'retrieval',
              source: 'integration-test',
              contribution: '1.0',
              strength: 'high',
              provenance: 'integration-test:evidence',
            },
          ],
        },
      ] as never,
      auditExtension: {
        execution_trace: {
          effective_route: 'hybrid',
        },
      },
      executionContract: {
        executionTopology: 'dual_lane',
        effectiveRetrievalMode: 'attribute_search',
        retrievalKind: 'generic_hybrid',
        sparseExecuted: true,
        specializedRouteExecuted: null,
        usedCompiledExecution: true,
        laneTrace,
      },
      queryTimeMs: 12,
      route: 'hybrid',
      requestId: 'req-test',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'attribute_search',
    });

    expect(response.engineDecision.executionTopology).toBe('dual_lane');
    expect(response.engineDecision.laneTrace).toEqual(laneTrace);
    expect(response.meta.executionContract?.executionTopology).toBe('dual_lane');
    expect(response.meta.executionContract?.laneTrace).toEqual(laneTrace);
    expect(response.meta.auditExtension?.execution_trace?.execution_topology).toBe('dual_lane');
    expect(response.meta.auditExtension?.execution_trace?.lane_trace).toEqual(laneTrace);
  });

  it('does not project lane trace into the public response from audit payload alone', () => {
    const builder = new ResponseBuilder();
    const laneTrace = makeLaneTrace();

    const response = builder.build({
      decisionOutput: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        decisionConfidence: 0.95,
        confidenceSemantics: 'calibrated_decision_confidence',
        selectedEntity: {
          entityId: 'e-1',
          canonicalLabel: 'Wine e-1',
          identity_signature: 'sig-e-1',
          snapshot_ref: 'snap-1',
        },
        chosenEntityId: 'e-1',
        signalSet: {
          route: 'hybrid',
          retrievedCount: 1,
          rankedCount: 1,
        },
        evidenceItems: [
          {
            type: 'decision',
            source: 'integration-test',
            contribution: '1.0',
            strength: 'high',
            provenance: 'integration-test:decision',
          },
        ],
        decisionTraceRef: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        decisionSnapshot: {
          snapshot_id: 'snap-1',
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1.0.0',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
          response_contract_version: 'search_response_v1',
        },
        decisionTrace: {
          queryClass: 'pure_constraint',
          top1Score: 0.95,
          top2Score: 0.05,
          thresholdApplied: 0.5,
          marginApplied: 0.3,
          finalReason: 'resolved',
        },
      } as never,
      compiled: makeMinimalCompiled(),
      results: [
        {
          entity: {
            entityId: 'e-1',
            canonicalLabel: 'Wine e-1',
            type: 'wine',
          },
          relevanceScore: 0.95,
          match: {
            matchType: 'exact',
            scoreComponents: {
              lexical: 1,
              semantic: 0,
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
            approximationUsed: false,
          },
          evidenceItems: [
            {
              type: 'retrieval',
              source: 'integration-test',
              contribution: '1.0',
              strength: 'high',
              provenance: 'integration-test:evidence',
            },
          ],
        },
      ] as never,
      auditExtension: {
        execution_trace: {
          effective_route: 'hybrid',
          lane_trace: laneTrace,
        },
      },
      queryTimeMs: 12,
      route: 'hybrid',
      requestId: 'req-test',
      retrievalModeSource: 'planner',
      plannerSuggestedMode: 'attribute_search',
    });

    expect(response.engineDecision.laneTrace).toBeUndefined();
    expect(response.meta.executionContract).toBeUndefined();
    expect(response.meta.auditExtension?.execution_trace?.lane_trace).toEqual(laneTrace);
  });

  it('emits typed execution_trace.provenance_closure when ranking metadata carries compiled provenance closure', async () => {
    const rankingMetadata: RankingMetadata = {
      coarsePruneSummary: undefined,
      rerankExecuted: false,
      rerankGateReason: undefined,
      rerankDecision: undefined,
      runtimeSignal: undefined,
      preRerankTop5: ['e-1'],
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
          candidateCount: 5,
          identityEvidenceSatisfied: true,
          constraintEvidenceSatisfied: true,
          anchorEvidenceSatisfied: true,
          matchedConstraintAttributes: ['region'],
          unmetConstraintAttributes: [],
          anchorSignalTypes: [],
        },
        missing: [],
        satisfied: true,
      },
    };
    const ctx = makeBaseContext({ rankingMetadata });

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    expect(audit?.execution_trace?.provenance_closure).toBeDefined();
    expect(audit!.execution_trace!.provenance_closure!.satisfied).toBe(true);
    expect(audit!.execution_trace!.provenance_closure!.preRank.matchedConstraintAttributes).toEqual(['region']);
  });

  it('emits typed constraint_resolution_trace when planner trace is present and constraints produce relations', async () => {
    const ctx = makeBaseContext({
      plan: makeMinimalPlan({
        constraints: {
          hard: [
            {
              attribute: 'region',
              operator: '=',
              value: 'Bordeaux',
              source_phrase: '보르도',
              confidence: 0.99,
            },
            {
              attribute: 'region',
              operator: '=',
              value: 'Burgundy',
              source_phrase: '부르고뉴',
              confidence: 0.97,
            },
          ],
          soft: [],
          inferred: [],
        },
      }),
      compiled: makeMinimalCompiled({
        plannerTrace: [
          {
            stage: 'query_classification',
            inputFacts: { rawQuery: '보르도 부르고뉴' },
            rulesEvaluated: [],
            rejectedBranches: [],
            decision: 'pure_constraint',
            confidence: 0.95,
          },
        ],
      }),
    });

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    expect(audit?.constraint_resolution_trace).toBeDefined();
    expect(audit!.constraint_resolution_trace!.atoms).toHaveLength(2);
    expect(audit!.constraint_resolution_trace!.relations).toHaveLength(1);
    expect(audit!.constraint_resolution_trace!.relations[0]!.type).toBe('contradiction');
    expect(audit!.constraint_resolution_trace!.policy_outcomes.some((outcome) => outcome.outcome === 'dropped')).toBe(true);
  });

  it('emits retrieval_fusion_trace when retrievalFusionTrace is provided', async () => {
    const fusionTrace: RrfFusionTrace = {
      queryClass: 'pure_constraint',
      fusionClass: 'default',
      rrfK: 60,
      channelWeights: { sparse: 1, dense: 1, anchor: 0, learnedSparse: 0 },
      candidateCount: { sparse: 10, dense: 10, anchor: 0, learnedSparse: 0 },
    } as RrfFusionTrace;
    const compiled = makeMinimalCompiled({ plannerTrace: [{ stage: 'query_classification', inputFacts: {}, rulesEvaluated: [], rejectedBranches: [], decision: 'ok', confidence: 0.9 }] });
    const ctx = makeBaseContext({
      compiled,
      retrievalFusionTrace: fusionTrace,
    });

    await runRankedRouteDecisionPhase(ctx);

    const audit = getAuditExtensionFromBuildCall(ctx);
    expect(audit).toBeDefined();
    expect(audit?.retrieval_fusion_trace).toBeDefined();
    expect(audit!.retrieval_fusion_trace!.rrfK).toBe(60);
  });
});
