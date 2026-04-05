import { describe, it, expect } from 'vitest';
import { AnchorExtractor, type AliasMatcher, type AliasMatchResult } from '../service/anchor-extractor.js';
import { QueryNormalizer } from '../service/query-normalizer.js';
import { createEntityId } from '../../shared/types/index.js';

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

  describe('multi-view noisy lookup', () => {
    it('recovers aliases from transliterated and compact views', async () => {
      const aliasMatcher: AliasMatcher = {
        async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
          if (normalizedQuery === 'opusone18') {
            return [
              makeMatchResult('Opus One 18', ['entity-opus-one-2018'], 0.91),
            ];
          }

          if (normalizedQuery === 'moet chandon') {
            return [
              makeMatchResult('Moet Chandon', ['entity-moet-chandon'], 0.93),
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

      const transliteratedAnchors = await extractor.extract(
        '모엣샹동',
        normalizer.normalize('모엣샹동'),
      );
      expect(transliteratedAnchors).toHaveLength(1);
      expect(transliteratedAnchors[0]?.surfaceForm).toBe('Moet Chandon');
      expect(transliteratedAnchors[0]?.lookupVariants).toEqual(
        expect.arrayContaining(['moet chandon']),
      );
    });
  });
});
