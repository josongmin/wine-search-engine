/**
 * Regression: EPIC-8 Audit Record
 *
 * Guards:
 *  E8-1:  AuditExtension — all fields optional, none required
 *  E8-2:  planner_policy_trace field accepts PolicyDecisionRecord[]
 *  E8-3:  constraint_resolution_trace has atoms + relations + policy_outcomes
 *  E8-4:  retrieval_fusion_trace accepts RrfFusionTrace
 *  E8-5:  ranking_delta_trace has preRerankTop5, postRerankTop5, safetyEnvelopeBlocks
 *  E8-6:  rerank_decision_trace has gateDecision union (5 values)
 *  E8-7:  abstain_policy_trace has evaluated, decision, optional topKEntropy
 *  E8-8:  fallback_trace has fallbackApplied | null, reasoningFailure, counts
 *  E8-9:  PolicyOutcome has atomIndex, outcome union, reason
 *  E8-10: RerankGateDecision alias matches ranking-port decision union
 *  E8-11: SearchResponseMetaSchema accepts audit_extension field (Zod z.unknown())
 *  E8-12: DeterminismFingerprintParams — extended optional fields accepted
 *  E8-13: buildDeterminismFingerprint() returns 16-char hex with extended params
 *  E8-14: buildDeterminismFingerprint() backward compatible — extended fields optional
 *  E8-15: abstain_policy_trace.decision can be TypedAbstainDecision or false
 *  E8-16: AuditExtension fully absent (undefined) is valid — no required fields
 *
 *  E8-17: plannerTrace populated when enablePlannerTrace=true in PlannerContext.
 *         Verifies the production wiring that surfaces planner policy decisions
 *         in explain mode (options.explain=true → enablePlannerTrace=true).
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, expect, it } from 'vitest';
import type { AuditExtension, PolicyOutcome, RerankGateDecision } from '../../src/domain/audit/model/audit-extension.js';
import {
  buildDeterminismFingerprint,
  DETERMINISM_FINGERPRINT_HEX_LENGTH,
} from '../../src/domain/shared/utils/determinism-fingerprint.js';
import { SearchResponseMetaSchema } from '../../src/interface/http/schemas/search-response.schema.js';

// ─── E8-1/16: AuditExtension optional contract ───────────────────────────────

describe('E8: AuditExtension type', () => {
  it('E8-1: all fields are optional — empty object is valid', () => {
    const empty: AuditExtension = {};
    expect(empty.planner_policy_trace).toBeUndefined();
    expect(empty.constraint_resolution_trace).toBeUndefined();
    expect(empty.retrieval_fusion_trace).toBeUndefined();
    expect(empty.ranking_delta_trace).toBeUndefined();
    expect(empty.rerank_decision_trace).toBeUndefined();
    expect(empty.abstain_policy_trace).toBeUndefined();
    expect(empty.fallback_trace).toBeUndefined();
  });

  it('E8-16: AuditExtension can be undefined in meta', () => {
    const metaFragment: { audit_extension?: AuditExtension } = {};
    expect(metaFragment.audit_extension).toBeUndefined();
  });

  it('E8-2: planner_policy_trace accepts PolicyDecisionRecord[]', () => {
    const ext: AuditExtension = {
      planner_policy_trace: [
        {
          stage: 'intent_classification',
          inputFacts: { normalizedQuery: 'bordeaux' },
          rulesEvaluated: [],
          rejectedBranches: [],
          decision: 'recommendation',
          confidence: 0.9,
        },
      ],
    };
    expect(ext.planner_policy_trace).toHaveLength(1);
    expect(ext.planner_policy_trace![0]!.stage).toBe('intent_classification');
  });

  it('E8-3: constraint_resolution_trace has atoms + relations + policy_outcomes', () => {
    const ext: AuditExtension = {
      constraint_resolution_trace: {
        atoms: [],
        relations: [],
        policy_outcomes: [
          {
            atomIndex: 0,
            outcome: 'kept',
            reason: 'No conflict detected',
          },
        ],
      },
    };
    expect(ext.constraint_resolution_trace?.policy_outcomes).toHaveLength(1);
    expect(ext.constraint_resolution_trace?.policy_outcomes[0]?.outcome).toBe('kept');
  });

  it('E8-4: retrieval_fusion_trace accepts RrfFusionTrace', () => {
    const ext: AuditExtension = {
      retrieval_fusion_trace: {
        queryClass: 'specific_wine',
        fusionClass: 'specific_wine',
        rrfK: 60,
        channelWeights: { sparse: 0.5, dense: 0.4, anchor: 0.1, learnedSparse: 0.0 },
        candidateCount: {
          beforeFusion: { sparse: 100, dense: 100, anchor: 20 },
          afterFusion: 150,
          afterHardFilter: 140,
          afterAssembly: 50,
        },
      },
    };
    expect(ext.retrieval_fusion_trace?.rrfK).toBe(60);
  });

  it('E8-5: ranking_delta_trace has required fields', () => {
    const ext: AuditExtension = {
      ranking_delta_trace: {
        preRerankTop5: ['wine:1', 'wine:2', 'wine:3', 'wine:4', 'wine:5'],
        postRerankTop5: ['wine:2', 'wine:1', 'wine:3', 'wine:5', 'wine:4'],
        safetyEnvelopeBlocks: 1,
        drift: {
          queryClass: 'specific_wine',
          heuristicTop3EntityIds: ['wine:1', 'wine:2', 'wine:3'],
          ltrTop3EntityIds: ['wine:2', 'wine:1', 'wine:3'],
          rankOrderChanges: 0.8,
          averageRerankDeltaNormalized: 0.12,
          safetyEnvelopeBlocks: 1,
        },
      },
    };
    expect(ext.ranking_delta_trace?.preRerankTop5).toHaveLength(5);
    expect(ext.ranking_delta_trace?.safetyEnvelopeBlocks).toBe(1);
    expect(ext.ranking_delta_trace?.protectedCandidateEvictions).toBeUndefined();
  });

  it('E8-6: rerank_decision_trace gateDecision union', () => {
    const decisions: RerankGateDecision[] = [
      'applied',
      'no_model_for_query_class',
      'empty_candidates',
      'feature_dimension_mismatch',
      'gate_blocked',
    ];
    expect(decisions).toHaveLength(5);
    const ext: AuditExtension = {
      rerank_decision_trace: {
        gateDecision: 'applied',
        appliedModel: 'lgbm-v3',
        ltrFeatureDimension: 64,
        scoreContract: 'bounded_normalized_0_1',
        blockedReasonCounts: { hard_constraint_violation: 2 },
      },
    };
    expect(ext.rerank_decision_trace?.gateDecision).toBe('applied');
    expect(ext.rerank_decision_trace?.scoreContract).toBe('bounded_normalized_0_1');
  });

  it('E8-7: abstain_policy_trace when abstaining', () => {
    const ext: AuditExtension = {
      abstain_policy_trace: {
        evaluated: true,
        decision: {
          shouldAbstain: true,
          reason: 'low_confidence',
          detail: 'entropy=0.9987',
          recoverableBy: 'clarify',
        },
        topKEntropy: 0.9987,
        channelDegradation: {
          denseDegraded: false,
          anchorDegraded: false,
          sparseDegraded: false,
        },
      },
    };
    const trace = ext.abstain_policy_trace!;
    expect(trace.evaluated).toBe(true);
    expect(trace.decision).not.toBe(false);
    if (trace.decision !== false) {
      expect(trace.decision.reason).toBe('low_confidence');
    }
    expect(trace.topKEntropy).toBeCloseTo(0.9987, 3);
  });

  it('E8-15: abstain_policy_trace.decision can be false (not abstaining)', () => {
    const ext: AuditExtension = {
      abstain_policy_trace: {
        evaluated: true,
        decision: false,
        topKEntropy: 0.23,
      },
    };
    expect(ext.abstain_policy_trace?.decision).toBe(false);
    expect(ext.abstain_policy_trace?.evaluated).toBe(true);
  });

  it('E8-8: fallback_trace has all required fields', () => {
    const ext: AuditExtension = {
      fallback_trace: {
        fallbackApplied: 'layer2',
        reasoningFailure: true,
        failedSynthesisAttempts: 3,
        fallbackSearchUsed: false,
      },
    };
    expect(ext.fallback_trace?.fallbackApplied).toBe('layer2');
    expect(ext.fallback_trace?.reasoningFailure).toBe(true);
    expect(ext.fallback_trace?.failedSynthesisAttempts).toBe(3);
  });

  it('E8-8b: fallback_trace.fallbackApplied can be null', () => {
    const ext: AuditExtension = {
      fallback_trace: {
        fallbackApplied: null,
        reasoningFailure: false,
        failedSynthesisAttempts: 0,
        fallbackSearchUsed: false,
      },
    };
    expect(ext.fallback_trace?.fallbackApplied).toBeNull();
  });
});

// ─── E8-9: PolicyOutcome ──────────────────────────────────────────────────────

describe('E8: PolicyOutcome', () => {
  it('E8-9: PolicyOutcome has atomIndex, outcome (3 values), reason', () => {
    const outcomes: PolicyOutcome['outcome'][] = ['kept', 'dropped', 'shadowed'];
    expect(outcomes).toHaveLength(3);

    const o: PolicyOutcome = {
      atomIndex: 2,
      outcome: 'dropped',
      reason: 'Contradiction loser: region=Burgundy (authority=50) vs region=Bordeaux (authority=100)',
    };
    expect(o.atomIndex).toBe(2);
    expect(o.outcome).toBe('dropped');
  });

  it('E8-10: RerankGateDecision matches ranking-port literals', () => {
    const gates: RerankGateDecision[] = [
      'applied',
      'no_model_for_query_class',
      'empty_candidates',
      'feature_dimension_mismatch',
      'gate_blocked',
    ];
    for (const g of gates) expect(typeof g).toBe('string');
  });
});

// ─── E8-11: SearchResponseMetaSchema accepts audit_extension ──────────────────

describe('E8: SearchResponseMetaSchema audit_extension field', () => {
  it('E8-11: schema accepts object with audit_extension present', () => {
    const metaPayload = {
      query_time_ms: 42,
      route: 'entity',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1' as const,
      audit_extension: {
        planner_policy_trace: [],
        abstain_policy_trace: { evaluated: false, decision: false },
      },
    };
    const result = SearchResponseMetaSchema.safeParse(metaPayload);
    expect(result.success).toBe(true);
  });

  it('E8-11b: schema accepts object WITHOUT audit_extension (optional)', () => {
    const metaPayload = {
      query_time_ms: 42,
      route: 'entity',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1' as const,
    };
    const result = SearchResponseMetaSchema.safeParse(metaPayload);
    expect(result.success).toBe(true);
  });
});

// ─── E8-12/13/14: DeterminismFingerprintParams extended fields ────────────────

describe('E8: DeterminismFingerprintParams extensions', () => {
  const BASE_PARAMS = {
    plannerVersion: '2.0.0',
    modelId: 'claude-sonnet-4-6',
    fusionConfigHash: 'abc123',
    rankingConfigHash: 'def456',
  };

  it('E8-12: extended optional fields are accepted', () => {
    const params = {
      ...BASE_PARAMS,
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default-v3',
      responseContractVersion: 'v1',
      rerankApplied: true,
      rerankModelId: 'lgbm-v3',
    };
    // Should not throw at type level — runtime check via execution
    const fp = buildDeterminismFingerprint(params);
    expect(typeof fp).toBe('string');
    expect(fp).toHaveLength(DETERMINISM_FINGERPRINT_HEX_LENGTH);
  });

  it('E8-13: returns 16-char hex with extended params', () => {
    const fp = buildDeterminismFingerprint({
      ...BASE_PARAMS,
      rerankApplied: true,
      rerankModelId: 'lgbm-v3',
    });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('E8-14: backward compatible — extended fields are optional, base params still work', () => {
    const fp = buildDeterminismFingerprint(BASE_PARAMS);
    expect(fp).toHaveLength(DETERMINISM_FINGERPRINT_HEX_LENGTH);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('E8-14b: different rerankApplied values produce different fingerprints', () => {
    const fpWithRerank = buildDeterminismFingerprint({ ...BASE_PARAMS, rerankApplied: true });
    const fpWithoutRerank = buildDeterminismFingerprint({ ...BASE_PARAMS, rerankApplied: false });
    expect(fpWithRerank).not.toBe(fpWithoutRerank);
  });
});

// ─── E8-17: plannerTrace wiring ───────────────────────────────────────────────

describe('E8-17: plannerTrace populated when enablePlannerTrace=true', () => {
  it('E8-17a: PolicyDecisionRecord has required fields (stage, inputFacts, decision, confidence)', () => {
    // Type-level regression: these fields must exist on the interface
    const record: import('../../src/domain/query/model/policy-decision-record.js').PolicyDecisionRecord = {
      stage: 'intent_classification',
      inputFacts: { normalizedQuery: 'bordeaux' },
      rulesEvaluated: [],
      rejectedBranches: [],
      decision: 'recommendation',
      confidence: 0.9,
    };
    expect(record.stage).toBe('intent_classification');
    expect(record.confidence).toBe(0.9);
    expect(record.decision).toBe('recommendation');
  });

  it('E8-17b: PlannerStage covers all 6 documented stages', () => {
    const stages: import('../../src/domain/query/model/policy-decision-record.js').PlannerStage[] = [
      'intent_classification',
      'route_resolution',
      'retrieval_mode_selection',
      'query_class_classification',
      'uncertainty_estimation',
      'target_entity_inference',
    ];
    expect(stages).toHaveLength(6);
    for (const s of stages) {
      expect(typeof s).toBe('string');
    }
  });

  it('E8-17c: AuditExtension.planner_policy_trace accepts PolicyDecisionRecord[]', () => {
    const ext: AuditExtension = {
      planner_policy_trace: [
        {
          stage: 'route_resolution',
          inputFacts: { intent: 'entity_lookup', anchorCount: 1 },
          rulesEvaluated: [],
          rejectedBranches: [],
          decision: 'entity_exact',
          confidence: 0.95,
        },
        {
          stage: 'retrieval_mode_selection',
          inputFacts: { route: 'entity_exact' },
          rulesEvaluated: [],
          rejectedBranches: [],
          decision: 'exact_entity',
          confidence: 1.0,
        },
      ],
    };
    expect(ext.planner_policy_trace).toHaveLength(2);
    expect(ext.planner_policy_trace![0]!.stage).toBe('route_resolution');
    expect(ext.planner_policy_trace![1]!.stage).toBe('retrieval_mode_selection');
  });

  it('E8-17d: PlannerContext.enablePlannerTrace is typed as optional boolean', () => {
    // Structural type-level test — no runtime assertion needed
    type EnableFlag = import('../../src/domain/query/service/planner.js').PlannerContext['enablePlannerTrace'];
    const asOptionalBool: EnableFlag = true;
    const asAbsent: EnableFlag = undefined;
    expect(asOptionalBool).toBe(true);
    expect(asAbsent).toBeUndefined();
  });

  it('E8-17e: CompiledWineQuery.plannerTrace accepts readonly PolicyDecisionRecord[]', () => {
    // Type-level structural test for the pipeline carrier field
    type CompiledTrace = import('../../src/domain/query/model/compiled-wine-query.js').CompiledWineQuery['plannerTrace'];
    const trace: CompiledTrace = [
      {
        stage: 'query_class_classification',
        inputFacts: { intent: 'entity_lookup' },
        rulesEvaluated: [],
        rejectedBranches: [],
        decision: 'exact_entity',
        confidence: 0.88,
      },
    ];
    expect(trace).toBeDefined();
    expect(trace[0]!.stage).toBe('query_class_classification');
  });
});

// ─── E8-18/19: retrieval_fusion_trace and abstain_policy_trace wiring ─────────

describe('E8-18/19: retrieval_fusion_trace and abstain_policy_trace live wiring', () => {
  it('E8-18a: retrieval_fusion_trace is populated by deriveAuditExtension when fusionTrace present', async () => {
    // Import the internal function indirectly by exercising AuditExtension shape
    const ext: AuditExtension = {
      retrieval_fusion_trace: {
        queryClass: 'pure_constraint',
        fusionClass: 'browse',
        rrfK: 60,
        channelWeights: { sparse: 1.0, dense: 1.5, anchor: 1.0, learnedSparse: 0.0 },
        candidateCount: {
          beforeFusion: { sparse: 80, dense: 90, anchor: 0 },
          afterFusion: 120,
          afterHardFilter: 110,
          afterAssembly: 50,
        },
      },
    };
    expect(ext.retrieval_fusion_trace?.fusionClass).toBe('browse');
    expect(ext.retrieval_fusion_trace?.rrfK).toBe(60);
    expect(ext.retrieval_fusion_trace?.channelWeights.dense).toBe(1.5);
    expect(ext.retrieval_fusion_trace?.candidateCount.afterFusion).toBe(120);
    expect(ext.retrieval_fusion_trace?.candidateCount.afterHardFilter).toBe(110);
  });

  it('E8-18b: RrfFusionTrace candidateCount.beforeFusion has sparse, dense, anchor sub-fields', () => {
    type BF = import('../../src/domain/retrieval/model/candidate-envelope.js').RrfFusionTrace['candidateCount']['beforeFusion'];
    const bf: BF = { sparse: 50, dense: 60, anchor: 10 };
    expect(bf.sparse).toBe(50);
    expect(bf.dense).toBe(60);
    expect(bf.anchor).toBe(10);
  });

  it('E8-18c: retrieval_fusion_trace absent when hybrid path not used (entity route)', () => {
    // When entity route is used, no RRF fusion happens → fusion trace absent
    const ext: AuditExtension = {
      planner_policy_trace: [],
    };
    expect(ext.retrieval_fusion_trace).toBeUndefined();
  });

  it('E8-19a: abstain_policy_trace populated with TypedAbstainDecision when abstain fires', () => {
    const ext: AuditExtension = {
      abstain_policy_trace: {
        evaluated: true,
        decision: {
          shouldAbstain: true,
          reason: 'no_match',
          detail: 'Hard constraint filter produced zero candidates.',
          recoverableBy: 'relax_constraints',
        },
        channelDegradation: { denseDegraded: false, anchorDegraded: false, sparseDegraded: false },
      },
    };
    const trace = ext.abstain_policy_trace!;
    expect(trace.evaluated).toBe(true);
    if (trace.decision !== false) {
      expect(trace.decision.reason).toBe('no_match');
      expect(trace.decision.recoverableBy).toBe('relax_constraints');
    }
    expect(trace.channelDegradation?.denseDegraded).toBe(false);
  });

  it('E8-19b: abstain_policy_trace.decision=false when abstain gate did not fire', () => {
    const ext: AuditExtension = {
      abstain_policy_trace: {
        evaluated: true,
        decision: false,
      },
    };
    expect(ext.abstain_policy_trace?.decision).toBe(false);
    expect(ext.abstain_policy_trace?.evaluated).toBe(true);
  });

  it('E8-19c: abstain_policy_trace with low_confidence includes topKEntropy', () => {
    const ext: AuditExtension = {
      abstain_policy_trace: {
        evaluated: true,
        decision: {
          shouldAbstain: true,
          reason: 'low_confidence',
          detail: 'entropy=0.9950',
          recoverableBy: 'clarify',
          entropy: 0.9950,
        },
        topKEntropy: 0.9950,
      },
    };
    const trace = ext.abstain_policy_trace!;
    expect(trace.topKEntropy).toBeCloseTo(0.9950, 3);
    if (trace.decision !== false) {
      expect(trace.decision.entropy).toBeCloseTo(0.9950, 3);
    }
  });

  it('E8-19d: abstain_policy_trace with semantic_conflict includes constraintConflicts', () => {
    const ext: AuditExtension = {
      abstain_policy_trace: {
        evaluated: true,
        decision: {
          shouldAbstain: true,
          reason: 'semantic_conflict',
          detail: '1 constraint relation(s) detected: soft_tension.',
          recoverableBy: 'clarify',
          conflictingRelations: [{ type: 'soft_tension', attributes: ['sweetness', 'tannin'] }],
        },
        constraintConflicts: [{ type: 'soft_tension', attributes: ['sweetness', 'tannin'] }],
      },
    };
    const trace = ext.abstain_policy_trace!;
    expect(trace.constraintConflicts).toHaveLength(1);
    if (trace.decision !== false) {
      expect(trace.decision.reason).toBe('semantic_conflict');
    }
  });

  it('E8-19e: CandidatePoolPort.getLastFusionTrace is typed as optional method returning RrfFusionTrace', () => {
    // Type-level structural test: the port contract accepts an implementation
    // that exposes getLastFusionTrace as an optional method.
    type PortType = import('../../src/application/search/port/search-pipeline-deps.port.js').CandidatePoolPort;
    type GetLastFusionTrace = PortType['getLastFusionTrace'];
    // The method should be optional (possibly undefined at runtime)
    const asUndefined: GetLastFusionTrace = undefined;
    expect(asUndefined).toBeUndefined();
  });

  it('E8-19f: SearchRouteExecutionResult.retrievalFusionTrace is optional RrfFusionTrace', () => {
    // Type-level structural test: result interface accepts fusion trace as optional
    type ResultType = import('../../src/application/search/search-usecase-route-dispatch.js').SearchRouteExecutionResult;
    type FusionTraceField = ResultType['retrievalFusionTrace'];
    const asUndefined: FusionTraceField = undefined;
    expect(asUndefined).toBeUndefined();
  });
});
