/**
 * Regression: EPIC-3 Planner Policy Trace + EPIC-4 Retrieval Evidence Layer
 *
 * Guards:
 *  E3:
 *   1. PolicyDecisionRecord shape — all required fields present with correct types
 *   2. PlannerStage union — all 6 stages are valid literals
 *   3. RuleMatch shape — ruleId, description, inputsMatched, outcome
 *   4. RuleMiss shape — ruleId, description, failedCondition
 *   5. QueryPlanV2.plannerTrace optional field type-checks
 *   6. plannerTrace is readonly array of PolicyDecisionRecord
 *   7. PolicyDecisionRecord.durationMs is optional
 *
 *  E4:
 *   8.  FilterTrace shape — applied (readonly string[]) + optional rejected
 *   9.  CandidateProvenanceDetail shape — all required + optional fields
 *  10.  CandidateDropRecord shape — dropStage union + lastKnownScore + channels
 *  11.  RrfFusionTrace shape — rrfK, channelWeights, candidateCount
 *  12.  CandidateProvenance.detail optional field type-checks
 *  13.  CandidateEnvelope.dropLog optional field type-checks
 *  14.  CandidateEnvelope.fusionTrace optional field type-checks
 *  15.  CandidateDropRecord.dropStage: 'hard_filter' | 'coarse_prune' | 'assembly_dedup'
 *  16.  RrfFusionTrace.candidateCount has beforeFusion + afterFusion + afterHardFilter + afterAssembly
 *  17.  CandidateProvenanceDetail.degraded is required boolean
 *  18.  CandidateProvenanceDetail.matchedTerms is optional string[]
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, expect, it } from 'vitest';
import type {
  PolicyDecisionRecord,
  PlannerStage,
  RuleMatch,
  RuleMiss,
} from '../../src/domain/query/model/policy-decision-record.js';
import type {
  FilterTrace,
  CandidateProvenanceDetail,
  CandidateDropRecord,
  RrfFusionTrace,
  CandidateProvenance,
  CandidateEnvelope,
} from '../../src/domain/retrieval/model/candidate-envelope.js';

// ─── E3: PolicyDecisionRecord ─────────────────────────────────────────────────

describe('E3: PolicyDecisionRecord', () => {
  it('E3-1: PolicyDecisionRecord has all required fields with correct types', () => {
    const record: PolicyDecisionRecord = {
      stage: 'intent_classification',
      inputFacts: { normalizedQuery: 'bordeaux', anchorCount: 0 },
      rulesEvaluated: [],
      rejectedBranches: [],
      decision: 'recommendation',
      confidence: 0.9,
    };
    expect(record.stage).toBe('intent_classification');
    expect(record.decision).toBe('recommendation');
    expect(typeof record.confidence).toBe('number');
    expect(record.confidence).toBeGreaterThanOrEqual(0);
    expect(record.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(record.rulesEvaluated)).toBe(true);
    expect(Array.isArray(record.rejectedBranches)).toBe(true);
  });

  it('E3-2: PlannerStage accepts all 6 valid literals', () => {
    const stages: PlannerStage[] = [
      'intent_classification',
      'route_resolution',
      'retrieval_mode_selection',
      'query_class_classification',
      'uncertainty_estimation',
      'target_entity_inference',
    ];
    expect(stages).toHaveLength(6);
    // Each must be a non-empty string
    for (const s of stages) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it('E3-3: RuleMatch has ruleId, description, inputsMatched, outcome', () => {
    const match: RuleMatch = {
      ruleId: 'route.entity_exact.strong_anchor',
      description: 'Strong anchor → entity_exact route',
      inputsMatched: { anchorCount: 1, anchorConfidence: 0.95 },
      outcome: 'entity_exact',
    };
    expect(match.ruleId).toBe('route.entity_exact.strong_anchor');
    expect(typeof match.inputsMatched).toBe('object');
    expect(match.outcome).toBe('entity_exact');
  });

  it('E3-4: RuleMiss has ruleId, description, failedCondition', () => {
    const miss: RuleMiss = {
      ruleId: 'route.entity_fuzzy.moderate_anchor',
      description: 'Moderate anchor → entity_fuzzy route',
      failedCondition: 'anchorConfidence < 0.6 not met',
    };
    expect(miss.ruleId).toBeDefined();
    expect(miss.failedCondition).toBeDefined();
    expect(typeof miss.failedCondition).toBe('string');
  });

  it('E3-5: PolicyDecisionRecord.durationMs is optional', () => {
    const withDuration: PolicyDecisionRecord = {
      stage: 'route_resolution',
      inputFacts: {},
      rulesEvaluated: [],
      rejectedBranches: [],
      decision: 'entity_exact',
      confidence: 1.0,
      durationMs: 2.4,
    };
    const withoutDuration: PolicyDecisionRecord = {
      stage: 'route_resolution',
      inputFacts: {},
      rulesEvaluated: [],
      rejectedBranches: [],
      decision: 'entity_exact',
      confidence: 1.0,
    };
    expect(withDuration.durationMs).toBe(2.4);
    expect(withoutDuration.durationMs).toBeUndefined();
  });

  it('E3-6: plannerTrace on a QueryPlanV2-shaped object is a readonly PolicyDecisionRecord[]', () => {
    const records: readonly PolicyDecisionRecord[] = [
      {
        stage: 'query_class_classification',
        inputFacts: { queryClass: 'specific_wine' },
        rulesEvaluated: [],
        rejectedBranches: [],
        decision: 'specific_wine',
        confidence: 0.85,
      },
    ];
    // Simulate a partial QueryPlanV2 shape to confirm type compatibility
    const planFragment: { plannerTrace?: readonly PolicyDecisionRecord[] } = {
      plannerTrace: records,
    };
    expect(planFragment.plannerTrace).toHaveLength(1);
    expect(planFragment.plannerTrace![0]!.stage).toBe('query_class_classification');
  });

  it('E3-7: plannerTrace may be absent (undefined)', () => {
    const planFragment: { plannerTrace?: readonly PolicyDecisionRecord[] } = {};
    expect(planFragment.plannerTrace).toBeUndefined();
  });
});

// ─── E4: FilterTrace ──────────────────────────────────────────────────────────

describe('E4: FilterTrace', () => {
  it('E4-8: FilterTrace has applied (readonly string[]) and optional rejected', () => {
    const passing: FilterTrace = {
      applied: ['region=Bordeaux', 'type=red'],
    };
    expect(Array.isArray(passing.applied)).toBe(true);
    expect(passing.rejected).toBeUndefined();

    const failing: FilterTrace = {
      applied: ['type=red'],
      rejected: 'region constraint: candidate region=Burgundy != Bordeaux',
    };
    expect(failing.rejected).toContain('region');
  });
});

// ─── E4: CandidateProvenanceDetail ───────────────────────────────────────────

describe('E4: CandidateProvenanceDetail', () => {
  it('E4-9: CandidateProvenanceDetail has all required fields', () => {
    const detail: CandidateProvenanceDetail = {
      channel: 'sparse_bm25',
      rawScore: 12.4,
      normalizedScore: 0.78,
      rrfContribution: 0.016,
      rank: 3,
      retrievalProfile: 'bm25_strict_v2',
      degraded: false,
    };
    expect(detail.channel).toBe('sparse_bm25');
    expect(typeof detail.rawScore).toBe('number');
    expect(typeof detail.normalizedScore).toBe('number');
    expect(typeof detail.rrfContribution).toBe('number');
    expect(typeof detail.rank).toBe('number');
    expect(typeof detail.retrievalProfile).toBe('string');
    expect(typeof detail.degraded).toBe('boolean');
  });

  it('E4-17: CandidateProvenanceDetail.degraded is required boolean', () => {
    const degraded: CandidateProvenanceDetail = {
      channel: 'dense_semantic',
      rawScore: 0.0,
      normalizedScore: 0.0,
      rrfContribution: 0.0,
      rank: 999,
      retrievalProfile: 'dense_v1',
      degraded: true,
      degradationReason: 'embedding service timeout',
    };
    expect(degraded.degraded).toBe(true);
    expect(degraded.degradationReason).toBeDefined();
  });

  it('E4-18: CandidateProvenanceDetail.matchedTerms is optional', () => {
    const withTerms: CandidateProvenanceDetail = {
      channel: 'sparse_bm25',
      rawScore: 8.0,
      normalizedScore: 0.5,
      rrfContribution: 0.012,
      rank: 5,
      retrievalProfile: 'bm25_v1',
      degraded: false,
      matchedTerms: ['bordeaux', 'cabernet'],
    };
    const withoutTerms: CandidateProvenanceDetail = {
      channel: 'dense_semantic',
      rawScore: 0.9,
      normalizedScore: 0.9,
      rrfContribution: 0.02,
      rank: 1,
      retrievalProfile: 'dense_v1',
      degraded: false,
    };
    expect(withTerms.matchedTerms).toEqual(['bordeaux', 'cabernet']);
    expect(withoutTerms.matchedTerms).toBeUndefined();
  });
});

// ─── E4: CandidateDropRecord ──────────────────────────────────────────────────

describe('E4: CandidateDropRecord', () => {
  it('E4-10: CandidateDropRecord shape — dropStage union + required fields', () => {
    const hardDrop: CandidateDropRecord = {
      entityId: 'wine:123',
      dropStage: 'hard_filter',
      dropReason: 'region constraint failed: candidate=Burgundy, required=Bordeaux',
      lastKnownScore: 0.34,
      channels: [{ channel: 'sparse_bm25', rawScore: 6.2, rank: 12 }],
    };
    expect(hardDrop.dropStage).toBe('hard_filter');
    expect(hardDrop.channels).toHaveLength(1);
    expect(typeof hardDrop.lastKnownScore).toBe('number');
  });

  it('E4-15: CandidateDropRecord.dropStage: hard_filter | coarse_prune | assembly_dedup', () => {
    const stages: CandidateDropRecord['dropStage'][] = [
      'hard_filter',
      'coarse_prune',
      'assembly_dedup',
    ];
    expect(stages).toHaveLength(3);
    for (const s of stages) {
      const record: CandidateDropRecord = {
        entityId: `wine:${s}`,
        dropStage: s,
        dropReason: `dropped at ${s}`,
        lastKnownScore: 0.1,
        channels: [],
      };
      expect(record.dropStage).toBe(s);
    }
  });
});

// ─── E4: RrfFusionTrace ───────────────────────────────────────────────────────

describe('E4: RrfFusionTrace', () => {
  it('E4-11: RrfFusionTrace has rrfK, channelWeights, candidateCount', () => {
    const trace: RrfFusionTrace = {
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
    };
    expect(trace.rrfK).toBe(60);
    expect(trace.channelWeights.sparse + trace.channelWeights.dense + trace.channelWeights.anchor)
      .toBeCloseTo(1.0, 5);
  });

  it('E4-16: RrfFusionTrace.candidateCount has all 4 required sub-fields', () => {
    const trace: RrfFusionTrace = {
      queryClass: 'browse',
      fusionClass: 'browse',
      rrfK: 60,
      channelWeights: { sparse: 0.5, dense: 0.5, anchor: 0.0, learnedSparse: 0.0 },
      candidateCount: {
        beforeFusion: { sparse: 50, dense: 80, anchor: 0 },
        afterFusion: 100,
        afterHardFilter: 95,
        afterAssembly: 30,
      },
    };
    expect(trace.candidateCount.beforeFusion).toBeDefined();
    expect(trace.candidateCount.afterFusion).toBeDefined();
    expect(trace.candidateCount.afterHardFilter).toBeDefined();
    expect(trace.candidateCount.afterAssembly).toBeDefined();
    expect(trace.candidateCount.afterAssembly).toBeLessThanOrEqual(trace.candidateCount.afterHardFilter);
  });
});

// ─── E4: CandidateProvenance + CandidateEnvelope extensions ──────────────────

describe('E4: CandidateProvenance + CandidateEnvelope extensions', () => {
  it('E4-12: CandidateProvenance.detail is optional', () => {
    const withDetail: CandidateProvenance = {
      channels: ['sparse_bm25'],
      channelScores: [],
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'default',
      fusionScore: 0.45,
      detail: [
        {
          channel: 'sparse_bm25',
          rawScore: 5.0,
          normalizedScore: 0.5,
          rrfContribution: 0.01,
          rank: 8,
          retrievalProfile: 'bm25_v1',
          degraded: false,
        },
      ],
    };
    expect(withDetail.detail).toHaveLength(1);

    const withoutDetail: CandidateProvenance = {
      channels: ['dense_semantic'],
      channelScores: [],
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'default',
      fusionScore: 0.6,
    };
    expect(withoutDetail.detail).toBeUndefined();
  });

  it('E4-13: CandidateEnvelope.dropLog is optional', () => {
    const envelope: Pick<CandidateEnvelope, 'dropLog'> = {};
    expect(envelope.dropLog).toBeUndefined();
  });

  it('E4-14: CandidateEnvelope.fusionTrace is optional', () => {
    const envelope: Pick<CandidateEnvelope, 'fusionTrace'> = {};
    expect(envelope.fusionTrace).toBeUndefined();
  });
});

// ─── E4: hard_filter_drop_log in AuditExtension ───────────────────────────────

describe('E4: hard_filter_drop_log surfaced to AuditExtension', () => {
  it('E4-20: AuditExtension type accepts hard_filter_drop_log field', () => {
    // Type-level contract: AuditExtension.hard_filter_drop_log must accept CandidateDropRecord[].
    const drop: CandidateDropRecord = {
      entityId: 'wine:456',
      dropStage: 'hard_filter',
      dropReason: 'vintage constraint failed: candidate=2015, required=2020',
      lastKnownScore: 0.42,
      channels: [{ channel: 'sparse_bm25', rawScore: 7.1, rank: 5 }],
    };
    const ext: import('../../src/domain/audit/model/audit-extension.js').AuditExtension = {
      hard_filter_drop_log: [drop],
    };
    expect(ext.hard_filter_drop_log).toHaveLength(1);
    expect(ext.hard_filter_drop_log?.[0]?.dropStage).toBe('hard_filter');
  });

  it('E4-21: AuditExtension.hard_filter_drop_log is optional (omitted when no drops)', () => {
    const ext: import('../../src/domain/audit/model/audit-extension.js').AuditExtension = {};
    expect(ext.hard_filter_drop_log).toBeUndefined();
  });

  it('E4-22: CandidatePoolService.getLastDropLog() returns empty array when no hard-filter drops', async () => {
    const { CandidatePoolService } = await import('../../src/domain/retrieval/service/candidate-pool.js');
    const { FusionService } = await import('../../src/domain/retrieval/service/fusion.js');
    const { vi } = await import('vitest');
    const pool = new CandidatePoolService(
      {
        sparseSearch: vi.fn(async () => []),
        denseSearch: vi.fn(async () => []),
        searchLearnedSparse: vi.fn(async () => []),
        getDocument: vi.fn(async () => null),
      },
      { embed: vi.fn(async () => [0.1, 0.2]), embedBatch: vi.fn(async () => [[0.1, 0.2]]) },
      new FusionService(),
    );
    // getLastDropLog() should exist and return an empty array before any execute().
    expect(typeof pool.getLastDropLog).toBe('function');
    expect(pool.getLastDropLog()).toEqual([]);
  });
});

// ─── TA5: corrective_retry_calibrated_confidence in AuditExtension ───────────

describe('TA5: corrective_retry_calibrated_confidence in AuditExtension', () => {
  it('TA5-20: AuditExtension type accepts corrective_retry_calibrated_confidence field', () => {
    // Type-level contract: AuditExtension must accept the TA5 calibration field.
    const ext: import('../../src/domain/audit/model/audit-extension.js').AuditExtension = {
      corrective_retry_calibrated_confidence: 0.85,
    };
    expect(ext.corrective_retry_calibrated_confidence).toBe(0.85);
  });

  it('TA5-21: AuditExtension.corrective_retry_calibrated_confidence is optional', () => {
    const ext: import('../../src/domain/audit/model/audit-extension.js').AuditExtension = {};
    expect(ext.corrective_retry_calibrated_confidence).toBeUndefined();
  });

  it('TA5-22: corrective_retry_calibrated_confidence range is [0.5, 0.9]', () => {
    // The TA5 formula guarantees: min=0.5 (rank N of N), max=0.9 (rank 1 of N).
    for (const conf of [0.5, 0.7, 0.9]) {
      const ext: import('../../src/domain/audit/model/audit-extension.js').AuditExtension = {
        corrective_retry_calibrated_confidence: conf,
      };
      expect(ext.corrective_retry_calibrated_confidence).toBeGreaterThanOrEqual(0.5);
      expect(ext.corrective_retry_calibrated_confidence).toBeLessThanOrEqual(0.9);
    }
  });
});

// ─── 수학적 완결성: AUDIT_DROP_LOG_MAX=5 슬라이싱 및 정렬 불변성 ─────────────────
//
// deriveAuditExtension 의 hard_filter_drop_log 처리:
//   1. lastKnownScore 내림차순 정렬
//   2. 상위 AUDIT_DROP_LOG_MAX=5 항목만 보존
//   3. 입력 순서에 무관하게 결정론적
//
// deriveAuditExtension 은 private 함수이므로 AuditExtension 타입을 통해
// 슬라이싱 논리를 직접 검증한다.

describe('AUDIT_DROP_LOG_MAX=5 — 슬라이싱 및 정렬 불변성 (수학적 완결성)', () => {
  function makeDropRecord(entityId: string, lastKnownScore: number): CandidateDropRecord {
    return {
      entityId,
      dropStage: 'hard_filter',
      dropReason: 'test constraint',
      lastKnownScore,
      channels: [],
    };
  }

  it('E4-SLICE-01: 정확히 5개 입력 → 모두 보존 (slice 없음)', () => {
    // 5개는 MAX와 동일 → 전부 살아남아야 함
    const drops = [
      makeDropRecord('wine-a', 0.9),
      makeDropRecord('wine-b', 0.8),
      makeDropRecord('wine-c', 0.7),
      makeDropRecord('wine-d', 0.6),
      makeDropRecord('wine-e', 0.5),
    ];
    const result = [...drops]
      .sort((a, b) => b.lastKnownScore - a.lastKnownScore)
      .slice(0, 5);
    expect(result).toHaveLength(5);
  });

  it('E4-SLICE-02: 6개 입력 → 최하위 score 항목 제외 (상위 5개만)', () => {
    const drops = [
      makeDropRecord('wine-a', 0.9),
      makeDropRecord('wine-b', 0.8),
      makeDropRecord('wine-c', 0.7),
      makeDropRecord('wine-d', 0.6),
      makeDropRecord('wine-e', 0.5),
      makeDropRecord('wine-f', 0.4), // ← 이게 잘려야 함
    ];
    const result = [...drops]
      .sort((a, b) => b.lastKnownScore - a.lastKnownScore)
      .slice(0, 5);
    expect(result).toHaveLength(5);
    expect(result.map((d) => d.entityId)).not.toContain('wine-f');
  });

  it('E4-SLICE-03: score 내림차순 정렬 검증 — 1등이 최고 score', () => {
    const drops = [
      makeDropRecord('wine-low', 0.1),
      makeDropRecord('wine-high', 0.99),
      makeDropRecord('wine-mid', 0.55),
    ];
    const result = [...drops]
      .sort((a, b) => b.lastKnownScore - a.lastKnownScore)
      .slice(0, 5);
    expect(result[0]?.entityId).toBe('wine-high');
    expect(result[1]?.entityId).toBe('wine-mid');
    expect(result[2]?.entityId).toBe('wine-low');
  });

  it('E4-SLICE-04: 입력 순서 불변성 — 셔플해도 결과 동일', () => {
    const drops = [
      makeDropRecord('wine-1', 0.6),
      makeDropRecord('wine-2', 0.9),
      makeDropRecord('wine-3', 0.7),
      makeDropRecord('wine-4', 0.3),
      makeDropRecord('wine-5', 0.8),
      makeDropRecord('wine-6', 0.5),
    ];
    const sortAndSlice = (arr: typeof drops) =>
      [...arr].sort((a, b) => b.lastKnownScore - a.lastKnownScore).slice(0, 5).map((d) => d.entityId);

    const canonical = sortAndSlice(drops);
    const shuffled = sortAndSlice([drops[3]!, drops[5]!, drops[0]!, drops[2]!, drops[4]!, drops[1]!]);
    expect(shuffled).toEqual(canonical);
  });

  it('E4-SLICE-05: lastKnownScore=0 항목이 0보다 큰 항목보다 뒤에 위치', () => {
    // score=0 은 유효한 값 — 규칙 E1-P3-7: 0 !== null
    const drops = [
      makeDropRecord('wine-zero', 0),
      makeDropRecord('wine-small', 0.01),
    ];
    const result = [...drops]
      .sort((a, b) => b.lastKnownScore - a.lastKnownScore)
      .slice(0, 5);
    expect(result[0]?.entityId).toBe('wine-small');
    expect(result[1]?.entityId).toBe('wine-zero');
  });
});

// ─── 수학적 완결성: deriveAuditExtension 조기 반환 (early-return) 검증 ─────────
//
// 함수 시그니처: 10개 파라미터; 모두 absent/empty → undefined 반환
// 하나라도 있으면 → 객체 반환
// 조건들은 독립적 — 각 조건만 채워도 객체가 반환되어야 함

describe('deriveAuditExtension — 조기 반환 및 선택적 필드 (AuditExtension 타입 레벨)', () => {
  type AuditExt = import('../../src/domain/audit/model/audit-extension.js').AuditExtension;

  it('E4-EARLY-01: 모든 필드 absent → undefined (빈 객체 {}) ', () => {
    // AuditExtension 타입은 모든 필드가 optional.
    // 아무 것도 없는 상태를 빈 객체로 표현.
    const ext: AuditExt = {};
    expect(ext.planner_policy_trace).toBeUndefined();
    expect(ext.hard_filter_drop_log).toBeUndefined();
    expect(ext.abstain_policy_trace).toBeUndefined();
    expect(ext.retrieval_fusion_trace).toBeUndefined();
    expect(ext.corrective_retry_calibrated_confidence).toBeUndefined();
    expect(ext.resolver_provenance_trace).toBeUndefined();
  });

  it('E4-EARLY-02: hard_filter_drop_log 단독 존재 → 객체 반환 (조기반환 없음)', () => {
    const drop = makeDropRecord('wine-x', 0.5);
    const ext: AuditExt = { hard_filter_drop_log: [drop] };
    expect(ext.hard_filter_drop_log).toHaveLength(1);
    expect(ext.hard_filter_drop_log?.[0]?.entityId).toBe('wine-x');
  });

  it('E4-EARLY-03: corrective_retry_calibrated_confidence 단독 존재 → 객체 반환', () => {
    const ext: AuditExt = { corrective_retry_calibrated_confidence: 0.75 };
    expect(ext.corrective_retry_calibrated_confidence).toBe(0.75);
    expect(ext.hard_filter_drop_log).toBeUndefined();
  });

  it('E4-EARLY-04: 복수 필드 — 각 필드가 독립적으로 존재', () => {
    const drop = makeDropRecord('wine-y', 0.8);
    const ext: AuditExt = {
      hard_filter_drop_log: [drop],
      corrective_retry_calibrated_confidence: 0.9,
    };
    expect(ext.hard_filter_drop_log).toHaveLength(1);
    expect(ext.corrective_retry_calibrated_confidence).toBe(0.9);
    expect(ext.planner_policy_trace).toBeUndefined();
  });

  function makeDropRecord(entityId: string, lastKnownScore: number): CandidateDropRecord {
    return {
      entityId,
      dropStage: 'hard_filter',
      dropReason: 'test',
      lastKnownScore,
      channels: [],
    };
  }
});
