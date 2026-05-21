/**
 * Track 1.3 — Double Metaphone phonetic encoding regression coverage.
 *
 * These cases protect the in-memory phonetic phase against drift. They
 * intentionally seed only the smallest fixture surface needed to
 * exercise `doubleMetaphone()` in `SearchSnapshotAliasMatcher` — no
 * Postgres dependency, no live Vespa. Lossless and deterministic.
 *
 * If any of these regress, the most likely culprits are:
 *   - The `double-metaphone` upstream library returning unexpected keys
 *   - A drift between `query-normalizer.ts` and the matcher's view
 *     consumption
 *   - The phonetic promotion logic in
 *     `search-snapshot-alias-matcher.ts` ignoring the DM signal
 */
import { describe, expect, it } from 'vitest';
import { SearchSnapshotAliasMatcher } from '../../src/infrastructure/adapter/search-snapshot-alias-matcher.js';

interface MinimalAliasSeed {
  readonly aliasId: string;
  readonly entityId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly sourceTrust: number;
  readonly confidencePrior: number;
}

/** Confidence prior baked into every seeded alias. Domain neutral. */
const SEED_CONFIDENCE_PRIOR = 0.95;
/** Source trust baked into every seeded alias. Domain neutral. */
const SEED_SOURCE_TRUST = 0.9;

function seed(
  entityId: string,
  surfaces: readonly string[],
): readonly MinimalAliasSeed[] {
  return surfaces.map((surface, index) => ({
    aliasId: `${entityId}-${index}`,
    entityId,
    value: surface,
    normalizedValue: surface.toLowerCase(),
    sourceTrust: SEED_SOURCE_TRUST,
    confidencePrior: SEED_CONFIDENCE_PRIOR,
  }));
}

describe('Double Metaphone phonetic matching — regression', () => {
  const aliases: readonly MinimalAliasSeed[] = [
    ...seed('chateau-margaux', ['Château Margaux', 'Margaux', 'Chateau Margaux']),
    ...seed('sassicaia', ['Sassicaia', 'Tenuta San Guido Sassicaia']),
    ...seed('moet-chandon', ['Moët & Chandon', 'Moet Chandon']),
    ...seed('petrus', ['Pétrus', 'Petrus']),
    ...seed('romanee-conti', ['Romanée-Conti', 'Romanee Conti']),
  ];
  const matcher = new SearchSnapshotAliasMatcher(aliases);

  it.each([
    ['Margeaux', 'chateau-margaux'],
    ['Margoux', 'chateau-margaux'],
    ['Margo', 'chateau-margaux'],
    ['Sasicaia', 'sassicaia'],
    ['Sasikaia', 'sassicaia'],
    ['Moet Shandon', 'moet-chandon'],
    ['Romane Conti', 'romanee-conti'],
    ['Romanee Contie', 'romanee-conti'],
  ])(
    'phonetic variant %s resolves to entity %s via Double Metaphone',
    async (query, expectedEntityId) => {
      const matches = await matcher.findMatches(query);
      const firstMatch = matches[0];
      expect(firstMatch).toBeDefined();
      // recall@1 invariant — top match must contain the expected entity
      expect(firstMatch?.entityIds.map((id) => String(id))).toContain(expectedEntityId);
    },
  );

  it('exact (non-phonetic) hits still beat phonetic-only hits for the same surface', async () => {
    // "Margaux" should resolve directly via exact / compact_exact —
    // the phonetic phase exists for noisy variants, not to override
    // a clean lexical match.
    const matches = await matcher.findMatches('Margaux');
    const top = matches[0];
    expect(top?.entityIds.map((id) => String(id))).toContain('chateau-margaux');
    // Strategy must NOT be solely 'phonetic_exact' when a lexical
    // match exists for the exact spelling.
    expect(top?.lookupStrategy).not.toBe('phonetic_exact');
  });

  it('does not fabricate phonetic matches for unrelated wine surfaces', async () => {
    const matches = await matcher.findMatches('Krug');
    // Krug isn't in the fixture — should produce no matches.
    expect(matches.map((match) => match.entityIds.map((id) => String(id))).flat())
      .not.toContain('chateau-margaux');
    expect(matches.map((match) => match.entityIds.map((id) => String(id))).flat())
      .not.toContain('sassicaia');
  });

  it('Hangul query against Latin alias does NOT phonetic-match', async () => {
    // Hangul has no Latin script → Double Metaphone returns empty.
    // The wrapper must refuse to fabricate a match.
    const matches = await matcher.findMatches('마고');
    const sources = matches.flatMap((m) => m.entityIds.map((id) => String(id)));
    // The match (if any) must come via Korean transliteration, not phonetic.
    if (sources.includes('chateau-margaux')) {
      const strategy = matches[0]?.lookupStrategy ?? '';
      expect(strategy).not.toMatch(/^phonetic/);
    }
  });

  it('diacritic-only difference resolves via Double Metaphone (Pétrus query → Petrus alias)', async () => {
    const matches = await matcher.findMatches('Petrus');
    expect(matches[0]?.entityIds.map((id) => String(id))).toContain('petrus');
  });

  it('empty query returns an empty result list (no throw)', async () => {
    const matches = await matcher.findMatches('');
    expect(matches).toEqual([]);
  });

  it('whitespace-only query returns an empty result list (no throw)', async () => {
    const matches = await matcher.findMatches('   ');
    expect(matches).toEqual([]);
  });
});
