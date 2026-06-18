/**
 * Regression: TRACK-A A2/A3 — Shared Entity Candidate Generation + Corrective Retry
 *
 * Guards:
 *  1. EntityCandidateGeneratorInput contract shapes (TA2-1)
 *  2. AnchorCandidate.source union includes 'blocker_seed' (TA2-2)
 *  3. buildResolverCandidatesFromGenerator — anchor + blocker paths (TA2-3)
 *  4. Resolver merges blockerSeedCandidates into candidate pool (TA2-4)
 *  (TA3 corrective-retry loop removed — Entity Lookup V2 cutover)
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  emptyEntityDocumentBatchLookup,
  makeEntityDocumentBatchLookupFromEntries,
  makeUniformEntityDocumentBatchLookup,
  wrapEntityDocumentBatchLookupAsResolverProjection,
  type EntityDocumentBatchLookup,
} from '../../src/application/search/__tests__/resolver-projection-lookup.stub.js';
import { buildResolverCandidatesFromGenerator } from '../../src/application/search/search-usecase-resolver-candidates.js';
import type { EntityCandidateGeneratorInput } from '../../src/domain/resolver/model/entity-candidate-generator-input.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeAnchor(overrides: Partial<AnchorCandidate> = {}): AnchorCandidate {
  const lookupStrategies = overrides.lookupStrategies ?? [];
  const inferredAliasType = overrides.aliasType
    ?? (lookupStrategies.includes('phonetic_exact')
      ? 'phonetic'
      : lookupStrategies.includes('transliterated_exact')
        ? 'translation'
        : lookupStrategies.includes('phonetic_fuzzy')
          || lookupStrategies.includes('fuzzy_char_ngram')
          || lookupStrategies.includes('transliterated_fuzzy')
          || lookupStrategies.includes('substring')
          ? 'misspelling'
          : 'canonical');
  return {
    surfaceForm: 'opus one',
    normalizedForm: 'opus one',
    candidateEntityIds: ['wine-opus-one-2019'],
    confidence: 0.8,
    source: 'alias',
    aliasType: inferredAliasType,
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
    const result = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(emptyEntityDocumentBatchLookup()));
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
    const result = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(makeUniformEntityDocumentBatchLookup('Opus One')));
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('blocker_seed');
    expect(String(result[0]?.entityId)).toBe('wine-blocker-only');
  });

  it('preloadedDocs 캐시 히트 → batch projection lookup은 identity overlay만 호출 (N+1 방어)', async () => {
    // 실질 검증: preloadedDocs에 이미 있는 ID는 getDocuments를 호출하면 안 됨
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const entityId = createEntityId('wine-preloaded');
    const preloadedDocs = new Map([[String(entityId), { entityId, entityType: 'wine' as const, canonicalLabel: 'Preloaded Wine' }]]);
    const getDocuments = vi.fn(async () => new Map());
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [makeAnchor({ candidateEntityIds: [entityId] })],
      preloadedDocs,
    };
    const getResolverProjections = vi.fn(async (ids: readonly typeof entityId[]) => {
      const m = new Map();
      for (const id of ids) {
        m.set(id, {
          entityId: id,
          entityType: 'wine',
          canonicalLabel: 'Preloaded Wine',
          aliasesIdentitySafe: [],
          identitySafeKeys: [],
          identityCertificates: [],
        });
      }
      return m;
    });
    await buildResolverCandidatesFromGenerator(input, { getResolverProjections });
    expect(getDocuments).not.toHaveBeenCalled();
    expect(getResolverProjections).toHaveBeenCalledTimes(1);
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
    const result = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(makeUniformEntityDocumentBatchLookup('Test')));
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
    const result = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(makeUniformEntityDocumentBatchLookup('Wine')));
    const aliasCandidate = result.find((c) => String(c.entityId) === String(idA));
    const heuristicCandidate = result.find((c) => String(c.entityId) === String(idB));
    expect(aliasCandidate?.source).toBe('alias');
    expect(heuristicCandidate?.source).toBe('planner_heuristic');
  });
});

// ─── TA2-3: buildResolverCandidatesFromGenerator module exports ───────────────

describe('buildResolverCandidatesFromGenerator module (TA2-3)', () => {
  it('anchor entityId가 batch lookup에서 누락되면 hydration 불완전으로 reject', async () => {
    // 실질 검증: 일부 ID만 복원되면 조용히 축소된 후보를 내지 말고 실패해야 함
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
    await expect(buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection({
      getDocuments: async (ids) => {
        const m = new Map();
        for (const id of ids) {
          if (String(id) === String(existingId)) {
            m.set(id, { entityId: id, entityType: 'wine', canonicalLabel: 'Exists' });
          }
        }
        return m;
      },
    }))).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
    });
  });

  it('legacy buildResolverCandidatesFromPlan API 제거 확인 — 마이그레이션 퇴행 방지', async () => {
    // 실질 검증: legacy API가 살아 돌아오면 마이그레이션이 롤백된 것
    const mod = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    expect('buildResolverCandidatesFromPlan' in mod).toBe(false);
  });

  it('fails closed when resolver projection lookup returns no documents for anchored ids', async () => {
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [makeAnchor()],
    };
    await expect(buildResolverCandidatesFromGenerator(input, {
      getResolverProjections: async () => new Map(),
    })).rejects.toMatchObject({
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
    // resolver projection lookup provided but no IDs to look up
    const result = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(emptyEntityDocumentBatchLookup()));
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
    const result = await buildResolverCandidatesFromGenerator(
      input,
      wrapEntityDocumentBatchLookupAsResolverProjection(makeUniformEntityDocumentBatchLookup('Opus One 2019')),
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

  it('TA2-4-BOUND-01: alpha > 0.5 → RangeError (above upper boundary)', async () => {
    // 실질 검증: alpha > 0.5 (유효 범위 (0, 0.5] 초과) → throw
    const { computeConformalSetSize } = await import('../../src/domain/resolver/service/resolver.js');
    expect(() => computeConformalSetSize(0.9, 0.501, 5)).toThrow(RangeError);
    expect(() => computeConformalSetSize(0.9, 0.75, 5)).toThrow(RangeError);
    expect(() => computeConformalSetSize(0.9, 1.0, 5)).toThrow(RangeError);
  });

  it('TA2-4-BOUND-02: alpha = 0.5 → does NOT throw (exactly at upper boundary)', async () => {
    // 실질 검증: alpha=0.5 는 유효 범위 (0, 0.5] 경계값 → throw 없이 정상 반환
    const { computeConformalSetSize } = await import('../../src/domain/resolver/service/resolver.js');
    expect(() => computeConformalSetSize(0.9, 0.5, 5)).not.toThrow();
    // alpha=0.499 도 유효 범위 내
    expect(() => computeConformalSetSize(0.9, 0.499, 5)).not.toThrow();
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
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        clarificationBias: 0,
        fallbackMode: 'fail',
        policyReasonCodes: [],
      },
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
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        clarificationBias: 0,
        fallbackMode: 'fail',
        policyReasonCodes: [],
      },
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
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        clarificationBias: 0,
        fallbackMode: 'fail',
        policyReasonCodes: [],
      },
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

// TA3 corrective-retry application loop removed (Entity Lookup V2 cutover).
// Resolver + multi-channel V2 authority owns exact-recovery; see entity-lookup-v2.usecase.ts.

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
  function makeEntityLookup(entries: Array<[string, string]>): EntityDocumentBatchLookup {
    return makeEntityDocumentBatchLookupFromEntries(entries);
  }

  // ── helper: anchor builder ──────────────────────────────────────────────────
  function makeAnchorFor(
    entityId: string,
    overrides: Partial<AnchorCandidate> = {},
  ): AnchorCandidate {
    const lookupStrategies = overrides.lookupStrategies ?? [];
    const inferredAliasType = overrides.aliasType
      ?? (lookupStrategies.includes('phonetic_exact')
        ? 'phonetic'
        : lookupStrategies.includes('transliterated_exact')
          ? 'translation'
          : lookupStrategies.includes('phonetic_fuzzy')
            || lookupStrategies.includes('fuzzy_char_ngram')
            || lookupStrategies.includes('transliterated_fuzzy')
            || lookupStrategies.includes('substring')
            ? 'misspelling'
            : 'canonical');
    return {
      surfaceForm: entityId,
      normalizedForm: entityId,
      candidateEntityIds: [createEntityId(entityId)],
      confidence: 0.85,
      source: 'alias',
      aliasType: inferredAliasType,
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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

    expect(candidates[0]?.source).toBe('alias');
    expect(candidates[0]?.sourceSignals.phoneticMatch).toBeGreaterThan(0);
    // RFC-006 §5.4 phonetic-only collapse: a purely phonetic_exact anchor routes
    // its confidence solely through the phoneticMatch lane and ZEROES the
    // identity-bearing lanes (aliasExactMatch/canonical*), so a phonetic collision
    // can never masquerade as an exact alias hit. See isPhoneticOnlyStrategySet.
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBe(0);
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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

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

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

    expect(candidates).toHaveLength(3);
    for (const candidate of candidates) {
      expect(candidate.source).toBe('blocker_seed');
      expect(candidate.sources).toEqual(['blocker_seed']);
      expect(candidate.aliasMatches).toHaveLength(0);
    }
  });

  it('P0-2-M: missing entity from lookup now fails closed instead of skipping silently', async () => {
    // Some IDs from anchors may not exist in the index (deleted wine, ETL gap).
    // The production path must fail loudly instead of returning a partial set.
    const lookup = makeEntityLookup([['real-wine', 'Real Wine']]); // ghost-wine not in lookup
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [
        makeAnchorFor('real-wine', { source: 'alias', confidence: 0.9 }),
        makeAnchorFor('ghost-wine', { source: 'alias', confidence: 0.8 }),
      ],
    };

    await expect(buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup))).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
    });
  });

  it('P0-2-N: preloadedDocs cache — skips full batch hydration but still runs identity overlay', async () => {
    const id = createEntityId('cached-wine');
    const getDocumentsSpy = vi.fn(async () => new Map([
      [id, {
        entityId: id,
        entityType: 'wine',
        canonicalLabel: 'Cached Wine',
        identityCertificates: [],
        aliasesIdentitySafe: [],
        identitySafeKeys: [],
      }],
    ]));
    const lookup: EntityDocumentBatchLookup = { getDocuments: getDocumentsSpy };

    const preloadedDocs: ReadonlyMap<string, { entityId: unknown; entityType: string; canonicalLabel: string }> =
      new Map([['cached-wine', { entityId: id, entityType: 'wine', canonicalLabel: 'Cached Wine' }]]);

    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'cached wine',
      normalizedQuery: 'cached wine',
      anchors: [makeAnchorFor('cached-wine', { source: 'alias', confidence: 0.9 })],
      preloadedDocs: preloadedDocs as EntityCandidateGeneratorInput['preloadedDocs'],
    };

    const candidates = await buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

    // Prefetch covers canonical fields; overlay fetch runs once for identity projection only.
    expect(getDocumentsSpy).toHaveBeenCalledTimes(1);
    expect(getDocumentsSpy).toHaveBeenCalledWith([id]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.canonicalLabel).toBe('Cached Wine');
  });

  it('P0-2-O: lookupVariants on anchor do NOT affect signal computation (provenance-only field)', async () => {
    // lookupVariants is provenance metadata — it must not change scoring signals.
    // Two otherwise-identical anchors with/without lookupVariants should produce
    // the same sourceSignals.
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

    const candidatesWith = await buildResolverCandidatesFromGenerator(withVariants, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));
    const candidatesWithout = await buildResolverCandidatesFromGenerator(withoutVariants, wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

    expect(candidatesWith[0]?.sourceSignals).toEqual(candidatesWithout[0]?.sourceSignals);
  });
});
