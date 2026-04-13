import { describe, expect, it, vi } from 'vitest';
import { buildResolverCandidatesFromGenerator } from '../../../../src/application/search/search-usecase-resolver-candidates.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import type { EntityDocumentLookupPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import type { EntityCandidateGeneratorInput } from '../../../../src/domain/resolver/model/entity-candidate-generator-input.js';

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
  it('hydrates resolver candidates from anchor entity ids and preserves provenance signals', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      entityId: createEntityId('opus-one-2018'),
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
    });

    const candidates = await buildResolverCandidatesFromGenerator(makeGeneratorInput(), { getDocument });

    expect(getDocument).toHaveBeenCalledWith(createEntityId('opus-one-2018'));
    expect(candidates).toEqual([
      expect.objectContaining({
        entityId: createEntityId('opus-one-2018'),
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
    const getDocument = vi.fn().mockResolvedValue({
      entityId: createEntityId('opus-one-2018'),
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
    });

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
      { getDocument },
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

  it('prefers batch document hydration when getDocuments is available', async () => {
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
    const getDocument = vi.fn();

    const candidates = await buildResolverCandidatesFromGenerator(
      makeGeneratorInput(),
      { getDocuments, getDocument },
    );

    expect(getDocuments).toHaveBeenCalledWith([entityId]);
    expect(getDocument).not.toHaveBeenCalled();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.canonicalLabel).toBe('Opus One 2018');
  });

  it('rejects when hydration remains incomplete after batch and single fetches', async () => {
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
    const getDocument = vi.fn(async (id) => {
      if (String(id) === String(presentId)) {
        return {
          entityId: presentId,
          entityType: 'wine',
          canonicalLabel: 'Present Wine',
        };
      }
      return null;
    });

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
      buildResolverCandidatesFromGenerator(input, { getDocuments, getDocument }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
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
    return {
      getDocument: vi.fn().mockResolvedValue({
        entityId: createEntityId(entityId),
        entityType: 'wine',
        canonicalLabel: 'Test Wine',
      }),
    };
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
