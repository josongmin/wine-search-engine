import { describe, expect, it } from 'vitest';
import {
  buildReviewedFamilyRecallProbe,
  queryMatchesReviewedFamilyRecallSurface,
  type LookupReviewedFamilyRecallMatch,
  type LookupReviewedFamilyRecallPort,
} from '../../../src/domain/resolver/v2/lookup-reviewed-family-recall.js';
import { buildLookupQuerySemanticProbe } from '../../../src/domain/resolver/v2/lookup-semantic-scope.js';
import { buildNormalizedQueryViews } from '../../../src/domain/query/service/query-normalizer.js';
import type { NormalizedQueryViews } from '../../../src/domain/query/model/query-views.js';

// The reviewed family recall surface matcher operates on a semantic probe whose
// views come from the REAL query normalizer (vintage-stripped, lowercased,
// transliterated). We build the probe the same way the production engine does so
// the assertions exercise the genuine normalization, not a hand-forged shape.
function probeFor(query: string, locale: 'ko' | 'global') {
  const views: NormalizedQueryViews = buildNormalizedQueryViews(query);
  return buildReviewedFamilyRecallProbe({ query, views, locale });
}

function matches(
  query: string,
  locale: 'ko' | 'global',
  normalizedSurfaces: readonly string[],
): boolean {
  return queryMatchesReviewedFamilyRecallSurface({
    probe: probeFor(query, locale),
    normalizedSurfaces,
  });
}

describe('buildReviewedFamilyRecallProbe', () => {
  it('delegates to buildLookupQuerySemanticProbe and produces an identical probe', () => {
    const query = 'Silver Oak 2017';
    const views = buildNormalizedQueryViews(query);

    const recallProbe = buildReviewedFamilyRecallProbe({ query, views, locale: 'global' });
    const semanticProbe = buildLookupQuerySemanticProbe({ query, views, locale: 'global' });

    expect(recallProbe).toEqual(semanticProbe);
  });

  it('derives the vintage-stripped normalized + compact views from a Latin query', () => {
    const probe = probeFor('Silver Oak 2017', 'global');

    expect(probe.rawQuery).toBe('Silver Oak 2017');
    expect(probe.locale).toBe('global');
    expect(probe.normalizedQuery).toBe('silver oak');
    expect(probe.compactQuery).toBe('silveroak');
    expect(probe.vintage).toBe(2017);
    // A Latin query has no transliterated view.
    expect(probe.transliteratedQuery).toBeUndefined();
  });

  it('surfaces the transliterated view and Hangul normalized view for a Korean query', () => {
    const probe = probeFor('실버 오크 17', 'ko');

    expect(probe.locale).toBe('ko');
    expect(probe.normalizedQuery).toBe('실버 오크');
    expect(probe.compactQuery).toBe('실버오크');
    expect(probe.transliteratedQuery).toBe('silver oak');
    // 2-digit vintage suffix is canonicalized to a 4-digit year.
    expect(probe.vintage).toBe(2017);
  });

  it('flags a single-token Latin surface as compactish', () => {
    const probe = probeFor('SilverOak', 'global');
    expect(probe.isCompactish).toBe(true);
    expect(probe.compactQuery).toBe('silveroak');
  });
});

describe('queryMatchesReviewedFamilyRecallSurface', () => {
  describe('happy path', () => {
    it('matches a multi-word surface against the normalized query view', () => {
      expect(matches('Silver Oak 2017', 'global', ['silver oak'])).toBe(true);
    });

    it('matches a compact surface against the compact query view', () => {
      expect(matches('Silver Oak 2017', 'global', ['silveroak'])).toBe(true);
    });

    it('matches a whole token bounded by the padded normalized query', () => {
      // ` silver oak ` contains ` oak ` — token-bounded normalized match.
      expect(matches('Silver Oak 2017', 'global', ['oak'])).toBe(true);
    });

    it('matches when at least one of several surfaces hits (some semantics)', () => {
      expect(matches('Silver Oak 2017', 'global', ['cabernet', 'silver oak'])).toBe(true);
    });
  });

  describe('locale / transliteration paths', () => {
    it('matches a Latin surface against the transliterated view of a Korean query', () => {
      expect(matches('실버 오크 17', 'ko', ['silver oak'])).toBe(true);
    });

    it('matches a Hangul surface against the normalized Hangul query view', () => {
      expect(matches('실버 오크 17', 'ko', ['실버 오크'])).toBe(true);
    });

    it('matches a Hangul surface against the compact Hangul query view', () => {
      expect(matches('실버 오크 17', 'ko', ['실버오크'])).toBe(true);
    });
  });

  describe('no-match path', () => {
    it('returns false for an empty surface list', () => {
      expect(matches('Silver Oak 2017', 'global', [])).toBe(false);
    });

    it('returns false when no surface appears in any query view', () => {
      expect(matches('Silver Oak 2017', 'global', ['cabernet'])).toBe(false);
    });

    it('returns false for a Korean query whose surfaces do not appear', () => {
      expect(matches('실버 오크 17', 'ko', ['카베르네', 'cabernet'])).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('does not match an empty surface string (compact length 0, no spurious whitespace hit)', () => {
      // compactForLookup('') === '' (length 0) and ` silver oak ` does not include `  `.
      expect(matches('Silver Oak 2017', 'global', [''])).toBe(false);
    });

    it('matches a compact substring of the compacted query (recall over precision)', () => {
      // The compact arm is substring-based, not token-bounded: 'ilver' ⊂ 'silveroak'.
      expect(matches('Silver Oak 2017', 'global', ['ilver'])).toBe(true);
    });

    it('handles an emoji-laden query without throwing and matches the real token', () => {
      // Regex paths are Unicode-aware; emoji must not break boundary handling.
      expect(matches('🍷 Silver Oak 🍷', 'global', ['silver oak'])).toBe(true);
      expect(matches('🍷 Silver Oak 🍷', 'global', ['merlot'])).toBe(false);
    });

    it('handles accented Latin surfaces (é, ñ) via the normalized accentless view', () => {
      // The normalizer strips accents, so the surface must be supplied accentless.
      expect(matches("Château Pétrus", 'global', ['chateau petrus'])).toBe(true);
    });
  });
});

describe('LookupReviewedFamilyRecallPort (type contract)', () => {
  it('a minimal in-memory fake satisfies the port and round-trips a match shape', () => {
    const match: LookupReviewedFamilyRecallMatch = {
      normalizedSurface: 'silver oak',
      familyKey: 'silver oak',
      entityIds: ['silver-oak-alexander', 'silver-oak-napa'],
      recallWeight: 0.5,
      localizedSurfaces: ['실버 오크', '실버오크'],
      witnessSources: ['reviewed-registry-v1'],
    };

    const fake: LookupReviewedFamilyRecallPort = {
      findMatches: (args) => {
        const probe = buildReviewedFamilyRecallProbe(args);
        return queryMatchesReviewedFamilyRecallSurface({
          probe,
          normalizedSurfaces: [match.normalizedSurface, ...(match.localizedSurfaces ?? [])],
        })
          ? [match]
          : [];
      },
    };

    const hit = fake.findMatches({
      query: '실버 오크 17',
      views: buildNormalizedQueryViews('실버 오크 17'),
      locale: 'ko',
    });
    expect(hit).toEqual([match]);

    const miss = fake.findMatches({
      query: 'Cabernet Sauvignon',
      views: buildNormalizedQueryViews('Cabernet Sauvignon'),
      locale: 'global',
    });
    expect(miss).toEqual([]);
  });
});
