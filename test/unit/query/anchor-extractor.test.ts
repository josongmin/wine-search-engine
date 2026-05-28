import { describe, it, expect } from 'vitest';
import { AnchorExtractor } from '../../../src/domain/query/service/anchor-extractor.js';
import type {
  AliasLookupOptions,
  AliasLookupScope,
  AliasMatcher,
  AliasMatchResult,
} from '../../../src/domain/query/service/anchor-extractor.js';

// ── Stub AliasMatcher ──────────────────────────────────────────────────────────
class StubAliasMatcher implements AliasMatcher {
  private readonly entries: Map<string, AliasMatchResult>;

  constructor(entries: Map<string, AliasMatchResult> = new Map()) {
    this.entries = entries;
  }

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const results: AliasMatchResult[] = [];

    // Check if normalizedQuery contains any of the registered surface forms
    for (const [surfaceKey, matchResult] of this.entries) {
      if (normalizedQuery.includes(surfaceKey.toLowerCase())) {
        results.push(matchResult);
      }
    }

    return results.sort((a, b) => b.matchConfidence - a.matchConfidence);
  }
}

class RecordingAliasMatcher implements AliasMatcher {
  readonly calls: { query: string; scope: AliasLookupScope }[] = [];

  async findMatches(
    normalizedQuery: string,
    options?: AliasLookupOptions,
  ): Promise<readonly AliasMatchResult[]> {
    this.calls.push({
      query: normalizedQuery,
      scope: options?.scope ?? 'span',
    });
    return [];
  }
}

function makeMatchResult(surfaceForm: string, confidence: number = 0.9): AliasMatchResult {
  return {
    surfaceForm,
    normalizedForm: surfaceForm.toLowerCase(),
    entityIds: [`entity-${surfaceForm.toLowerCase().replace(/\s+/g, '-')}` as any],
    matchConfidence: confidence,
  };
}

describe('AnchorExtractor', () => {
  describe('Korean query patterns', () => {
    it('"오푸스원 같은 와인" → AnchorCandidate with surfaceForm "오푸스원"', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['오푸스원', makeMatchResult('오푸스원', 0.95)]]),
      );
      const extractor = new AnchorExtractor(matcher);
      const candidates = await extractor.extract('오푸스원 같은 와인');
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.surfaceForm).toBe('오푸스원');
    });

    it('"마고 비슷한" → extracts "마고"', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['마고', makeMatchResult('마고', 0.92)]]),
      );
      const extractor = new AnchorExtractor(matcher);
      const candidates = await extractor.extract('마고 비슷한');
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.surfaceForm).toBe('마고');
    });

    it('"오푸스원 말고 다른 것" → exclusion marker detected via hasKoreanMixedQueryMarkers', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['오푸스원', makeMatchResult('오푸스원', 0.95)]]),
      );
      const extractor = new AnchorExtractor(matcher);
      const hasMarkers = extractor.hasKoreanMixedQueryMarkers('오푸스원 말고 다른 것');
      expect(hasMarkers).toBe(true);
    });

    it('"레드 와인" → no anchor (no alias match)', async () => {
      const matcher = new StubAliasMatcher(new Map()); // empty - no matches
      const extractor = new AnchorExtractor(matcher);
      const candidates = await extractor.extract('레드 와인');
      expect(candidates).toHaveLength(0);
    });

    it('"Opus One 같은" → "Opus One" extracted', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['opus one', makeMatchResult('Opus One', 0.95)]]),
      );
      const extractor = new AnchorExtractor(matcher);
      const candidates = await extractor.extract('opus one 같은');
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.surfaceForm).toBe('Opus One');
    });
  });

  describe('hasKoreanMixedQueryMarkers', () => {
    it('detects 같은', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasKoreanMixedQueryMarkers('오푸스원 같은 와인')).toBe(true);
    });

    it('detects 비슷한', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasKoreanMixedQueryMarkers('마고 비슷한')).toBe(true);
    });

    it('detects 말고', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasKoreanMixedQueryMarkers('오푸스원 말고')).toBe(true);
    });

    it('detects 대신', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasKoreanMixedQueryMarkers('마고 대신')).toBe(true);
    });

    it('detects 보다', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasKoreanMixedQueryMarkers('오푸스원 보다 저렴한')).toBe(true);
    });

    it('returns false for plain entity query', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasKoreanMixedQueryMarkers('오푸스원 2018')).toBe(false);
    });
  });

  describe('hasComparisonMarkers', () => {
    it('detects "vs"', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasComparisonMarkers('Opus One vs Margaux')).toBe(true);
    });

    it('detects "versus"', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasComparisonMarkers('Opus One versus Margaux')).toBe(true);
    });

    it('detects "compared to"', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasComparisonMarkers('Opus One compared to Margaux')).toBe(true);
    });

    it('returns false for non-comparison queries', () => {
      const extractor = new AnchorExtractor(new StubAliasMatcher());
      expect(extractor.hasComparisonMarkers('Opus One 2018')).toBe(false);
    });
  });

  describe('candidate ordering', () => {
    it('candidates are sorted by confidence descending', async () => {
      const matcher = new StubAliasMatcher(
        new Map([
          ['opus one', makeMatchResult('Opus One', 0.85)],
          ['margaux', makeMatchResult('Margaux', 0.95)],
        ]),
      );
      const extractor = new AnchorExtractor(matcher);
      const candidates = await extractor.extract('opus one and margaux');
      // Margaux has higher confidence (0.95 > 0.85)
      if (candidates.length >= 2) {
        expect(candidates[0]!.confidence).toBeGreaterThanOrEqual(candidates[1]!.confidence);
      }
    });
  });

  describe('span fallback query selection', () => {
    it('keeps compact whole-surface lookup in the base stage but does not reuse it as a span seed', async () => {
      const matcher = new RecordingAliasMatcher();
      const extractor = new AnchorExtractor(matcher);

      await extractor.extract('medium body united states / united states red');

      const baseQueries = matcher.calls
        .filter((call) => call.scope === 'surface')
        .map((call) => call.query);
      const spanQueries = matcher.calls
        .filter((call) => call.scope === 'span')
        .map((call) => call.query);

      expect(baseQueries).toContain('mediumbodyunitedstatesunitedstatesred');
      expect(spanQueries).not.toContain('mediumbodyunitedstatesunitedstatesred');
    });
  });
});
