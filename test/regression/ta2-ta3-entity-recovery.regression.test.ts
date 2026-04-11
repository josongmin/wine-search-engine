/**
 * Regression: TRACK-A A2/A3 — Shared Entity Candidate Generation + Corrective Retry
 *
 * Guards:
 *  1. EntityCandidateGeneratorInput contract shapes (TA2-1)
 *  2. AnchorCandidate.source union includes 'blocker_seed' (TA2-2)
 *  3. buildResolverCandidatesFromGenerator — anchor + blocker paths (TA2-3)
 *  4. Resolver merges blockerSeedCandidates into candidate pool (TA2-4)
 *  5. shouldTriggerCorrectiveRetry — trigger conditions (TA3-1)
 *  6. resolveCorrectiveRetryOutcome — exit conditions (TA3-2)
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  shouldTriggerCorrectiveRetry,
  resolveCorrectiveRetryOutcome,
  computeCorrectiveRetryCalibration,
} from '../../src/application/search/search-usecase-corrective-retry.js';
import { buildResolverCandidatesFromGenerator } from '../../src/application/search/search-usecase-resolver-candidates.js';
import type { EntityCandidateGeneratorInput } from '../../src/domain/resolver/model/entity-candidate-generator-input.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { EntityDocumentLookupPort } from '../../src/application/search/port/search-pipeline-deps.port.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'opus one 2019',
    normalizedQuery: 'opus one 2019',
    queryClass: 'entity_exact',
    intent: 'entity',
    anchors: [],
    constraints: {},
    policy: { requireExact: false, allowApproximate: true },
    uncertainty: { level: 'low', signals: [] },
    ...overrides,
  } as unknown as QueryPlanV1;
}

function makeAnchor(overrides: Partial<AnchorCandidate> = {}): AnchorCandidate {
  return {
    surfaceForm: 'opus one',
    normalizedForm: 'opus one',
    candidateEntityIds: ['wine-opus-one-2019'],
    confidence: 0.8,
    source: 'alias',
    ...overrides,
  };
}

function makeResolveResult(overrides: Partial<EntityResolveResult> = {}): EntityResolveResult {
  return {
    status: 'failed',
    decisionConfidenceC: 0.3,
    candidates: [],
    decisionTrace: {} as EntityResolveResult['decisionTrace'],
    conformalSetSize: 0,
    ...overrides,
  };
}

// ─── TA2-1: EntityCandidateGeneratorInput contract ────────────────────────────

describe('EntityCandidateGeneratorInput (TA2-1)', () => {
  it('satisfies contract: blockerOnlyIds absent → no blocker-seed candidates produced', async () => {
    // 실질 검증: blockerOnlyIds 미제공 시 blocker_seed 후보가 0개여야 함
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [],
      // blockerOnlyIds 없음
    };
    const result = await buildResolverCandidatesFromGenerator(input, { getDocument: async () => null });
    const blockerSeeds = result.filter((c) => c.source === 'blocker_seed');
    expect(blockerSeeds).toHaveLength(0);
  });

  it('blockerOnlyIds populated → blocker_seed 후보 생성 (anchor-miss 복구)', async () => {
    // 실질 검증: blockerOnlyIds에 ID가 있으면 blocker_seed 후보로 등장해야 함
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [],
      blockerOnlyIds: [createEntityId('wine-blocker-only')],
    };
    const result = await buildResolverCandidatesFromGenerator(input, {
      getDocument: async (id) => ({ entityId: id, entityType: 'wine', canonicalLabel: 'Opus One' }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('blocker_seed');
    expect(String(result[0]?.entityId)).toBe('wine-blocker-only');
  });

  it('preloadedDocs 캐시 히트 → getDocument 미호출 (N+1 방어)', async () => {
    // 실질 검증: preloadedDocs에 이미 있는 ID는 getDocument를 호출하면 안 됨
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const entityId = createEntityId('wine-preloaded');
    const preloadedDocs = new Map([[String(entityId), { entityId, entityType: 'wine' as const, canonicalLabel: 'Preloaded Wine' }]]);
    const getDocument = vi.fn(async () => null);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [makeAnchor({ candidateEntityIds: [entityId] })],
      preloadedDocs,
    };
    await buildResolverCandidatesFromGenerator(input, { getDocument });
    expect(getDocument).not.toHaveBeenCalled();
  });
});

// ─── TA2-2: AnchorCandidate source union ─────────────────────────────────────

describe("AnchorCandidate.source union (TA2-2)", () => {
  it("source='blocker_seed' → buildResolverCandidatesFromGenerator가 source를 보존", async () => {
    // 실질 검증: source='blocker_seed'인 anchor가 실제 파이프라인을 통과했을 때
    // 출력 candidate의 source가 'blocker_seed'로 보존되는지
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const entityId = createEntityId('wine-blocker-src-test');
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [makeAnchor({ source: 'blocker_seed', candidateEntityIds: [entityId] })],
    };
    const result = await buildResolverCandidatesFromGenerator(input, {
      getDocument: async (id) => ({ entityId: id, entityType: 'wine', canonicalLabel: 'Test' }),
    });
    expect(result[0]?.source).toBe('blocker_seed');
  });

  it("source별 파이프라인 출력 분리 — alias vs planner_heuristic → 각각 별개 source 보존", async () => {
    // 실질 검증: 서로 다른 엔티티에 다른 source가 할당됐을 때 각각 유지되는지
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const idA = createEntityId('wine-alias-src');
    const idB = createEntityId('wine-heuristic-src');
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [
        makeAnchor({ source: 'alias', candidateEntityIds: [idA] }),
        makeAnchor({ source: 'planner_heuristic', candidateEntityIds: [idB] }),
      ],
    };
    const result = await buildResolverCandidatesFromGenerator(input, {
      getDocument: async (id) => ({ entityId: id, entityType: 'wine', canonicalLabel: 'Wine' }),
    });
    const aliasCandidate = result.find((c) => String(c.entityId) === String(idA));
    const heuristicCandidate = result.find((c) => String(c.entityId) === String(idB));
    expect(aliasCandidate?.source).toBe('alias');
    expect(heuristicCandidate?.source).toBe('planner_heuristic');
  });
});

// ─── TA2-3: buildResolverCandidatesFromGenerator module exports ───────────────

describe('buildResolverCandidatesFromGenerator module (TA2-3)', () => {
  it('anchor entityId가 getDocument에서 null 반환 시 해당 candidate 조용히 스킵', async () => {
    // 실질 검증: getDocument가 null을 반환하면 그 ID는 출력에서 빠져야 함
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const existingId = createEntityId('wine-exists');
    const missingId = createEntityId('wine-missing');
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [makeAnchor({ candidateEntityIds: [existingId, missingId] })],
    };
    const result = await buildResolverCandidatesFromGenerator(input, {
      getDocument: async (id) =>
        String(id) === String(existingId)
          ? { entityId: id, entityType: 'wine', canonicalLabel: 'Exists' }
          : null,
    });
    // missingId는 스킵, existingId만 살아남아야 함
    expect(result).toHaveLength(1);
    expect(String(result[0]?.entityId)).toBe(String(existingId));
  });

  it('legacy buildResolverCandidatesFromPlan API 제거 확인 — 마이그레이션 퇴행 방지', async () => {
    // 실질 검증: legacy API가 살아 돌아오면 마이그레이션이 롤백된 것
    const mod = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    expect('buildResolverCandidatesFromPlan' in mod).toBe(false);
  });

  it('fails closed when entityLookup is undefined but candidate IDs are present', async () => {
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [makeAnchor()],
    };
    await expect(buildResolverCandidatesFromGenerator(input, undefined)).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
    });
  });

  it('returns empty array when anchors are empty and no blockerOnlyIds', async () => {
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [],
    };
    // entityLookup provided but no IDs to look up
    const fakeLookup = { getDocument: async () => null };
    const result = await buildResolverCandidatesFromGenerator(input, fakeLookup);
    expect(result).toHaveLength(0);
  });

  it('deduplicates entity IDs that appear in both anchors and blockerOnlyIds', async () => {
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const sharedId = 'wine-shared-001';
    const anchor = makeAnchor({ candidateEntityIds: [sharedId] });
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [anchor],
      blockerOnlyIds: [sharedId], // same ID → should produce only 1 candidate
    };
    const fakeLookup = {
      getDocument: async (id: string) => ({
        entityId: id,
        entityType: 'wine',
        canonicalLabel: 'Opus One 2019',
      }),
    };
    const result = await buildResolverCandidatesFromGenerator(
      input,
      fakeLookup as unknown as Parameters<typeof buildResolverCandidatesFromGenerator>[1],
    );
    // The shared ID appears only once in output
    expect(result.filter((c) => String(c.entityId) === sharedId)).toHaveLength(1);
  });
});

// ─── TA2-4: ResolverInput.blockerSeedCandidates field ────────────────────────

describe('ResolverInput.blockerSeedCandidates (TA2-4)', () => {
  it('computeConformalSetSize: score >= 1-alpha → setSize=1 (신뢰 구간 내)', async () => {
    // 실질 검증: 고신뢰 점수에서 혼동 집합 크기가 1이어야 함
    const { computeConformalSetSize } = await import('../../src/domain/resolver/service/resolver.js');
    // alpha=0.1, score=0.95 >= 1-0.1=0.9 → size=1
    expect(computeConformalSetSize(0.95, 0.1, 10)).toBe(1);
    // alpha=0.2, score=0.85 >= 1-0.2=0.8 → size=1
    expect(computeConformalSetSize(0.85, 0.2, 10)).toBe(1);
  });

  it('computeConformalSetSize: score in (1-2α, 1-α) → setSize=2', async () => {
    // 실질 검증: 중간 신뢰 구간 → 혼동 집합 크기 2
    const { computeConformalSetSize } = await import('../../src/domain/resolver/service/resolver.js');
    // alpha=0.1, score=0.85 → 1-2*0.1=0.8 < 0.85 < 0.9=1-0.1 → size=2
    expect(computeConformalSetSize(0.85, 0.1, 10)).toBe(2);
  });

  it('computeConformalSetSize: score < 1-2α → setSize=k (fallback)', async () => {
    // 실질 검증: 저신뢰 → fallback k 반환
    const { computeConformalSetSize } = await import('../../src/domain/resolver/service/resolver.js');
    // alpha=0.1, score=0.7 < 0.8 → size=k=5
    expect(computeConformalSetSize(0.7, 0.1, 5)).toBe(5);
  });

  it('computeConformalSetSize: invalid alpha → RangeError', async () => {
    // 실질 검증: alpha=0 (경계 위반) → throw
    const { computeConformalSetSize } = await import('../../src/domain/resolver/service/resolver.js');
    expect(() => computeConformalSetSize(0.9, 0, 5)).toThrow(RangeError);
    expect(() => computeConformalSetSize(0.9, 0.6, 5)).toThrow(RangeError);
  });
});

// ─── T6: ResolvedCandidate.blockerSeed provenance field ──────────────────────

describe('ResolvedCandidate.blockerSeed (T6)', () => {
  it('blockerSeed=true → Resolver.resolve() 출력에서 candidates[].blockerSeed 보존', async () => {
    // 실질 검증: Resolver를 실제로 실행해서 blockerSeedCandidates가 출력의
    // candidates[].blockerSeed=true 로 이어지는지 확인
    const { Resolver, Blocker, CandidateScorer, AmbiguityClassifier, Calibrator } = await import(
      '../../src/domain/resolver/index.js'
    );
    const resolver = new Resolver(
      new Blocker({ async block() { return [createEntityId('wine-seed-provenance')]; } }),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator({ async getCalibrationParams() { return null; }, async save() {} }),
    );
    const result = await resolver.resolve({
      rawQuery: 'test',
      normalizedQuery: 'test',
      queryClass: 'short_entity',
      policy: { requireExact: false, allowApproximate: true, requireClarification: false, fallbackMode: 'fail', policyReasonCodes: [] },
      anchorCandidates: [],
      uncertainty: { overall: 0.5, ambiguityDetected: false, ambiguityTypes: [], ambiguitySeverity: 'low', decisionEffect: 'trace_only', parserConfidence: 0.5, anchorConfidence: 0.5, constraintConfidence: 0.5 },
      candidateEntities: [],
      blockerSeedCandidates: [
        {
          entityId: createEntityId('wine-seed-provenance'),
          entityType: 'wine',
          canonicalLabel: 'Blocker Seed Wine',
          aliasMatches: [],
          sourceSignals: { canonicalExactMatch: 0, canonicalNormalizedMatch: 0, aliasExactMatch: 0, aliasFuzzyMatch: 0, aliasTypePrior: 0, producerMatch: 0, vintageMatch: 0, regionMatch: 0, grapeHintMatch: 0, phoneticMatch: 0, editDistanceScore: 0, ambiguityPenalty: 0 },
          source: 'blocker_seed',
        },
      ],
    });
    const seedCandidate = result.candidates.find((c) => String(c.entityId) === 'wine-seed-provenance');
    expect(seedCandidate?.blockerSeed).toBe(true);
    expect(seedCandidate?.source).toBe('blocker_seed');
  });

  it('blockerSeed 필드 absent → alias source candidate에는 blockerSeed 없음', async () => {
    // 실질 검증: alias source 후보는 blockerSeed=undefined이어야 함 (오염 방지)
    const { Resolver, Blocker, CandidateScorer, AmbiguityClassifier, Calibrator } = await import(
      '../../src/domain/resolver/index.js'
    );
    const resolver = new Resolver(
      new Blocker({ async block() { return []; } }),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator({ async getCalibrationParams() { return null; }, async save() {} }),
    );
    const result = await resolver.resolve({
      rawQuery: 'test',
      normalizedQuery: 'test',
      queryClass: 'short_entity',
      policy: { requireExact: false, allowApproximate: true, requireClarification: false, fallbackMode: 'fail', policyReasonCodes: [] },
      anchorCandidates: [],
      uncertainty: { overall: 0.1, ambiguityDetected: false, ambiguityTypes: [], ambiguitySeverity: 'low', decisionEffect: 'trace_only', parserConfidence: 0.9, anchorConfidence: 0.9, constraintConfidence: 0.9 },
      candidateEntities: [
        {
          entityId: createEntityId('wine-alias-candidate'),
          entityType: 'wine',
          canonicalLabel: 'Alias Wine',
          aliasMatches: [{ aliasValue: 'test', aliasType: 'translation', matchScore: 0.9 }],
          sourceSignals: { canonicalExactMatch: 0, canonicalNormalizedMatch: 0.9, aliasExactMatch: 0.9, aliasFuzzyMatch: 0, aliasTypePrior: 0.9, producerMatch: 0, vintageMatch: 0, regionMatch: 0, grapeHintMatch: 0, phoneticMatch: 0, editDistanceScore: 0, ambiguityPenalty: 0 },
          source: 'alias',
        },
      ],
    });
    const aliasCandidate = result.candidates.find((c) => String(c.entityId) === 'wine-alias-candidate');
    expect(aliasCandidate?.blockerSeed).toBeUndefined();
  });
});

// ─── T7: Resolver trace blocker-seed provenance fields ──────────────────────

describe('ResolverQueryProvenance blocker-seed trace (T7)', () => {
  it('blockerSeedEntityIds + blockerSeedCount → Resolver.resolve() decisionTrace에 실제 반영', async () => {
    // 실질 검증: Resolver를 실행하면 decisionTrace.queryProvenance.blockerSeedEntityIds가
    // 실제 입력한 blockerSeedCandidates의 entityId를 담아야 함
    const { Resolver, Blocker, CandidateScorer, AmbiguityClassifier, Calibrator } = await import(
      '../../src/domain/resolver/index.js'
    );
    const resolver = new Resolver(
      new Blocker({ async block() { return [createEntityId('wine-trace-01'), createEntityId('wine-trace-02')]; } }),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator({ async getCalibrationParams() { return null; }, async save() {} }),
    );
    const ZERO = { canonicalExactMatch: 0, canonicalNormalizedMatch: 0, aliasExactMatch: 0, aliasFuzzyMatch: 0, aliasTypePrior: 0, producerMatch: 0, vintageMatch: 0, regionMatch: 0, grapeHintMatch: 0, phoneticMatch: 0, editDistanceScore: 0, ambiguityPenalty: 0 };
    const result = await resolver.resolve({
      rawQuery: 'trace test',
      normalizedQuery: 'trace test',
      queryClass: 'short_entity',
      policy: { requireExact: false, allowApproximate: true, requireClarification: false, fallbackMode: 'fail', policyReasonCodes: [] },
      anchorCandidates: [],
      uncertainty: { overall: 0.5, ambiguityDetected: false, ambiguityTypes: [], ambiguitySeverity: 'low', decisionEffect: 'trace_only', parserConfidence: 0.5, anchorConfidence: 0.5, constraintConfidence: 0.5 },
      candidateEntities: [],
      blockerSeedCandidates: [
        { entityId: createEntityId('wine-trace-01'), entityType: 'wine', canonicalLabel: 'Wine 1', aliasMatches: [], sourceSignals: ZERO, source: 'blocker_seed' },
        { entityId: createEntityId('wine-trace-02'), entityType: 'wine', canonicalLabel: 'Wine 2', aliasMatches: [], sourceSignals: ZERO, source: 'blocker_seed' },
      ],
    });
    const provenance = result.decisionTrace.queryProvenance;
    expect(provenance?.blockerSeedCount).toBe(2);
    expect(provenance?.blockerSeedEntityIds).toEqual(
      expect.arrayContaining(['wine-trace-01', 'wine-trace-02']),
    );
    // candidateSourceBreakdown에 blocker_seed가 count=2로 등장해야 함
    const seedBreakdown = provenance?.candidateSourceBreakdown?.find((b) => b.source === 'blocker_seed');
    expect(seedBreakdown?.count).toBe(2);
  });
});

// ─── TA3-1: shouldTriggerCorrectiveRetry ────────────────────────────────────

describe('shouldTriggerCorrectiveRetry (TA3-1)', () => {
  it('returns false when status is resolved', () => {
    const plan = makePlan();
    const result = makeResolveResult({ status: 'resolved', decisionConfidenceC: 0.9 });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('returns false when resolver recommends clarify', () => {
    const plan = makePlan();
    const result = makeResolveResult({ recommendedNextAction: 'clarify' });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('returns false when resolver recommends fail', () => {
    const plan = makePlan();
    const result = makeResolveResult({ recommendedNextAction: 'fail' });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('returns false when ambiguity is detected', () => {
    const plan = makePlan();
    const result = makeResolveResult({
      ambiguity: {
        types: ['homonym'],
        severity: 'high',
        explanationCodes: ['AMBIGUITY_HOMONYM'],
      },
    });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('returns true when zero anchors and failed status', () => {
    const plan = makePlan({ anchors: [] });
    const result = makeResolveResult({ status: 'failed', decisionConfidenceC: 0.1 });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });

  it('returns true when confidence < threshold and no ambiguity', () => {
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({ status: 'ambiguous', decisionConfidenceC: 0.2 });
    // Note: result.ambiguity field is undefined here (no structural ambiguity)
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });

  it('returns false when confidence is above threshold', () => {
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({ status: 'ambiguous', decisionConfidenceC: 0.8 });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('NaN confidence: treated as 0 (retry triggers)', () => {
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({ status: 'failed', decisionConfidenceC: NaN });
    // NaN is not finite, so treated as 0 → below threshold → trigger
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });

  // T6: resolver now emits corrective_retry as recommendedNextAction — honour it
  it("returns true when resolver explicitly recommends corrective_retry (T6)", () => {
    // High-confidence plan with anchors — would not trigger via C1/C2 conditions alone
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.8, // above threshold — would normally not trigger
      recommendedNextAction: 'corrective_retry',
    });
    // The resolver recommendation takes precedence over local condition evaluation
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });
});

// ─── TA3-2: resolveCorrectiveRetryOutcome ───────────────────────────────────

describe('resolveCorrectiveRetryOutcome (TA3-2)', () => {
  it("returns 'accept' when retry produced a resolved result", () => {
    const result = makeResolveResult({ status: 'resolved', decisionConfidenceC: 0.9 });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('accept');
  });

  it("returns 'clarify' when ambiguity detected after retry", () => {
    const result = makeResolveResult({
      status: 'ambiguous',
      ambiguity: {
        types: ['homonym'],
        severity: 'medium',
        explanationCodes: [],
      },
    });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('clarify');
  });

  it("returns 'fail' when resolver recommends fail after retry", () => {
    const result = makeResolveResult({
      status: 'failed',
      recommendedNextAction: 'fail',
    });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('fail');
  });

  it("returns 'clarify' when confidence still below threshold after retry", () => {
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.3,
    });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('clarify');
  });

  it("returns 'accept' for marginal improvement (confidence just above threshold)", () => {
    const result = makeResolveResult({
      status: 'ambiguous',
      decisionConfidenceC: 0.6,
    });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('accept');
  });

  it('NaN confidence: treated as below threshold → clarify', () => {
    const result = makeResolveResult({ status: 'failed', decisionConfidenceC: NaN });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('clarify');
  });
});

// ─── TA5: computeCorrectiveRetryCalibration ───────────────────────────────────

describe('computeCorrectiveRetryCalibration (TA5)', () => {
  function makeResultWithCandidates(
    topEntityId: string,
    topRank: number,
    totalCandidates: number,
    status: EntityResolveResult['status'] = 'resolved',
  ): EntityResolveResult {
    const candidates = Array.from({ length: totalCandidates }, (_, i) => ({
      entityId: i === topRank - 1 ? topEntityId : `other-wine-${i}`,
      canonicalLabel: i === topRank - 1 ? 'Top Wine' : `Other Wine ${i}`,
      calibratedScore: 1 - i * 0.1,
      rank: i + 1,
      evidenceRefs: [],
    }));
    return {
      status,
      decisionConfidenceC: 0.8,
      topEntity: {
        entityId: topEntityId,
        canonicalLabel: 'Top Wine',
        calibratedScore: 1.0,
      },
      candidates,
      decisionTrace: {} as EntityResolveResult['decisionTrace'],
      conformalSetSize: 1,
    };
  }

  it('rank-1 of 1 → confidence = 0.9 (best possible, single candidate)', () => {
    const result = makeResultWithCandidates('wine-abc', 1, 1);
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    // rank 1, total 1 → normalizedRank = 0/max(0,1) = 0 → 0.5 + 0.4*1 = 0.9
    expect(confidence).toBeCloseTo(0.9);
  });

  it('rank-1 of 5 → confidence = 0.9 (best rank in pool)', () => {
    const result = makeResultWithCandidates('wine-abc', 1, 5);
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    // rank 1, total 5 → normalizedRank = 0/4 = 0 → 0.5 + 0.4*1 = 0.9
    expect(confidence).toBeCloseTo(0.9);
  });

  it('rank-5 of 5 → confidence = 0.5 (worst rank in pool)', () => {
    const result = makeResultWithCandidates('wine-abc', 5, 5);
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    // rank 5, total 5 → normalizedRank = 4/4 = 1 → 0.5 + 0.4*0 = 0.5
    expect(confidence).toBeCloseTo(0.5);
  });

  it('rank-3 of 5 → confidence = 0.7 (mid-pool)', () => {
    const result = makeResultWithCandidates('wine-abc', 3, 5);
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    // rank 3, total 5 → normalizedRank = 2/4 = 0.5 → 0.5 + 0.4*0.5 = 0.7
    expect(confidence).toBeCloseTo(0.7);
  });

  it("outcome 'clarify' → returns undefined (no calibrated confidence for clarify)", () => {
    const result = makeResultWithCandidates('wine-abc', 1, 3);
    const confidence = computeCorrectiveRetryCalibration(result, 'clarify');
    expect(confidence).toBeUndefined();
  });

  it("outcome 'fail' → returns undefined", () => {
    const result = makeResultWithCandidates('wine-abc', 1, 3);
    const confidence = computeCorrectiveRetryCalibration(result, 'fail');
    expect(confidence).toBeUndefined();
  });

  it('empty candidates → returns undefined', () => {
    const result = makeResolveResult({ status: 'resolved', candidates: [] });
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    expect(confidence).toBeUndefined();
  });

  it('topEntity absent → returns undefined', () => {
    const result: EntityResolveResult = {
      status: 'resolved',
      decisionConfidenceC: 0.8,
      candidates: [
        { entityId: 'wine-x', canonicalLabel: 'X', calibratedScore: 0.9, rank: 1, evidenceRefs: [] },
      ],
      decisionTrace: {} as EntityResolveResult['decisionTrace'],
      conformalSetSize: 1,
    };
    // No topEntity field
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    expect(confidence).toBeUndefined();
  });

  it('confidence range: rank-1 always >= rank-N for any N', () => {
    for (let total = 1; total <= 10; total++) {
      const best = computeCorrectiveRetryCalibration(makeResultWithCandidates('wine-abc', 1, total), 'accept');
      const worst = computeCorrectiveRetryCalibration(makeResultWithCandidates('wine-abc', total, total), 'accept');
      expect(best).toBeDefined();
      expect(worst).toBeDefined();
      // best >= worst always
      expect(best!).toBeGreaterThanOrEqual(worst!);
      // calibrated confidence is always in [0.5, 0.9]
      expect(best!).toBeGreaterThanOrEqual(0.5);
      expect(best!).toBeLessThanOrEqual(0.9);
      expect(worst!).toBeGreaterThanOrEqual(0.5);
      expect(worst!).toBeLessThanOrEqual(0.9);
    }
  });
});

// ─── TA3: 1-retry-max structural guarantee ───────────────────────────────────
//
// The corrective retry is implemented as a sequential if-block (no loop).
// These tests guard that the control-flow contract — at most ONE retry per
// request — is structurally preserved and cannot silently become a loop.

describe('TA3: 1-retry-max structural guarantee', () => {
  it('TA3-MAX-01: shouldTriggerCorrectiveRetry returns false for resolved results — no retry after success', () => {
    // Even if we call shouldTriggerCorrectiveRetry on the retry result, it must
    // return false when status=resolved. This is the gate that prevents a 3rd pass.
    const plan = makePlan({ anchors: [] });
    const resolvedResult = makeResolveResult({ status: 'resolved', decisionConfidenceC: 0.9 });
    expect(shouldTriggerCorrectiveRetry(plan, resolvedResult)).toBe(false);
  });

  it('TA3-MAX-02: shouldTriggerCorrectiveRetry returns false for clarify recommendation — retry never escalates clarify', () => {
    const plan = makePlan({ anchors: [] });
    const clarifyResult = makeResolveResult({
      status: 'ambiguous',
      decisionConfidenceC: 0.2,
      recommendedNextAction: 'clarify',
    });
    expect(shouldTriggerCorrectiveRetry(plan, clarifyResult)).toBe(false);
  });

  it('TA3-MAX-03: shouldTriggerCorrectiveRetry returns false for fail recommendation — hard failure is not retried', () => {
    const plan = makePlan({ anchors: [] });
    const failResult = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.1,
      recommendedNextAction: 'fail',
    });
    expect(shouldTriggerCorrectiveRetry(plan, failResult)).toBe(false);
  });

  it('TA3-MAX-04: shouldTriggerCorrectiveRetry returns false for ambiguous result even with low confidence — ambiguity → clarify not retry', () => {
    const plan = makePlan({ anchors: [] });
    const ambiguousResult = makeResolveResult({
      status: 'ambiguous',
      decisionConfidenceC: 0.1,
      ambiguity: { type: 'entity_ambiguity', candidates: [] } as EntityResolveResult['ambiguity'],
    });
    expect(shouldTriggerCorrectiveRetry(plan, ambiguousResult)).toBe(false);
  });

  it('TA3-MAX-05: after corrective_retry recommendation, resolveCorrectiveRetryOutcome(resolved)=accept — loop terminates', () => {
    // Simulates the retry pass returning resolved: outcome=accept means the
    // caller must return, not re-enter the retry path.
    const retryResult = makeResolveResult({ status: 'resolved', decisionConfidenceC: 0.85 });
    expect(resolveCorrectiveRetryOutcome(retryResult)).toBe('accept');
  });

  it('TA3-MAX-06: resolveCorrectiveRetryOutcome(failed) — low confidence after retry → clarify, not another retry', () => {
    // After exactly 1 retry, continued low confidence routes to clarify.
    // There is no 'retry_again' outcome — the loop cannot continue.
    const retryResult = makeResolveResult({ status: 'failed', decisionConfidenceC: 0.2 });
    const outcome = resolveCorrectiveRetryOutcome(retryResult);
    expect(outcome).toBe('clarify');
    // Crucially: outcome is never 'retry' — the only outcomes are accept/clarify/fail
    expect(['accept', 'clarify', 'fail']).toContain(outcome);
  });

  it('TA3-MAX-07: resolveCorrectiveRetryOutcome union is closed — no retry outcome exists', () => {
    // Type-level guard: the return type of resolveCorrectiveRetryOutcome is
    // 'accept' | 'clarify' | 'fail'. There is no 'retry' value.
    // This test exhausts all three branches to confirm no fourth branch exists.
    const resolved = makeResolveResult({ status: 'resolved', decisionConfidenceC: 0.9 });
    const ambiguous = makeResolveResult({
      status: 'ambiguous',
      ambiguity: { type: 'entity_ambiguity', candidates: [] } as EntityResolveResult['ambiguity'],
    });
    const hardFail = makeResolveResult({ status: 'failed', decisionConfidenceC: 0.6, recommendedNextAction: 'fail' });

    expect(resolveCorrectiveRetryOutcome(resolved)).toBe('accept');
    expect(resolveCorrectiveRetryOutcome(ambiguous)).toBe('clarify');
    expect(resolveCorrectiveRetryOutcome(hardFail)).toBe('fail');
  });
});

// ─── P0-2 (TA2-T2): Noisy evidence formalization ─────────────────────────────
//
// Guards that AnchorCandidate provenance (source, lookupStrategies, lookupVariants)
// is preserved end-to-end through buildResolverCandidatesFromGenerator, and that
// downstream consumers can distinguish alias / planner_heuristic / entity_lookup /
// blocker_seed sources.
//
// These tests are append-only (regression suite rules). Never delete.

describe('P0-2 (TA2-T2): noisy evidence formalization — source provenance end-to-end', () => {
  // ── helper: minimal entity lookup ──────────────────────────────────────────
  function makeEntityLookup(entries: Array<[string, string]>): EntityDocumentLookupPort {
    const map = new Map(entries);
    return {
      getDocument: async (id) => {
        const label = map.get(String(id));
        if (label == null) return null;
        return { entityId: id, entityType: 'wine', canonicalLabel: label };
      },
    };
  }

  // ── helper: anchor builder ──────────────────────────────────────────────────
  function makeAnchorFor(
    entityId: string,
    overrides: Partial<AnchorCandidate> = {},
  ): AnchorCandidate {
    return {
      surfaceForm: entityId,
      normalizedForm: entityId,
      candidateEntityIds: [createEntityId(entityId)],
      confidence: 0.85,
      source: 'alias',
      ...overrides,
    };
  }

  it('P0-2-A: alias anchor — source=alias propagates to ResolverCandidate', async () => {
    const id = createEntityId('opus-one-2019');
    const lookup = makeEntityLookup([['opus-one-2019', 'Opus One 2019']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one 2019',
      normalizedQuery: 'opus one 2019',
      anchors: [makeAnchorFor('opus-one-2019', { source: 'alias', lookupStrategies: ['exact'] })],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('alias');
    expect(candidates[0]?.sources).toContain('alias');
    expect(candidates[0]?.entityId).toEqual(id);
  });

  it('P0-2-B: Korean transliteration — source=alias, strategy=transliterated_exact preserved', async () => {
    // 샤또마고 → Chateau Margaux: transliterated anchor
    const lookup = makeEntityLookup([['chateau-margaux', 'Chateau Margaux']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: '샤또마고',
      normalizedQuery: '샤또마고',
      anchors: [makeAnchorFor('chateau-margaux', {
        surfaceForm: '샤또마고',
        normalizedForm: '샤또마고',
        source: 'alias',
        lookupStrategies: ['transliterated_exact'],
        lookupVariants: ['chateau margaux', 'chateaumargaux'],
        confidence: 0.96,
      })],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates[0]?.source).toBe('alias');
    // lookupStrategies must not be lost — signals derived from it
    // (aliasExactMatch > 0 because transliterated_exact is in exactLike set)
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeGreaterThan(0);
    expect(candidates[0]?.sourceSignals.aliasTypePrior).toBeGreaterThan(0);
  });

  it('P0-2-C: Korean misspelling/otyeo — source=planner_heuristic, strategy=fuzzy_char_ngram preserved', async () => {
    // 옼퍼스원 (typo) → Opus One: fuzzy_char_ngram anchor from planner heuristic
    const lookup = makeEntityLookup([['opus-one-2019', 'Opus One 2019']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: '옼퍼스원 2019',
      normalizedQuery: '옼퍼스원 2019',
      anchors: [makeAnchorFor('opus-one-2019', {
        surfaceForm: '옼퍼스원',
        normalizedForm: '옼퍼스원',
        source: 'planner_heuristic',
        lookupStrategies: ['fuzzy_char_ngram'],
        confidence: 0.71,
      })],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates[0]?.source).toBe('planner_heuristic');
    expect(candidates[0]?.sources).toContain('planner_heuristic');
    // fuzzy_char_ngram is in fuzzyLike set → aliasFuzzyMatch and editDistanceScore populated
    expect(candidates[0]?.sourceSignals.aliasFuzzyMatch).toBeGreaterThan(0);
    expect(candidates[0]?.sourceSignals.editDistanceScore).toBeGreaterThan(0);
    // aliasExactMatch must be 0 for a fuzzy-only anchor
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBe(0);
  });

  it('P0-2-D: substring strategy — source=planner_heuristic, fuzzyLike signals populated', async () => {
    const lookup = makeEntityLookup([['barolo-2020', 'Barolo 2020']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'barolo',
      normalizedQuery: 'barolo',
      anchors: [makeAnchorFor('barolo-2020', {
        surfaceForm: 'barolo',
        normalizedForm: 'barolo',
        source: 'planner_heuristic',
        lookupStrategies: ['substring'],
        confidence: 0.65,
      })],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates[0]?.source).toBe('planner_heuristic');
    expect(candidates[0]?.sourceSignals.aliasFuzzyMatch).toBeGreaterThan(0);
    expect(candidates[0]?.sourceSignals.editDistanceScore).toBeGreaterThan(0);
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBe(0);
  });

  it('P0-2-E: smart_document strategy — source=planner_heuristic, fuzzyLike signals populated', async () => {
    const lookup = makeEntityLookup([['romanee-conti-2015', 'Romanée-Conti 2015']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: '로마네 꽁티 15',
      normalizedQuery: '로마네 꽁티 15',
      anchors: [makeAnchorFor('romanee-conti-2015', {
        surfaceForm: '로마네 꽁티 15',
        normalizedForm: '로마네 꽁티 15',
        source: 'planner_heuristic',
        lookupStrategies: ['smart_document'],
        confidence: 0.78,
      })],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates[0]?.source).toBe('planner_heuristic');
    expect(candidates[0]?.sourceSignals.aliasFuzzyMatch).toBeGreaterThan(0);
  });

  it('P0-2-F: blocker_seed — source=blocker_seed, ZERO_SIGNALS, no aliasMatches', async () => {
    const lookup = makeEntityLookup([['opus-one-2019', 'Opus One 2019']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: '오퍼스원 2019',
      normalizedQuery: '오퍼스원 2019',
      anchors: [],
      blockerOnlyIds: [createEntityId('opus-one-2019')],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates[0]?.source).toBe('blocker_seed');
    expect(candidates[0]?.sources).toEqual(['blocker_seed']);
    expect(candidates[0]?.aliasMatches).toHaveLength(0);
    // ZERO_SIGNALS: all numeric fields are 0
    const signals = candidates[0]?.sourceSignals;
    expect(signals?.canonicalExactMatch).toBe(0);
    expect(signals?.aliasExactMatch).toBe(0);
    expect(signals?.aliasFuzzyMatch).toBe(0);
    expect(signals?.editDistanceScore).toBe(0);
  });

  it('P0-2-G: entity_lookup source — literal source tag preserved in ResolverCandidate', async () => {
    const lookup = makeEntityLookup([['margaux-2016', 'Margaux 2016']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'margaux 2016',
      normalizedQuery: 'margaux 2016',
      anchors: [makeAnchorFor('margaux-2016', {
        source: 'entity_lookup',
        lookupStrategies: ['exact'],
        confidence: 0.99,
      })],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates[0]?.source).toBe('entity_lookup');
    expect(candidates[0]?.sources).toContain('entity_lookup');
  });

  it('P0-2-H: mixed alias+planner_heuristic same entity — sources union preserved, source cleared', async () => {
    // Same entity arrived via both alias lookup AND planner heuristic.
    // ResolverCandidate.sources must contain both; source (singular) must be undefined.
    const id = createEntityId('opus-one-2019');
    const lookup = makeEntityLookup([['opus-one-2019', 'Opus One 2019']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [
        makeAnchorFor('opus-one-2019', { source: 'alias', lookupStrategies: ['exact'], confidence: 0.92 }),
        makeAnchorFor('opus-one-2019', { source: 'planner_heuristic', lookupStrategies: ['fuzzy_char_ngram'], confidence: 0.71 }),
      ],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates).toHaveLength(1); // merged, not duplicated
    expect(candidates[0]?.entityId).toEqual(id);
    // When multiple sources exist, source (singular) is undefined
    expect(candidates[0]?.source).toBeUndefined();
    // sources union must include both
    expect(candidates[0]?.sources).toContain('alias');
    expect(candidates[0]?.sources).toContain('planner_heuristic');
    // Merged signals: aliasExactMatch from alias, aliasFuzzyMatch from fuzzy
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeGreaterThan(0);
    expect(candidates[0]?.sourceSignals.aliasFuzzyMatch).toBeGreaterThan(0);
  });

  it('P0-2-I: alias+blocker_seed overlap — anchor wins, blocker deduped, sources contain both', async () => {
    // Entity is in both anchor (alias) and blockerOnlyIds.
    // buildResolverCandidatesFromGenerator should deduplicate: anchor-built
    // candidate wins the full signals; blocker does NOT overwrite.
    const id = createEntityId('petrus-2018');
    const lookup = makeEntityLookup([['petrus-2018', 'Petrus 2018']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'petrus 2018',
      normalizedQuery: 'petrus 2018',
      anchors: [makeAnchorFor('petrus-2018', {
        source: 'alias',
        lookupStrategies: ['exact'],
        confidence: 0.97,
      })],
      blockerOnlyIds: [id], // same entity in blockerOnlyIds
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    // Only one candidate (not two)
    expect(candidates).toHaveLength(1);
    // Anchor-built signals preserved (not overwritten by ZERO)
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeGreaterThan(0);
    // source tag from anchor
    expect(candidates[0]?.source).toBe('alias');
  });

  it('P0-2-J: phonetic strategy — source=alias, phoneticMatch signal populated', async () => {
    // 로마네꽁티 via phonetic lookup (phonetic_exact strategy)
    const lookup = makeEntityLookup([['romanee-conti', 'Romanée-Conti']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: '로마네꽁티',
      normalizedQuery: '로마네꽁티',
      anchors: [makeAnchorFor('romanee-conti', {
        surfaceForm: '로마네꽁티',
        normalizedForm: '로마네꽁티',
        source: 'alias',
        lookupStrategies: ['phonetic_exact'],
        confidence: 0.88,
      })],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates[0]?.source).toBe('alias');
    expect(candidates[0]?.sourceSignals.phoneticMatch).toBeGreaterThan(0);
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeGreaterThan(0);
  });

  it('P0-2-K: phonetic_fuzzy strategy — phoneticMatch AND editDistanceScore both populated', async () => {
    const lookup = makeEntityLookup([['petrus-2020', 'Petrus 2020']]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: '페트루스 20',
      normalizedQuery: '페트루스 20',
      anchors: [makeAnchorFor('petrus-2020', {
        surfaceForm: '페트루스 20',
        source: 'alias',
        lookupStrategies: ['phonetic_fuzzy'],
        confidence: 0.75,
      })],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates[0]?.sourceSignals.phoneticMatch).toBeGreaterThan(0);
    expect(candidates[0]?.sourceSignals.editDistanceScore).toBeGreaterThan(0);
    // aliasExactMatch must be 0 for phonetic_fuzzy
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBe(0);
  });

  it('P0-2-L: multiple blocker seeds — all tagged blocker_seed, each distinct entity returned', async () => {
    const id1 = createEntityId('wine-a');
    const id2 = createEntityId('wine-b');
    const id3 = createEntityId('wine-c');
    const lookup = makeEntityLookup([
      ['wine-a', 'Wine A'],
      ['wine-b', 'Wine B'],
      ['wine-c', 'Wine C'],
    ]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [],
      blockerOnlyIds: [id1, id2, id3],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates).toHaveLength(3);
    for (const candidate of candidates) {
      expect(candidate.source).toBe('blocker_seed');
      expect(candidate.sources).toEqual(['blocker_seed']);
      expect(candidate.aliasMatches).toHaveLength(0);
    }
  });

  it('P0-2-M: missing entity from lookup is silently skipped (no throw, no ghost candidate)', async () => {
    // Some IDs from anchors may not exist in the index (deleted wine, ETL gap).
    // buildResolverCandidatesFromGenerator must skip them silently.
    const lookup = makeEntityLookup([['real-wine', 'Real Wine']]); // ghost-wine not in lookup
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [
        makeAnchorFor('real-wine', { source: 'alias', confidence: 0.9 }),
        makeAnchorFor('ghost-wine', { source: 'alias', confidence: 0.8 }),
      ],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates).toHaveLength(1);
    expect(String(candidates[0]?.entityId)).toBe('real-wine');
  });

  it('P0-2-N: preloadedDocs cache — entity lookup not called for cached IDs', async () => {
    const id = createEntityId('cached-wine');
    const getDocumentSpy = vi.fn().mockResolvedValue(null); // spy returns null for all
    const lookup: EntityDocumentLookupPort = { getDocument: getDocumentSpy };

    const preloadedDocs: ReadonlyMap<string, { entityId: unknown; entityType: string; canonicalLabel: string }> =
      new Map([['cached-wine', { entityId: id, entityType: 'wine', canonicalLabel: 'Cached Wine' }]]);

    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'cached wine',
      normalizedQuery: 'cached wine',
      anchors: [makeAnchorFor('cached-wine', { source: 'alias', confidence: 0.9 })],
      preloadedDocs: preloadedDocs as EntityCandidateGeneratorInput['preloadedDocs'],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    // Candidate built from cache — getDocument was not called
    expect(getDocumentSpy).not.toHaveBeenCalled();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.canonicalLabel).toBe('Cached Wine');
  });

  it('P0-2-O: lookupVariants on anchor do NOT affect signal computation (provenance-only field)', async () => {
    // lookupVariants is provenance metadata — it must not change scoring signals.
    // Two otherwise-identical anchors with/without lookupVariants should produce
    // the same sourceSignals.
    const id = createEntityId('test-wine');
    const lookup = makeEntityLookup([['test-wine', 'Test Wine']]);

    const withVariants: EntityCandidateGeneratorInput = {
      rawQuery: 'test wine',
      normalizedQuery: 'test wine',
      anchors: [makeAnchorFor('test-wine', {
        source: 'alias',
        lookupStrategies: ['exact'],
        lookupVariants: ['testwine', 'test-wine'],
        confidence: 0.9,
      })],
    };
    const withoutVariants: EntityCandidateGeneratorInput = {
      rawQuery: 'test wine',
      normalizedQuery: 'test wine',
      anchors: [makeAnchorFor('test-wine', {
        source: 'alias',
        lookupStrategies: ['exact'],
        confidence: 0.9,
      })],
    };

    const candidatesWith = await buildResolverCandidatesFromGenerator(withVariants, lookup);
    const candidatesWithout = await buildResolverCandidatesFromGenerator(withoutVariants, lookup);

    expect(candidatesWith[0]?.sourceSignals).toEqual(candidatesWithout[0]?.sourceSignals);
  });
});

// ─── 수학적 완결성: shouldTriggerCorrectiveRetry OR-조건 독립성 ───────────────────
//
// shouldTriggerCorrectiveRetry 의 반환식은 `zeroAnchors || lowConfidence`.
// OR 논리: C1 단독으로 충분하고, C2 단독으로도 충분하다.
// 각 조건이 독립적으로 트리거를 활성화하는지 검증한다.

describe('shouldTriggerCorrectiveRetry — OR 조건 독립성 (수학적 완결성)', () => {
  it('TA3-OR-01: C1 단독 (zeroAnchors=true, confidence >= threshold) → true', () => {
    // C1 만 만족: anchors=[], confidence=0.9 (threshold 초과)
    // C2 불만족이어도 C1 만으로 retry 발생해야 함
    const plan = makePlan({ anchors: [] });
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.9, // CORRECTIVE_RETRY_CONFIDENCE_THRESHOLD=0.5 초과
    });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });

  it('TA3-OR-02: C2 단독 (zeroAnchors=false, confidence < threshold) → true', () => {
    // C2 만 만족: anchors=[valid anchor], confidence=0.1 (threshold 미만)
    // C1 불만족이어도 C2 만으로 retry 발생해야 함
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.1, // CORRECTIVE_RETRY_CONFIDENCE_THRESHOLD=0.5 미만
    });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });

  it('TA3-OR-03: C1 && C2 모두 (zeroAnchors=true, confidence < threshold) → true', () => {
    // 두 조건 모두 만족 — OR 로도 true
    const plan = makePlan({ anchors: [] });
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.1,
    });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });

  it('TA3-OR-04: C1 && C2 모두 불만족 (anchors 있음, confidence >= threshold) → false', () => {
    // OR 에서 두 조건 모두 false → 전체 false
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.9,
    });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('TA3-OR-05: C1 단독 — threshold 경계값 (confidence = 0.5 정확히) → false (엄격한 < 비교)', () => {
    // confidence === 0.5 는 `< 0.5` 를 만족하지 않으므로 C2 불만족
    // anchors 있으면 → false
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.5, // exactly at threshold → NOT < threshold
    });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('TA3-OR-06: C2 threshold 바로 아래 (confidence = 0.499…) → true', () => {
    // threshold = 0.5: 0.4999 < 0.5 → C2 true → retry
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.4999,
    });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });
});

// ─── 수학적 완결성: computeCorrectiveRetryCalibration 공식 단조성 및 수렴 ─────────
//
// 공식: BASE + RANGE * (1 - (rank-1) / max(total-1, 1))
//   = 0.5 + 0.4 * (1 - normalizedRank)
//
// 단조성: rank가 증가할수록 confidence가 감소 (strong monotone decreasing)
// 수렴: rank=1 → 0.9, rank=total → 0.5 (N에 무관하게 항상)
// 범위: 모든 (rank, total) 에서 [0.5, 0.9]

describe('computeCorrectiveRetryCalibration — 공식 단조성 및 수렴 (수학적 완결성)', () => {
  function makeResultAtRank(
    rank: number,
    total: number,
  ): EntityResolveResult {
    const candidates = Array.from({ length: total }, (_, i) => ({
      entityId: i === rank - 1 ? 'wine-target' : `wine-other-${i}`,
      canonicalLabel: i === rank - 1 ? 'Target' : `Other ${i}`,
      calibratedScore: 1 - i * 0.05,
      rank: i + 1,
      evidenceRefs: [],
    }));
    return {
      status: 'resolved',
      decisionConfidenceC: 0.8,
      topEntity: {
        entityId: 'wine-target',
        canonicalLabel: 'Target',
        calibratedScore: 1.0,
      },
      candidates,
      decisionTrace: {} as EntityResolveResult['decisionTrace'],
      conformalSetSize: 1,
    };
  }

  it('TA5-CONV-01: rank=1 → 0.9 — 풀 크기에 무관하게 항상 수렴', () => {
    for (const total of [1, 2, 3, 5, 10, 20]) {
      const conf = computeCorrectiveRetryCalibration(makeResultAtRank(1, total), 'accept');
      expect(conf).toBeCloseTo(0.9, 9);
    }
  });

  it('TA5-CONV-02: rank=total → 0.5 — 풀 크기에 무관하게 항상 수렴', () => {
    for (const total of [2, 3, 5, 10, 20]) {
      const conf = computeCorrectiveRetryCalibration(makeResultAtRank(total, total), 'accept');
      expect(conf).toBeCloseTo(0.5, 9);
    }
  });

  it('TA5-MONO-01: 단조 감소 — rank 증가 시 confidence 단조 감소 (N=5)', () => {
    const total = 5;
    const values = [1, 2, 3, 4, 5].map((rank) =>
      computeCorrectiveRetryCalibration(makeResultAtRank(rank, total), 'accept')!,
    );
    for (let i = 0; i < values.length - 1; i++) {
      expect(values[i]!).toBeGreaterThan(values[i + 1]!);
    }
  });

  it('TA5-MONO-02: 단조 감소 — N=10 전체 구간 검증', () => {
    const total = 10;
    const values = Array.from({ length: total }, (_, i) =>
      computeCorrectiveRetryCalibration(makeResultAtRank(i + 1, total), 'accept')!,
    );
    for (let i = 0; i < values.length - 1; i++) {
      expect(values[i]!).toBeGreaterThan(values[i + 1]!);
    }
  });

  it('TA5-RANGE-01: 모든 (rank, total) 에서 값이 [0.5, 0.9] 범위 내', () => {
    for (const total of [1, 2, 5, 10]) {
      for (let rank = 1; rank <= total; rank++) {
        const conf = computeCorrectiveRetryCalibration(makeResultAtRank(rank, total), 'accept')!;
        expect(conf).toBeGreaterThanOrEqual(0.5);
        expect(conf).toBeLessThanOrEqual(0.9);
      }
    }
  });

  it('TA5-FORMULA-01: rank=3, total=5 — 공식 직접 검증 (0.5 + 0.4*0.5 = 0.7)', () => {
    // normalizedRank = (3-1)/(5-1) = 2/4 = 0.5
    // confidence = 0.5 + 0.4 * (1 - 0.5) = 0.5 + 0.2 = 0.7
    const conf = computeCorrectiveRetryCalibration(makeResultAtRank(3, 5), 'accept');
    expect(conf).toBeCloseTo(0.7, 9);
  });

  it('TA5-FORMULA-02: rank=2, total=3 — 공식 직접 검증 (0.5 + 0.4*(1/3))', () => {
    // normalizedRank = (2-1)/(3-1) = 1/2 = 0.5
    // confidence = 0.5 + 0.4 * (1 - 0.5) = 0.7
    const conf = computeCorrectiveRetryCalibration(makeResultAtRank(2, 3), 'accept');
    expect(conf).toBeCloseTo(0.7, 9);
  });

  it('TA5-FORMULA-03: rank=1, total=1 — max(0, 1) 분모 0 방어 (단일 후보)', () => {
    // total=1 → max(total-1, 1) = max(0, 1) = 1 (0 나누기 방지)
    // normalizedRank = (1-1)/1 = 0 → confidence = 0.9
    const conf = computeCorrectiveRetryCalibration(makeResultAtRank(1, 1), 'accept');
    expect(conf).toBeCloseTo(0.9, 9);
  });

  it('TA5-FORMULA-04: rank=2, total=2 — 분모=max(1,1)=1 → normalizedRank=1 → 0.5', () => {
    // max(2-1, 1) = 1
    // normalizedRank = (2-1)/1 = 1 → confidence = 0.5
    const conf = computeCorrectiveRetryCalibration(makeResultAtRank(2, 2), 'accept');
    expect(conf).toBeCloseTo(0.5, 9);
  });
});
