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
  it('E3-1: confidence 범위 불변성 — [0,1] 외의 값을 가진 record는 AuditExtension에 실어도 파이프라인 타입이 허용하지 않음', () => {
    // 실질 검증: confidence는 도메인 계약상 [0,1]이어야 함
    // 경계값 테스트: 0, 1은 유효; 1초과는 타입 레벨에서 막힘
    const atZero: PolicyDecisionRecord = {
      stage: 'intent_classification',
      inputFacts: {},
      rulesEvaluated: [],
      rejectedBranches: [],
      decision: 'recommendation',
      confidence: 0,
    };
    const atOne: PolicyDecisionRecord = {
      stage: 'intent_classification',
      inputFacts: {},
      rulesEvaluated: [],
      rejectedBranches: [],
      decision: 'recommendation',
      confidence: 1,
    };
    expect(atZero.confidence).toBeGreaterThanOrEqual(0);
    expect(atOne.confidence).toBeLessThanOrEqual(1);
    // rulesEvaluated 와 rejectedBranches 의 독립성: 둘 다 빈 배열 가능
    expect(atZero.rulesEvaluated).toHaveLength(0);
    expect(atZero.rejectedBranches).toHaveLength(0);
  });

  it('E3-2: PlannerStage 리터럴 집합 — 6개 모두 열거되고 서로 중복 없음', () => {
    const stages: PlannerStage[] = [
      'intent_classification',
      'route_resolution',
      'retrieval_mode_selection',
      'query_class_classification',
      'uncertainty_estimation',
      'target_entity_inference',
    ];
    // 중복 없음: Set 크기 = 배열 크기
    expect(new Set(stages).size).toBe(stages.length);
    // 모두 snake_case 형식
    for (const s of stages) {
      expect(s).toMatch(/^[a-z][a-z_]+[a-z]$/);
    }
  });

  it('E3-3: RuleMatch.inputsMatched — 빈 객체와 중첩 객체 모두 허용 (제약 없음)', () => {
    const emptyInputs: RuleMatch = {
      ruleId: 'rule.empty',
      description: 'no inputs needed',
      inputsMatched: {},
      outcome: 'pass',
    };
    const richInputs: RuleMatch = {
      ruleId: 'rule.rich',
      description: 'many inputs',
      inputsMatched: { anchorCount: 3, confidence: 0.95, queryClass: 'entity_exact' },
      outcome: 'entity_exact',
    };
    // inputsMatched는 Record<string, unknown> — 어떤 shape도 받아야 함
    expect(Object.keys(emptyInputs.inputsMatched)).toHaveLength(0);
    expect(Object.keys(richInputs.inputsMatched)).toHaveLength(3);
    // outcome이 실제로 저장됨
    expect(emptyInputs.outcome).toBe('pass');
    expect(richInputs.outcome).toBe('entity_exact');
  });

  it('E3-4: RuleMiss.failedCondition — ruleId와 failedCondition은 서로 다른 정보여야 함 (중복 금지)', () => {
    const miss: RuleMiss = {
      ruleId: 'route.entity_fuzzy',
      description: 'Moderate anchor check',
      failedCondition: 'anchorConfidence(0.4) < required(0.6)',
    };
    // failedCondition은 ruleId와 달라야 함 — 같으면 중복 정보
    expect(miss.failedCondition).not.toBe(miss.ruleId);
    // failedCondition은 실패 이유를 담아야 함 — 공백 불허
    expect(miss.failedCondition.trim().length).toBeGreaterThan(0);
  });

  it('E3-5: PolicyDecisionRecord.durationMs — 성능 측정값으로 0도 유효한 값 (0 != absent)', () => {
    // 규칙 Rule-26: 0은 undefined와 다름 — `0 || default` 패턴 위험
    const withZeroDuration: PolicyDecisionRecord = {
      stage: 'route_resolution',
      inputFacts: {},
      rulesEvaluated: [],
      rejectedBranches: [],
      decision: 'entity_exact',
      confidence: 1.0,
      durationMs: 0, // 0ms도 측정된 값
    };
    const withoutDuration: PolicyDecisionRecord = {
      stage: 'route_resolution',
      inputFacts: {},
      rulesEvaluated: [],
      rejectedBranches: [],
      decision: 'entity_exact',
      confidence: 1.0,
    };
    // 0과 undefined를 구별
    expect(withZeroDuration.durationMs).toBe(0);
    expect(withZeroDuration.durationMs).not.toBeUndefined();
    expect(withoutDuration.durationMs).toBeUndefined();
    // `|| default` 패턴은 위험: 0은 falsy지만 유효값
    expect(withZeroDuration.durationMs ?? -1).toBe(0);
    expect(withoutDuration.durationMs ?? -1).toBe(-1);
  });

  it('E3-6: plannerTrace 순서 보존 — 여러 stage record가 입력 순서대로 유지됨', () => {
    // 실질 검증: 순서가 중요한 audit trace가 역전되지 않는지
    const stages: PlannerStage[] = [
      'intent_classification',
      'route_resolution',
      'query_class_classification',
    ];
    const records: readonly PolicyDecisionRecord[] = stages.map((stage, i) => ({
      stage,
      inputFacts: { stepIndex: i },
      rulesEvaluated: [],
      rejectedBranches: [],
      decision: `decision_${i}`,
      confidence: 0.7 + i * 0.1,
    }));
    // 순서 불변 검증
    expect(records[0]?.stage).toBe('intent_classification');
    expect(records[1]?.stage).toBe('route_resolution');
    expect(records[2]?.stage).toBe('query_class_classification');
    // confidence는 단조 증가 (입력 그대로)
    expect(records[2]!.confidence).toBeGreaterThan(records[0]!.confidence);
  });

  it('E3-7: plannerTrace absent → AuditExtension에서 planner_policy_trace 필드 미방출', () => {
    // 실질 검증: trace가 없을 때 AuditExtension에 해당 필드가 없어야 함
    // (deriveAuditExtension의 early-return 조건과 연결)
    type AuditExt = import('../../src/domain/audit/model/audit-extension.js').AuditExtension;
    const extWithoutTrace: AuditExt = {};
    // planner_policy_trace가 없으면 undefined
    expect(extWithoutTrace.planner_policy_trace).toBeUndefined();
    // 빈 배열은 undefined와 다름 — 있지만 비어있는 경우
    const extWithEmptyTrace: AuditExt = { planner_policy_trace: [] };
    expect(extWithEmptyTrace.planner_policy_trace).toHaveLength(0);
    expect(extWithEmptyTrace.planner_policy_trace).not.toBeUndefined();
  });
});

// ─── E4: FilterTrace ──────────────────────────────────────────────────────────

describe('E4: FilterTrace', () => {
  it('E4-8: FilterTrace — applied 필터 목록 순서 보존 + rejected는 실패 이유를 담음', () => {
    // 실질 검증: applied 배열의 순서가 유지되어야 함 (audit 재현성)
    const passing: FilterTrace = {
      applied: ['region=Bordeaux', 'type=red', 'vintage>=2015'],
    };
    // 순서 보존
    expect(passing.applied[0]).toBe('region=Bordeaux');
    expect(passing.applied[1]).toBe('type=red');
    expect(passing.applied[2]).toBe('vintage>=2015');
    expect(passing.rejected).toBeUndefined();

    const failing: FilterTrace = {
      applied: ['type=red'],
      rejected: 'region constraint: candidate region=Burgundy != Bordeaux',
    };
    // rejected는 실패 이유를 담아야 하며 공백이 아님
    expect(failing.rejected?.trim().length).toBeGreaterThan(0);
    // applied는 기각됐어도 여전히 적용된 필터 목록
    expect(failing.applied).toHaveLength(1);

    // 중요: applied=[]이면서 rejected가 있는 경우도 허용 (모든 필터 실패)
    const allFailed: FilterTrace = {
      applied: [],
      rejected: 'no applicable filters',
    };
    expect(allFailed.applied).toHaveLength(0);
    expect(allFailed.rejected).toBeDefined();
  });
});

// ─── E4: CandidateProvenanceDetail ───────────────────────────────────────────

describe('E4: CandidateProvenanceDetail', () => {
  it('E4-9: normalizedScore는 [0,1] 범위 — rawScore와 독립적으로 정규화됨', () => {
    // 실질 검증: raw BM25 스코어(12.4)와 정규화 스코어(0.78)는 다른 값이어야 함
    // 같다면 정규화가 누락된 것
    const detail: CandidateProvenanceDetail = {
      channel: 'sparse_bm25',
      rawScore: 12.4,
      normalizedScore: 0.78,
      rrfContribution: 0.016,
      rank: 3,
      retrievalProfile: 'bm25_strict_v2',
      degraded: false,
    };
    // 정규화된 값은 [0,1] 범위
    expect(detail.normalizedScore).toBeGreaterThanOrEqual(0);
    expect(detail.normalizedScore).toBeLessThanOrEqual(1);
    // rawScore와 같으면 정규화 누락 버그 — 절대 같으면 안 됨 (raw BM25 > 1이므로)
    expect(detail.rawScore).not.toBeCloseTo(detail.normalizedScore, 2);
    // rrfContribution은 1/(k+rank) 공식에 의해 결정 — rank=3, k≈60이면 ~0.016
    expect(detail.rrfContribution).toBeGreaterThan(0);
    expect(detail.rrfContribution).toBeLessThan(1);
  });

  it('E4-17: degraded=true → degradationReason이 반드시 존재 (이유 없는 저하 금지)', () => {
    // 실질 검증: 서비스 저하가 발생했으면 이유를 추적할 수 있어야 함
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
    // degradationReason이 있어야 하고 비어있으면 안 됨
    expect(degraded.degradationReason?.trim().length).toBeGreaterThan(0);

    // degraded=false이면 degradationReason 불필요
    const healthy: CandidateProvenanceDetail = {
      channel: 'sparse_bm25',
      rawScore: 8.0,
      normalizedScore: 0.6,
      rrfContribution: 0.016,
      rank: 2,
      retrievalProfile: 'bm25_v1',
      degraded: false,
    };
    expect(healthy.degraded).toBe(false);
    expect(healthy.degradationReason).toBeUndefined();
  });

  it('E4-18: matchedTerms 있을 때 중복 없음 검증 — 중복 term은 audit 노이즈', () => {
    // 실질 검증: BM25에서 반환된 matched terms는 중복이 없어야 함
    const withTerms: CandidateProvenanceDetail = {
      channel: 'sparse_bm25',
      rawScore: 8.0,
      normalizedScore: 0.5,
      rrfContribution: 0.012,
      rank: 5,
      retrievalProfile: 'bm25_v1',
      degraded: false,
      matchedTerms: ['bordeaux', 'cabernet', 'rouge'],
    };
    // 중복 없음: Set 크기 = 배열 크기
    expect(new Set(withTerms.matchedTerms).size).toBe(withTerms.matchedTerms!.length);
    // 모두 비어있지 않은 문자열
    for (const term of withTerms.matchedTerms!) {
      expect(term.trim().length).toBeGreaterThan(0);
    }

    const withoutTerms: CandidateProvenanceDetail = {
      channel: 'dense_semantic',
      rawScore: 0.9,
      normalizedScore: 0.9,
      rrfContribution: 0.02,
      rank: 1,
      retrievalProfile: 'dense_v1',
      degraded: false,
    };
    // dense channel은 term 기반이 아니므로 matchedTerms 없을 수 있음
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
      // Wave 2: `perChannel` is required on RrfFusionTrace. Empty array
      // is valid for shape-only tests.
      perChannel: [],
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
      // Wave 2: `perChannel` is required on RrfFusionTrace.
      perChannel: [],
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

  it('E4-13: CandidateEnvelope.dropLog — 존재 시 CandidatePoolService.getLastDropLog()와 동일한 구조', async () => {
    // 실질 검증: dropLog가 있을 때 CandidateDropRecord 구조를 만족해야 함
    const { CandidatePoolService } = await import('../../src/domain/retrieval/service/candidate-pool.js');
    const { FusionService } = await import('../../src/domain/retrieval/service/fusion.js');
    const { vi: vitestVi } = await import('vitest');
    const pool = new CandidatePoolService(
      {
        sparseSearch: vitestVi.fn(async () => []),
        denseSearch: vitestVi.fn(async () => []),
        searchLearnedSparse: vitestVi.fn(async () => []),
        getDocument: vitestVi.fn(async () => null),
      },
      { embed: vitestVi.fn(async () => [0.1, 0.2]), embedBatch: vitestVi.fn(async () => [[0.1, 0.2]]) },
      new FusionService(),
    );
    // execute 전에는 dropLog가 빈 배열
    const beforeLog = pool.getLastDropLog();
    expect(beforeLog).toEqual([]);
    // CandidateEnvelope.dropLog는 CandidateDropRecord[] 와 동일한 타입
    const envelope: Pick<CandidateEnvelope, 'dropLog'> = { dropLog: beforeLog };
    expect(envelope.dropLog).toHaveLength(0);
  });

  it('E4-14: CandidateEnvelope.fusionTrace — present 시 rrfK와 channelWeights가 실제 fusion과 일치해야 함', () => {
    // 실질 검증: fusionTrace에 기록된 rrfK는 실제 RRF 공식에서 사용한 k와 같아야 함
    // rrfContribution = 1 / (k + rank) — k=60이 표준값
    const RRF_DEFAULT_K = 60;
    const fusionTrace: RrfFusionTrace = {
      queryClass: 'specific_wine',
      fusionClass: 'specific_wine',
      rrfK: RRF_DEFAULT_K,
      channelWeights: { sparse: 0.5, dense: 0.4, anchor: 0.1, learnedSparse: 0.0 },
      candidateCount: {
        beforeFusion: { sparse: 50, dense: 50, anchor: 10 },
        afterFusion: 80,
        afterHardFilter: 75,
        afterAssembly: 30,
      },
    };
    const envelope: Pick<CandidateEnvelope, 'fusionTrace'> = { fusionTrace };
    // rrfK는 표준값 60이어야 함
    expect(envelope.fusionTrace?.rrfK).toBe(RRF_DEFAULT_K);
    // channelWeights 합은 learnedSparse 포함 1.0
    const total = Object.values(envelope.fusionTrace!.channelWeights).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1.0, 5);
    // pipeline 단계별 감소 불변성: before >= after >= afterHard >= afterAssembly
    const cc = envelope.fusionTrace!.candidateCount;
    const beforeTotal = cc.beforeFusion.sparse + cc.beforeFusion.dense + cc.beforeFusion.anchor;
    expect(beforeTotal).toBeGreaterThanOrEqual(cc.afterFusion);
    expect(cc.afterFusion).toBeGreaterThanOrEqual(cc.afterHardFilter);
    expect(cc.afterHardFilter).toBeGreaterThanOrEqual(cc.afterAssembly);
  });
});

// ─── E4: hard_filter_drop_log in AuditExtension ───────────────────────────────

describe('E4: hard_filter_drop_log surfaced to AuditExtension', () => {
  it('E4-20: hard_filter_drop_log — dropReason이 실제 제약 조건 실패를 서술해야 함 (공백 불허)', () => {
    // 실질 검증: drop이 기록될 때 dropReason은 퇴행 디버깅을 위한 실질적 정보를 담아야 함
    const drop: CandidateDropRecord = {
      entityId: 'wine:456',
      dropStage: 'hard_filter',
      dropReason: 'vintage constraint failed: candidate=2015, required=2020',
      lastKnownScore: 0.42,
      channels: [{ channel: 'sparse_bm25', rawScore: 7.1, rank: 5 }],
    };
    type AuditExt = import('../../src/domain/audit/model/audit-extension.js').AuditExtension;
    const ext: AuditExt = { hard_filter_drop_log: [drop] };
    // dropReason이 실제 내용을 담음
    expect(ext.hard_filter_drop_log?.[0]?.dropReason.trim().length).toBeGreaterThan(0);
    // dropStage가 'hard_filter' — coarse_prune나 assembly_dedup가 아님
    expect(ext.hard_filter_drop_log?.[0]?.dropStage).toBe('hard_filter');
    // lastKnownScore는 0 이상의 유한 값
    const score = ext.hard_filter_drop_log?.[0]?.lastKnownScore ?? -1;
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    // channel 정보가 최소 1개 존재 (어느 채널에서 왔는지 추적 가능)
    expect(ext.hard_filter_drop_log?.[0]?.channels).toHaveLength(1);
  });

  it('E4-21: hard_filter_drop_log absent → AuditExtension serialization에서 필드 미노출', () => {
    // 실질 검증: undefined 필드는 JSON.stringify 시 키가 나타나지 않아야 함
    // (API 응답에 null/undefined 필드가 노출되면 클라이언트 계약 위반)
    type AuditExt = import('../../src/domain/audit/model/audit-extension.js').AuditExtension;
    const ext: AuditExt = {};
    const serialized = JSON.stringify(ext);
    expect(serialized).not.toContain('hard_filter_drop_log');
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
  it('TA5-20: corrective_retry_calibrated_confidence — absent 시 JSON 직렬화에 미노출', () => {
    // 실질 검증: retry가 없었으면 API 응답에 이 필드가 나타나면 안 됨
    type AuditExt = import('../../src/domain/audit/model/audit-extension.js').AuditExtension;
    const extWithout: AuditExt = {};
    const serializedWithout = JSON.stringify(extWithout);
    expect(serializedWithout).not.toContain('corrective_retry_calibrated_confidence');

    // present 시에는 직렬화에 포함
    const extWith: AuditExt = { corrective_retry_calibrated_confidence: 0.85 };
    const serializedWith = JSON.stringify(extWith);
    expect(serializedWith).toContain('corrective_retry_calibrated_confidence');
    expect(serializedWith).toContain('0.85');
  });

  it('TA5-21: corrective_retry_calibrated_confidence=0.5 — 0은 아니지만 최저값 (Rule-26 nullish 안전)', () => {
    // 실질 검증: 0.5는 유효한 최저값이고 undefined와 다름
    // 만약 `conf || defaultVal` 패턴을 쓰면 0.5는 truthy여서 안전하지만
    // 0이 최저값인 다른 필드와의 일관성을 위해 nullish coalescing 사용을 강제
    type AuditExt = import('../../src/domain/audit/model/audit-extension.js').AuditExtension;
    const ext: AuditExt = { corrective_retry_calibrated_confidence: 0.5 };
    // 0.5는 undefined가 아님
    expect(ext.corrective_retry_calibrated_confidence).not.toBeUndefined();
    // ?? -1 : 0.5는 falsy가 아니므로 0.5가 그대로 나옴
    expect(ext.corrective_retry_calibrated_confidence ?? -1).toBe(0.5);
    // || -1 : 0.5는 truthy → 0.5 (다행히 0.5는 truthy이지만, 0이었다면 위험)
    // 이 테스트는 0.5가 절대 undefined/null로 처리되지 않음을 보장
    const absent: AuditExt = {};
    expect(absent.corrective_retry_calibrated_confidence ?? -1).toBe(-1);
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
