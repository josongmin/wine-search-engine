import { describe, it, expect, vi } from 'vitest';
import {
  AnchorExtractor,
  type AliasLookupOptions,
  type AliasMatcher,
  type AliasMatchResult,
} from '../service/anchor-extractor.js';
import type { AnchorConditionedQuery } from '../model/relative-query.js';
import { QueryNormalizer } from '../service/query-normalizer.js';
import { createEntityId } from '../../shared/types/index.js';
import { bootstrapLogger } from '../../shared/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';

// ── Stub AliasMatcher ─────────────────────────────────────────────────────────
// For most tests we use a fixed-response stub so extraction logic is isolated.

class StubAliasMatcher implements AliasMatcher {
  constructor(private readonly responses: Map<string, readonly AliasMatchResult[]> = new Map()) {}

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    // Check for substring matches
    for (const [key, results] of this.responses) {
      if (normalizedQuery.includes(key)) {
        return results;
      }
    }
    return [];
  }
}

class EmptyAliasMatcher implements AliasMatcher {
  async findMatches(_query: string): Promise<readonly AliasMatchResult[]> {
    return [];
  }
}

class ExactAliasMatcher implements AliasMatcher {
  constructor(private readonly responses: Map<string, readonly AliasMatchResult[]> = new Map()) {}

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return this.responses.get(normalizedQuery) ?? [];
  }
}

class RecordingExactAliasMatcher extends ExactAliasMatcher {
  readonly queries: string[] = [];

  override async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    this.queries.push(normalizedQuery);
    return super.findMatches(normalizedQuery);
  }
}

class ScopeRecordingAliasMatcher implements AliasMatcher {
  readonly calls: Array<{ query: string; scope: string }> = [];

  async findMatches(
    normalizedQuery: string,
    options?: AliasLookupOptions,
  ): Promise<readonly AliasMatchResult[]> {
    this.calls.push({
      query: normalizedQuery,
      scope: options?.scope ?? 'default',
    });
    if (normalizedQuery === '오푸' && options?.scope === 'span') {
      return [makeMatchResult('Opus One', ['entity-opus-one'], 0.95)];
    }
    return [];
  }

  async findMatchesBatch(
    normalizedQueries: readonly string[],
    options?: AliasLookupOptions,
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const result = new Map<string, readonly AliasMatchResult[]>();
    for (const query of normalizedQueries) {
      this.calls.push({
        query,
        scope: options?.scope ?? 'default',
      });
      if (query === '오푸' && options?.scope === 'span') {
        result.set(query, [makeMatchResult('Opus One', ['entity-opus-one'], 0.95)]);
        continue;
      }
      result.set(query, []);
    }
    return result;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMatchResult(
  surfaceForm: string,
  entityIds: string[],
  confidence: number = 0.9,
): AliasMatchResult {
  return {
    surfaceForm,
    normalizedForm: surfaceForm.toLowerCase(),
    entityIds: entityIds.map((id) => createEntityId(id)),
    matchConfidence: confidence,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AnchorExtractor', () => {
  const normalizer = new QueryNormalizer();

  describe('Korean query extraction', () => {
    it('"오푸스원 같은 10만원 와인" → anchor: "오푸스원", marker: "같은"', async () => {
      const aliasMatcher = new StubAliasMatcher(
        new Map([['오푸스원', [makeMatchResult('오푸스원', ['entity-opus-one'], 0.92)]]]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      const anchors = await extractor.extract('오푸스원 같은 10만원 와인');
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.surfaceForm).toBe('오푸스원');

      // Verify the comparison marker is detected
      const hasMarker = extractor.hasKoreanMixedQueryMarkers('오푸스원 같은 10만원 와인');
      expect(hasMarker).toBe(true);
    });

    it('"까쇼 추천해줘" → trailing request words do not block grape anchor extraction', async () => {
      const aliasMatcher = new ExactAliasMatcher(
        new Map([
          ['cabernet sauvignon', [makeMatchResult('Cabernet Sauvignon', ['entity-cabernet-sauvignon'], 0.95)]],
        ]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      const result = await extractor.extract('까쇼 추천해줘', normalizer.normalize('까쇼 추천해줘'));
      expect(result).toHaveLength(1);
      expect(result[0]?.surfaceForm).toBe('Cabernet Sauvignon');
      expect(result[0]?.lookupVariants).toEqual(
        expect.arrayContaining(['cabernet sauvignon']),
      );
    });

    it('"오푸" → curated Korean prefix transliteration still extracts the Opus One anchor', async () => {
      const aliasMatcher = new ExactAliasMatcher(
        new Map([
          ['opus one', [makeMatchResult('Opus One', ['entity-opus-one'], 0.95)]],
        ]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      const result = await extractor.extract('오푸', normalizer.normalize('오푸'));
      expect(result).toHaveLength(1);
      expect(result[0]?.surfaceForm).toBe('Opus One');
      expect(result[0]?.lookupVariants).toEqual(
        expect.arrayContaining(['opus one']),
      );
    });

    it('"마고 비슷한 레드와인" → anchor: "마고", marker: "비슷한"', async () => {
      const aliasMatcher = new StubAliasMatcher(
        new Map([['마고', [makeMatchResult('마고', ['entity-margaux'], 0.88)]]]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      const anchors = await extractor.extract('마고 비슷한 레드와인');
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.surfaceForm).toBe('마고');

      const hasMarker = extractor.hasKoreanMixedQueryMarkers('마고 비슷한 레드와인');
      expect(hasMarker).toBe(true);
    });

    it('"카베르네 말고 피노누아" → exclusion marker "말고" detected', async () => {
      const extractor = new AnchorExtractor(new EmptyAliasMatcher());
      const hasMarker = extractor.hasKoreanMixedQueryMarkers('카베르네 말고 피노누아');
      expect(hasMarker).toBe(true);
    });

    it('"레드 와인 추천" → no anchor extracted (empty alias matches)', async () => {
      const extractor = new AnchorExtractor(new EmptyAliasMatcher());
      const anchors = await extractor.extract('레드 와인 추천');
      expect(anchors).toHaveLength(0);
    });
  });

  it('omits atomic deterministic grape and region tokens from lookup queries inside a longer mixed surface', () => {
    const extractor = new AnchorExtractor(new EmptyAliasMatcher());
    const lookupQueries = (
      extractor as unknown as {
        buildLookupQueries(query: string): {
          readonly baseQueries: readonly string[];
          readonly spanQueries: readonly { readonly query: string }[];
        };
      }
    ).buildLookupQueries('cloudy dreams marlborough sauvignon blanc');

    expect(lookupQueries.baseQueries).toEqual([
      'cloudy dreams marlborough sauvignon blanc',
      'cloudydreamsmarlboroughsauvignonblanc',
    ]);
    expect(lookupQueries.spanQueries.map((entry) => entry.query)).not.toEqual(
      expect.arrayContaining([
        'marlborough',
        'sauvignon',
        'blanc',
        'sauvignon blanc',
        'marlborough sauvignon',
        'marlborough sauvignon blanc',
      ]),
    );
  });

  describe('English anchor extraction', () => {
    it('"Opus One 같은" → English anchor extracted', async () => {
      const aliasMatcher = new StubAliasMatcher(
        new Map([['opus one', [makeMatchResult('Opus One', ['entity-opus-one'], 0.95)]]]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      // Anchor extractor works on normalized (lowercased) query
      const anchors = await extractor.extract('opus one 같은');
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.surfaceForm).toBe('Opus One');

      const hasMarker = extractor.hasKoreanMixedQueryMarkers('opus one 같은');
      expect(hasMarker).toBe(true);
    });
  });

  describe('anchor sorting', () => {
    it('anchors are sorted by confidence descending', async () => {
      const aliasMatcher: AliasMatcher = {
        async findMatches(_query: string): Promise<readonly AliasMatchResult[]> {
          return [
            makeMatchResult('low-confidence', ['entity-a'], 0.5),
            makeMatchResult('high-confidence', ['entity-b'], 0.95),
            makeMatchResult('mid-confidence', ['entity-c'], 0.7),
          ];
        },
      };
      const extractor = new AnchorExtractor(aliasMatcher);
      const anchors = await extractor.extract('some query');
      expect(anchors[0]?.surfaceForm).toBe('high-confidence');
      expect(anchors[1]?.surfaceForm).toBe('mid-confidence');
      expect(anchors[2]?.surfaceForm).toBe('low-confidence');
    });
  });

  describe('exact-first span gating', () => {
    it('does not let span fallbacks inject other entities once base lookup yields a unique exact-like entity', async () => {
      const aliasMatcher = new ExactAliasMatcher(
        new Map([
          ['샤토 마고', [{
            surfaceForm: '샤토 마고',
            normalizedForm: '샤토 마고',
            entityIds: [createEntityId('entity-margaux')],
            matchConfidence: 0.95,
            lookupStrategy: 'exact',
          }]],
          ['chateau', [{
            surfaceForm: "Château d'Yquem",
            normalizedForm: "château d'yquem",
            entityIds: [createEntityId('entity-yquem')],
            matchConfidence: 0.85,
            lookupStrategy: 'substring',
          }]],
        ]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      const anchors = await extractor.extract('샤또 마고', normalizer.normalize('샤또 마고'));

      expect(anchors.map((anchor) => anchor.surfaceForm)).toContain('샤토 마고');
      expect(anchors.map((anchor) => anchor.candidateEntityIds.map(String))).toEqual(
        expect.not.arrayContaining([
          expect.arrayContaining(['entity-yquem']),
        ]),
      );
    });

    it('does not merge lower-priority base token lookups once a full-query exact-like entity is already decisive', async () => {
      const aliasMatcher = new RecordingExactAliasMatcher(
        new Map([
          ['샤토 라투르', [{
            surfaceForm: '샤토 라투르',
            normalizedForm: '샤토 라투르',
            entityIds: [createEntityId('entity-latour')],
            matchConfidence: 0.95,
            lookupStrategy: 'exact',
          }]],
          ['샤토', [
            {
              surfaceForm: '샤또 라피트',
              normalizedForm: '샤또 라피트',
              entityIds: [createEntityId('entity-lafite')],
              matchConfidence: 0.9,
              lookupStrategy: 'prefix_exact',
            },
            {
              surfaceForm: '샤또 무통',
              normalizedForm: '샤또 무통',
              entityIds: [createEntityId('entity-mouton')],
              matchConfidence: 0.9,
              lookupStrategy: 'prefix_exact',
            },
          ]],
        ]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      const anchors = await extractor.extract('샤토 라투르', normalizer.normalize('샤토 라투르'));

      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.surfaceForm).toBe('샤토 라투르');
      expect(aliasMatcher.queries).toContain('샤토 라투르');
      expect(aliasMatcher.queries).not.toContain('샤토');
    });
  });

  describe('Korean mixed-query markers', () => {
    const extractor = new AnchorExtractor(new EmptyAliasMatcher());

    it('detects 같은', () => {
      expect(extractor.hasKoreanMixedQueryMarkers('마고 같은 와인')).toBe(true);
    });

    it('detects 비슷한', () => {
      expect(extractor.hasKoreanMixedQueryMarkers('마고 비슷한 와인')).toBe(true);
    });

    it('detects 말고', () => {
      expect(extractor.hasKoreanMixedQueryMarkers('카베르네 말고')).toBe(true);
    });

    it('detects 대신', () => {
      expect(extractor.hasKoreanMixedQueryMarkers('마고 대신 추천')).toBe(true);
    });

    it('detects 보다', () => {
      expect(extractor.hasKoreanMixedQueryMarkers('마고 보다 저렴한')).toBe(true);
    });

    it('returns false when no markers present', () => {
      expect(extractor.hasKoreanMixedQueryMarkers('레드 와인 추천')).toBe(false);
    });
  });

  describe('comparison markers', () => {
    const extractor = new AnchorExtractor(new EmptyAliasMatcher());

    it('detects "vs"', () => {
      expect(extractor.hasComparisonMarkers('opus one vs screaming eagle')).toBe(true);
    });

    it('detects "versus"', () => {
      expect(extractor.hasComparisonMarkers('opus one versus screaming eagle')).toBe(true);
    });

    it('detects "compared to"', () => {
      expect(extractor.hasComparisonMarkers('opus one compared to margaux')).toBe(true);
    });

    it('detects Korean comparison phrasing', () => {
      expect(extractor.hasComparisonMarkers('보르도랑 나파 카베르네 비교해줘')).toBe(true);
    });

    it('returns false for plain queries', () => {
      expect(extractor.hasComparisonMarkers('red wine recommendation')).toBe(false);
    });
  });

  describe('anchor candidate shape', () => {
    it('extracted anchor has correct source field', async () => {
      const aliasMatcher = new StubAliasMatcher(
        new Map([['오푸스원', [makeMatchResult('오푸스원', ['entity-opus-one'], 0.9)]]]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);
      const anchors = await extractor.extract('오푸스원');
      expect(anchors[0]?.source).toBe('alias');
    });

    it('extracted anchor carries candidateEntityIds from alias match', async () => {
      const entityId = createEntityId('entity-opus-one');
      const aliasMatcher: AliasMatcher = {
        async findMatches(_query: string): Promise<readonly AliasMatchResult[]> {
          return [{
            surfaceForm: '오푸스원',
            normalizedForm: '오푸스원',
            entityIds: [entityId],
            matchConfidence: 0.9,
          }];
        },
      };
      const extractor = new AnchorExtractor(aliasMatcher);
      const anchors = await extractor.extract('오푸스원');
      expect(anchors[0]?.candidateEntityIds).toContain(entityId);
    });
  });

  describe('extractWithRelative', () => {
    // Test 11: "오퍼스 원 같은" returns both anchors and relativeQuery
    it('11. "오퍼스 원 같은" returns anchor candidates and relativeQuery', async () => {
      const aliasMatcher = new StubAliasMatcher(
        new Map([['오퍼스 원', [makeMatchResult('오퍼스 원', ['entity-opus-one'], 0.9)]]]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      const result = await extractor.extractWithRelative('오퍼스 원 같은');

      // Should have anchor candidate from alias matcher
      expect(result.anchors).toHaveLength(1);
      expect(result.anchors[0]?.surfaceForm).toBe('오퍼스 원');

      // Should have relative query
      expect(result.relativeQuery).not.toBeNull();
      const relativeQuery: AnchorConditionedQuery = result.relativeQuery!;
      expect(relativeQuery.isSimilarityQuery).toBe(true);
      expect(relativeQuery.relativeExpressions[0]?.operator).toBe('similar_to');
      expect(relativeQuery.relativeExpressions[0]?.anchorSurfaceForm).toBe('오퍼스 원');
    });

    // Test 12: plain entity query returns relativeQuery: null
    it('12. plain entity query returns relativeQuery: null', async () => {
      const aliasMatcher = new StubAliasMatcher(
        new Map([['보르도', [makeMatchResult('보르도', ['entity-bordeaux'], 0.9)]]]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      const result = await extractor.extractWithRelative('보르도 와인');

      // relativeQuery should be null — no relative pattern
      expect(result.relativeQuery).toBeNull();
    });

    it('13. anchor-conditioned negation reuses extracted anchor surface as direct lookup query', async () => {
      const aliasMatcher = new ExactAliasMatcher(
        new Map([['클라우디베이', [makeMatchResult('클라우디베이', ['entity-cloudy-bay'], 0.94)]]]),
      );
      const extractor = new AnchorExtractor(aliasMatcher);

      const result = await extractor.extractWithRelative('클라우디베이 말고 다른 화이트');

      expect(result.relativeQuery?.relativeExpressions[0]?.operator).toBe('not');
      expect(result.anchors).toHaveLength(1);
      expect(result.anchors[0]?.surfaceForm).toBe('클라우디베이');
      expect(result.anchors[0]?.lookupVariants).toEqual(
        expect.arrayContaining(['클라우디베이']),
      );
    });
  });

  describe('batch alias lookup integration', () => {
    it('uses AliasMatcher.findMatchesBatch when available to avoid repeated per-variant lookups', async () => {
      const batchLookup = vi.fn(async (queries: readonly string[]) => {
        const result = new Map<string, readonly AliasMatchResult[]>();
        for (const query of queries) {
          result.set(
            query,
            query === '오푸스원'
              ? [makeMatchResult('오푸스원', ['entity-opus-one'], 0.92)]
              : [],
          );
        }
        return result;
      });
      const singleLookup = vi.fn(async (_query: string): Promise<readonly AliasMatchResult[]> => {
        throw new Error('single lookup should not be used when batch is available');
      });
      const extractor = new AnchorExtractor({
        findMatches: singleLookup,
        findMatchesBatch: batchLookup,
      });

      const anchors = await extractor.extract(
        '오푸스원 지금 마시기 좋아?',
        normalizer.normalize('오푸스원 지금 마시기 좋아?'),
      );

      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.surfaceForm).toBe('오푸스원');
      expect(batchLookup).toHaveBeenCalledTimes(3);
      expect(batchLookup.mock.calls.map((call) => call[1])).toEqual(
        expect.arrayContaining([
          { scope: 'surface' },
          { scope: 'span' },
          {
            scope: 'span',
            recallMode: 'surface_only',
          },
        ]),
      );
      expect(singleLookup).not.toHaveBeenCalled();
    });

    it('uses strict whole-surface batch lookup before broad span fallback', async () => {
      const aliasMatcher = new ScopeRecordingAliasMatcher();
      const extractor = new AnchorExtractor(aliasMatcher);

      const anchors = await extractor.extract('오푸', normalizer.normalize('오푸'));

      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.surfaceForm).toBe('Opus One');
      const surfaceCalls = aliasMatcher.calls.filter((call) => call.scope === 'surface');
      const spanCalls = aliasMatcher.calls.filter((call) => call.scope === 'span');
      expect(surfaceCalls.map((call) => call.query)).toContain('오푸');
      expect(spanCalls.map((call) => call.query)).toContain('오푸');
      const firstSpanIndex = aliasMatcher.calls.findIndex((call) => call.scope === 'span');
      const lastSurfaceIndex = aliasMatcher.calls.reduce((last, call, index) => (
        call.scope === 'surface' ? index : last
      ), -1);
      expect(firstSpanIndex).toBeGreaterThan(lastSurfaceIndex);
    });

    it('does not emit phonetic compact acronyms as direct alias lookup queries for lexical latin input', async () => {
      const batchLookup = vi.fn(async (queries: readonly string[]) => {
        const result = new Map<string, readonly AliasMatchResult[]>();
        for (const query of queries) {
          result.set(query, []);
        }
        return result;
      });
      const extractor = new AnchorExtractor({
        findMatches: vi.fn(async () => []),
        findMatchesBatch: batchLookup,
      });

      await extractor.extract('opus', normalizer.normalize('opus'));

      expect(batchLookup).toHaveBeenCalledTimes(2);
      const queried = batchLookup.mock.calls.flatMap((call) => call[0] ?? []);
      expect(queried).toContain('opus');
      expect(queried).not.toContain('ps');
    });

    it('resolves multiple fuzzy terms with batch lookup when available', async () => {
      const batchLookup = vi.fn(async (queries: readonly string[]) => {
        const result = new Map<string, readonly AliasMatchResult[]>();
        for (const query of queries) {
          result.set(
            query,
            query.length > 0 ? [makeMatchResult(query, ['entity-fuzzy'], 0.88)] : [],
          );
        }
        return result;
      });
      const extractor = new AnchorExtractor({
        findMatches: vi.fn(async (_query: string): Promise<readonly AliasMatchResult[]> => {
          return [];
        }),
        findMatchesBatch: batchLookup,
      });

      const results = await extractor.lookupForFuzzyTerms([
        'opus one',
        'pinot noir',
        'opus one',
      ]);

      expect(results.get('opus one')?.map((entry) => entry.normalizedForm)).toEqual(['opus one']);
      expect(results.get('pinot noir')?.map((entry) => entry.normalizedForm)).toEqual(['pinot noir']);
      expect(batchLookup).toHaveBeenCalledTimes(1);
    });

    it('returns an empty Map and logs a warning when the batch lookup throws', async () => {
      const warnSpy = vi
        .spyOn(bootstrapLogger, 'warn')
        .mockImplementation(() => bootstrapLogger);
      globalSilentSkipCounter.reset();
      const lookupError = new Error('batch matcher unavailable');
      const extractor = new AnchorExtractor({
        findMatches: vi.fn(async (_query: string): Promise<readonly AliasMatchResult[]> => {
          return [];
        }),
        findMatchesBatch: vi.fn(async (): Promise<never> => {
          throw lookupError;
        }),
      });

      const results = await extractor.lookupForFuzzyTerms(['opus one', 'pinot noir']);

      // Degradation behavior is preserved: every term maps to an empty list.
      expect(results.get('opus one')).toEqual([]);
      expect(results.get('pinot noir')).toEqual([]);

      // The failure is now observable instead of being silently swallowed.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ err: lookupError });
      expect(
        globalSilentSkipCounter.snapshot().anchor_fuzzy_term_batch_lookup_failure,
      ).toBe(1);

      warnSpy.mockRestore();
      globalSilentSkipCounter.reset();
    });
  });

  describe('multi-view noisy lookup', () => {
    it('recovers aliases from transliterated and compact views', async () => {
      const aliasMatcher: AliasMatcher = {
        async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
          if (normalizedQuery === 'opusone18') {
            return [
              {
                ...makeMatchResult('Opus One 18', ['entity-opus-one-2018'], 0.91),
                lookupStrategy: 'compact_exact',
              },
            ];
          }

          if (normalizedQuery === 'moet chandon') {
            return [
              {
                ...makeMatchResult('Moet Chandon', ['entity-moet-chandon'], 0.93),
                lookupStrategy: 'transliterated_fuzzy',
              },
            ];
          }

          return [];
        },
      };

      const extractor = new AnchorExtractor(aliasMatcher);
      const compactAnchors = await extractor.extract(
        'Opus-One 18',
        normalizer.normalize('Opus-One 18'),
      );
      expect(compactAnchors).toHaveLength(1);
      expect(compactAnchors[0]?.surfaceForm).toBe('Opus One 18');
      expect(compactAnchors[0]?.lookupVariants).toEqual(
        expect.arrayContaining(['opusone18']),
      );
      expect(compactAnchors[0]?.lookupStrategies).toEqual(
        expect.arrayContaining(['compact_exact']),
      );

      const transliteratedAnchors = await extractor.extract(
        '모엣샹동',
        normalizer.normalize('모엣샹동'),
      );
      expect(transliteratedAnchors).toHaveLength(1);
      expect(transliteratedAnchors[0]?.surfaceForm).toBe('Moet Chandon');
      expect(transliteratedAnchors[0]?.lookupVariants).toEqual(
        expect.arrayContaining(['moet chandon']),
      );
      expect(transliteratedAnchors[0]?.lookupStrategies).toEqual(
        expect.arrayContaining(['transliterated_fuzzy']),
      );
    });

    it('normalizes search-index lookup strategy prefixes into canonical domain strategy labels', async () => {
      const aliasMatcher: AliasMatcher = {
        async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
          if (normalizedQuery === '오푸스ㅇ') {
            return [{
              ...makeMatchResult('Opus One', ['entity-opus-one-2018'], 0.9),
              lookupStrategy: 'index_transliterated_fuzzy',
            }];
          }
          return [];
        },
      };

      const extractor = new AnchorExtractor(aliasMatcher);
      const anchors = await extractor.extract('오푸스ㅇ', normalizer.normalize('오푸스ㅇ'));

      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.lookupStrategies).toEqual(
        expect.arrayContaining(['transliterated_fuzzy']),
      );
      expect(anchors[0]?.lookupStrategies).not.toEqual(
        expect.arrayContaining(['index_transliterated_fuzzy']),
      );
    });
  });
});
