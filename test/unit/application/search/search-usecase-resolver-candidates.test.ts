import { describe, expect, it, vi } from 'vitest';
import { buildResolverCandidatesFromGenerator } from '../../../../src/application/search/search-usecase-resolver-candidates.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import type { CanonicalEntityId } from '../../../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../../src/domain/retrieval/model/retrieval-document.js';
import type { EntityDocumentLookupPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import type { EntityCandidateGeneratorInput } from '../../../../src/domain/resolver/model/entity-candidate-generator-input.js';

/**
 * T-E4-01: Helper to build a batch-capable lookup port from a single-document
 * resolver function. Mirrors the production contract where getDocuments() is
 * the required path and getDocument() is deprecated/test-only.
 */
function makeBatchLookup(
  singleFn: (id: CanonicalEntityId) => Promise<RetrievalDocument | null>,
): EntityDocumentLookupPort {
  return {
    getDocuments: vi.fn(async (ids: readonly CanonicalEntityId[]) => {
      const map = new Map<CanonicalEntityId, RetrievalDocument>();
      for (const id of ids) {
        const doc = await singleFn(id);
        if (doc != null) {
          map.set(id, doc);
        }
      }
      return map;
    }),
  };
}

function makeGeneratorInput(): EntityCandidateGeneratorInput {
  return {
    rawQuery: '오푸스원 2018',
    normalizedQuery: '오푸스원 2018',
    anchors: [
      {
        surfaceForm: '오푸스원',
        normalizedForm: '오푸스원',
        candidateEntityIds: [createEntityId('opus-one-2018')],
        lookupStrategies: ['transliterated_exact'],
        confidence: 0.97,
        source: 'alias',
      },
    ],
  };
}

describe('buildResolverCandidatesFromGenerator', () => {
  it('hydrates resolver candidates via batch getDocuments and preserves provenance signals', async () => {
    const entityId = createEntityId('opus-one-2018');
    const doc = {
      entityId,
      entityType: 'wine' as const,
      canonicalLabel: 'Opus One 2018',
    };
    const lookup = makeBatchLookup(async () => doc);

    const candidates = await buildResolverCandidatesFromGenerator(makeGeneratorInput(), lookup);

    expect(lookup.getDocuments).toHaveBeenCalledWith([entityId]);
    expect(candidates).toEqual([
      expect.objectContaining({
        entityId,
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
        aliasMatches: [
          expect.objectContaining({
            aliasValue: '오푸스원',
            aliasType: 'translation',
            matchScore: 0.97,
          }),
        ],
        sourceSignals: expect.objectContaining({
          canonicalNormalizedMatch: 0.97,
          aliasExactMatch: 0.97,
          aliasFuzzyMatch: 0,
        }),
        source: 'alias',
        sources: ['alias'],
      }),
    ]);
  });

  it('merges mixed-source support for the same entity without losing provenance', async () => {
    const entityId = createEntityId('opus-one-2018');
    const doc = {
      entityId,
      entityType: 'wine' as const,
      canonicalLabel: 'Opus One 2018',
    };
    const lookup = makeBatchLookup(async () => doc);

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '오푸스원 opus one',
        normalizedQuery: '오푸스원 opus one',
        anchors: [
          {
            ...makeGeneratorInput().anchors[0]!,
            source: 'alias',
          },
          {
            surfaceForm: 'opus one',
            normalizedForm: 'opus one',
            candidateEntityIds: [createEntityId('opus-one-2018')],
            lookupStrategies: ['fuzzy_char_ngram'],
            confidence: 0.7,
            source: 'planner_heuristic',
          },
        ],
      },
      lookup,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        source: undefined,
        sources: ['alias', 'planner_heuristic'],
      }),
    );
    expect(candidates[0]?.aliasMatches).toHaveLength(2);
  });

  it('keeps exact identity signal only for candidates whose identity-safe projection matches the anchor', async () => {
    const grandVinId = createEntityId('chateau-margaux-grand-vin');
    const secondWineId = createEntityId('pavillon-rouge-du-chateau-margaux');
    const docs = new Map<CanonicalEntityId, RetrievalDocument>([
      [grandVinId, {
        entityId: grandVinId,
        entityType: 'wine',
        canonicalLabel: '2022 Château Margaux Château Margaux (Premier Grand Cru Classé)',
        producer: 'Château Margaux',
        aliasesIdentitySafe: ['Château Margaux', 'Château Margaux 2022'],
      } as unknown as RetrievalDocument],
      [secondWineId, {
        entityId: secondWineId,
        entityType: 'wine',
        canonicalLabel: '1982 Château Margaux Pavillon Rouge du Château Margaux',
        producer: 'Château Margaux',
        aliasesIdentitySafe: [
          'Château Margaux',
          'Château Margaux 1982',
          'Pavillon Rouge du Château Margaux',
          'Pavillon Rouge du Château Margaux 1982',
        ],
      } as unknown as RetrievalDocument],
    ]);
    const lookup = makeBatchLookup(async (id) => docs.get(id) ?? null);

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '샤또 마고',
        normalizedQuery: '샤또 마고',
        anchors: [
          {
            surfaceForm: '샤또 마고',
            normalizedForm: '샤또 마고',
            candidateEntityIds: [grandVinId, secondWineId],
            lookupVariants: ['chateau margaux'],
            lookupStrategies: ['transliterated_exact'],
            confidence: 0.97,
            source: 'alias',
          },
        ],
      },
      lookup,
    );

    const grandVin = candidates.find((candidate) => candidate.entityId === grandVinId);
    const secondWine = candidates.find((candidate) => candidate.entityId === secondWineId);

    expect(grandVin?.sourceSignals.aliasExactMatch).toBeCloseTo(0.97);
    expect(secondWine?.sourceSignals.aliasExactMatch).toBe(0);
    expect(secondWine?.sourceSignals.canonicalNormalizedMatch).toBe(0);
  });

  it('uses batch getDocuments as the sole production hydration path', async () => {
    const entityId = createEntityId('opus-one-2018');
    const getDocuments = vi.fn().mockResolvedValue(
      new Map([
        [entityId, {
          entityId,
          entityType: 'wine',
          canonicalLabel: 'Opus One 2018',
        }],
      ]),
    );

    const candidates = await buildResolverCandidatesFromGenerator(
      makeGeneratorInput(),
      { getDocuments },
    );

    expect(getDocuments).toHaveBeenCalledWith([entityId]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.canonicalLabel).toBe('Opus One 2018');
  });

  it('throws batch_lookup_failed when getDocuments rejects', async () => {
    const getDocuments = vi.fn().mockRejectedValue(new Error('Vespa timeout'));

    await expect(
      buildResolverCandidatesFromGenerator(makeGeneratorInput(), { getDocuments }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
      message: expect.stringContaining('batch_lookup_failed'),
    });
  });

  it('throws partial_resolution_forbidden when batch returns incomplete results', async () => {
    const missingId = createEntityId('missing-wine');
    const presentId = createEntityId('present-wine');
    const getDocuments = vi.fn().mockResolvedValue(
      new Map([
        [presentId, {
          entityId: presentId,
          entityType: 'wine',
          canonicalLabel: 'Present Wine',
        }],
      ]),
    );

    const input = {
      rawQuery: '오푸스원',
      normalizedQuery: '오푸스원',
      anchors: [
        {
          surfaceForm: '오푸스원',
          normalizedForm: '오푸스원',
          candidateEntityIds: [presentId, missingId],
          lookupStrategies: ['transliterated_exact'] as const,
          confidence: 0.93,
          source: 'alias' as const,
        },
      ],
    };

    await expect(
      buildResolverCandidatesFromGenerator(input, { getDocuments }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
      message: expect.stringContaining('partial_resolution_forbidden'),
    });
  });
});

// ─── 수학적 완결성: mergeSignals 교환법칙 · 멱등법칙 · 3-anchor max() ──────────
//
// mergeSignals(left, right) = { field: Math.max(left[field], right[field]) }
// 이 구현은:
//   - 교환법칙: mergeSignals(A, B) = mergeSignals(B, A)  (Math.max 는 대칭)
//   - 멱등법칙: mergeSignals(A, A) = A                  (max(x,x)=x)
//   - 결합법칙: merge(merge(A,B),C) = merge(A,merge(B,C)) (3-anchor 경우)
//
// mergeSignals 는 private 이므로 buildResolverCandidatesFromGenerator 를 통해
// 동일 entityId 의 두 앵커를 순서를 바꿔 입력하여 결과 소스 신호를 비교한다.

describe('mergeSignals — 수학적 속성 (교환법칙 · 멱등법칙 · 3-anchor max)', () => {
  function makeLookup(entityId: string): EntityDocumentLookupPort {
    const doc = {
      entityId: createEntityId(entityId),
      entityType: 'wine' as const,
      canonicalLabel: 'Test Wine',
    };
    return makeBatchLookup(async () => doc);
  }

  it('MS-COMM-01: 교환법칙 — anchor(A=0.9, B=0.6) vs anchor(B=0.6, A=0.9) 동일 신호', async () => {
    const entityId = 'wine-comm-01';
    const lookup = makeLookup(entityId);

    // A-then-B
    const r1 = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'test',
        normalizedQuery: 'test',
        anchors: [
          {
            surfaceForm: 'test high',
            normalizedForm: 'test high',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            confidence: 0.9, // 높은 confidence
            source: 'alias',
          },
          {
            surfaceForm: 'test low',
            normalizedForm: 'test low',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['fuzzy_char_ngram'],
            confidence: 0.6, // 낮은 confidence
            source: 'planner_heuristic',
          },
        ],
      },
      lookup,
    );

    // B-then-A (순서 반전)
    const r2 = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'test',
        normalizedQuery: 'test',
        anchors: [
          {
            surfaceForm: 'test low',
            normalizedForm: 'test low',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['fuzzy_char_ngram'],
            confidence: 0.6,
            source: 'planner_heuristic',
          },
          {
            surfaceForm: 'test high',
            normalizedForm: 'test high',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            confidence: 0.9,
            source: 'alias',
          },
        ],
      },
      lookup,
    );

    // sourceSignals 는 merge 결과 — 교환법칙: 순서 무관하게 동일해야 함
    expect(r1[0]?.sourceSignals).toEqual(r2[0]?.sourceSignals);
  });

  it('MS-IDEM-01: 멱등법칙 — 동일 anchor 두 번 = 한 번의 결과 (max(x,x)=x)', async () => {
    const entityId = 'wine-idem-01';
    const lookup = makeLookup(entityId);
    const sameAnchor = {
      surfaceForm: 'opus one',
      normalizedForm: 'opus one',
      candidateEntityIds: [createEntityId(entityId)],
      lookupStrategies: ['exact' as const],
      confidence: 0.85,
      source: 'alias' as const,
    };

    // 동일 anchor 1회
    const r1 = await buildResolverCandidatesFromGenerator(
      { rawQuery: 'opus one', normalizedQuery: 'opus one', anchors: [sameAnchor] },
      lookup,
    );
    // 동일 anchor 2회 (중복)
    const r2 = await buildResolverCandidatesFromGenerator(
      { rawQuery: 'opus one', normalizedQuery: 'opus one', anchors: [sameAnchor, sameAnchor] },
      lookup,
    );

    // max(0.85, 0.85) = 0.85 — 멱등
    expect(r2[0]?.sourceSignals).toEqual(r1[0]?.sourceSignals);
    // 단일 엔티티
    expect(r2).toHaveLength(1);
  });

  it('MS-MAX-01: 3-anchor merge — max() 가 세 anchor 모두에서 가장 높은 값을 선택', async () => {
    const entityId = 'wine-max-01';
    const lookup = makeLookup(entityId);

    // 세 앵커: confidence = 0.5, 0.8, 0.95
    // aliasExactMatch = confidence (transliterated 전략 아닐 때 exact 전략에서 aliasExactMatch = confidence)
    // canonicalNormalizedMatch 도 confidence 로 설정
    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'test',
        normalizedQuery: 'test',
        anchors: [
          {
            surfaceForm: 'test a',
            normalizedForm: 'test a',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            confidence: 0.5,
            source: 'alias',
          },
          {
            surfaceForm: 'test b',
            normalizedForm: 'test b',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            confidence: 0.95, // 이것이 max 가 되어야 함
            source: 'alias',
          },
          {
            surfaceForm: 'test c',
            normalizedForm: 'test c',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            confidence: 0.8,
            source: 'alias',
          },
        ],
      },
      lookup,
    );

    expect(candidates).toHaveLength(1);
    // aliasExactMatch 는 세 앵커 중 max → 0.95
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
    // canonicalNormalizedMatch 도 max → 0.95
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBeCloseTo(0.95);
    // aliasMatches 는 3개 모두 보존
    expect(candidates[0]?.aliasMatches).toHaveLength(3);
  });

  it('MS-MAX-02: 3-anchor max — 낮은 confidence 앵커가 마지막에 와도 결과 동일', async () => {
    const entityId = 'wine-max-02';
    const lookup = makeLookup(entityId);

    const makeInput = (order: [number, number, number]) =>
      buildResolverCandidatesFromGenerator(
        {
          rawQuery: 'test',
          normalizedQuery: 'test',
          anchors: order.map((conf, i) => ({
            surfaceForm: `test ${i}`,
            normalizedForm: `test ${i}`,
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact' as const],
            confidence: conf,
            source: 'alias' as const,
          })),
        },
        lookup,
      );

    // 세 순서 모두 동일 결과
    const [r1, r2, r3] = await Promise.all([
      makeInput([0.5, 0.95, 0.8]),
      makeInput([0.95, 0.5, 0.8]),
      makeInput([0.8, 0.5, 0.95]),
    ]);

    expect(r1[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
    expect(r2[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
    expect(r3[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
  });
});
