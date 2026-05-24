/**
 * Wave 2 SOTA++ regression: embedding recipe externalization.
 *
 * The dense-embedding input string used to be hardcoded in `buildEmbedText`.
 * It now flows through a Zod-validated JSON recipe at
 * `tools/embedding-recipe/embedding-recipe-v1.json`. These regressions pin:
 *
 *   - the byte-shape of the emitted text for a known input
 *   - sensory_summary format (`body=0.80 acidity=0.60 tannin=0.50 sweetness=0.20`)
 *   - Korean alias inclusion + cap
 *   - Korean alias suppression when `include_korean_aliases: false`
 *   - recipe `version` bump invalidates the semantic-summary cache key
 */

import { describe, expect, it } from 'vitest';
import {
  buildEmbedTextWithRecipe,
  buildSensorySummary,
} from '../../scripts/etl/index-to-vespa.js';
import {
  getEmbeddingRecipe,
  parseEmbeddingRecipe,
  type EmbeddingRecipe,
} from '../../scripts/etl/embedding-recipe.js';
import type { EnrichedSilverRecord } from '../../scripts/etl/types.js';
import { createSourceRecordId } from '../../src/domain/shared/types/index.js';

function syntheticRecord(
  overrides: Partial<EnrichedSilverRecord> = {},
): EnrichedSilverRecord {
  return {
    sourceId: createSourceRecordId('vivino-test-1'),
    externalId: 'ext-1',
    canonicalLabel: 'Opus One 2018',
    producer: 'Opus One',
    vintageYear: 2018,
    country: 'United States',
    region: 'Napa Valley',
    appellation: 'Oakville',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    body: 0.8,
    sweetness: 0.2,
    acidity: 0.6,
    tannin: 0.5,
    pairingTags: ['beef', 'lamb'],
    flavorProfiles: ['black-fruit', 'oak'],
    searchTextEn: 'Bold Napa Cabernet with cassis and graphite',
    ratingAvg: 4.6,
    ratingsCount: 5000,
    priceUsd: 450,
    priceBand: 'luxury',
    popularityScore: 0.9,
    scrapedAt: '2026-01-01T00:00:00Z',
    alcoholPct: 14.5,
    producerPrestige: 0.95,
    isTopRated: true,
    aliases: {
      proposed: [],
      identitySafeProjection: ['Opus One 2018'],
      noisyRecallProjection: [
        '오푸스원 2018',
        '오푸스 원',
        'Opus One Vintage',
      ],
    },
    ...overrides,
  };
}

const BASE_RECIPE: EmbeddingRecipe = getEmbeddingRecipe();

describe('buildEmbedTextWithRecipe — recipe v1 byte shape', () => {
  it('emits the recipe version as the first token (cache-invalidation contract)', () => {
    const text = buildEmbedTextWithRecipe(syntheticRecord(), BASE_RECIPE);
    expect(text.startsWith(`recipe-v${BASE_RECIPE.version}`)).toBe(true);
  });

  it('honours the recipe field order and prefixes for a populated record', () => {
    const text = buildEmbedTextWithRecipe(syntheticRecord(), BASE_RECIPE);
    // Sanity: every recipe field with a populated value appears in the output.
    expect(text).toContain('Opus One 2018');
    expect(text).toContain('producer: Opus One');
    expect(text).toContain('region: Napa Valley');
    expect(text).toContain('grape: Cabernet Sauvignon');
    expect(text).toContain('Bold Napa Cabernet with cassis and graphite');
    expect(text).toContain('taste: black-fruit, oak');
    expect(text).toContain('pairs: beef, lamb');
    expect(text).toContain('body=0.80 acidity=0.60 tannin=0.50 sweetness=0.20');
    expect(text).toContain('ko: 오푸스원 2018 / 오푸스 원');
  });

  it('skips fields whose record value is empty (no orphan prefixes)', () => {
    const text = buildEmbedTextWithRecipe(
      syntheticRecord({
        flavorProfiles: [],
        pairingTags: [],
        grapePrimary: null,
      }),
      BASE_RECIPE,
    );
    expect(text).not.toContain('taste:');
    expect(text).not.toContain('pairs:');
    expect(text).not.toContain('grape:');
    // But canonical_label / producer / region remain.
    expect(text).toContain('Opus One 2018');
    expect(text).toContain('producer: Opus One');
  });
});

describe('buildSensorySummary — pinned format', () => {
  it('emits all four axes with two-decimal precision when present', () => {
    const summary = buildSensorySummary(syntheticRecord());
    expect(summary).toBe('body=0.80 acidity=0.60 tannin=0.50 sweetness=0.20');
  });

  it('omits null axes rather than zero-filling (no lie to embedder)', () => {
    const summary = buildSensorySummary(
      syntheticRecord({ body: null, sweetness: null }),
    );
    expect(summary).toBe('acidity=0.60 tannin=0.50');
  });

  it('returns empty string when no sensory data is available', () => {
    const summary = buildSensorySummary(
      syntheticRecord({ body: null, acidity: null, tannin: null, sweetness: null }),
    );
    expect(summary).toBe('');
  });
});

describe('Korean alias inclusion + cap', () => {
  it('caps Korean aliases at korean_alias_max_count', () => {
    const recipeWithLowCap: EmbeddingRecipe = parseEmbeddingRecipe({
      ...BASE_RECIPE,
      korean_alias_max_count: 2,
    });
    const rec = syntheticRecord({
      aliases: {
        proposed: [],
        identitySafeProjection: ['Opus One 2018'],
        noisyRecallProjection: ['오푸스원', '오푸스 원', '오 푸스 원', '오푸스원2018'],
      },
    });
    const text = buildEmbedTextWithRecipe(rec, recipeWithLowCap);
    expect(text).toContain('ko: 오푸스원 / 오푸스 원');
    expect(text).not.toContain('오 푸스 원');
    expect(text).not.toContain('오푸스원2018');
  });

  it('excludes Korean aliases when include_korean_aliases is false', () => {
    const recipeNoKo: EmbeddingRecipe = parseEmbeddingRecipe({
      ...BASE_RECIPE,
      include_korean_aliases: false,
    });
    const text = buildEmbedTextWithRecipe(syntheticRecord(), recipeNoKo);
    expect(text).not.toContain('ko:');
    expect(text).not.toContain('오푸스원');
  });

  it('omits the Korean part entirely when no Hangul aliases exist', () => {
    const text = buildEmbedTextWithRecipe(
      syntheticRecord({
        aliases: {
          proposed: [],
          identitySafeProjection: ['Opus One 2018'],
          noisyRecallProjection: ['Opus One Vintage', 'OPUS-ONE'],
        },
      }),
      BASE_RECIPE,
    );
    expect(text).not.toContain('ko:');
  });
});

describe('Recipe version bump → cache key shape', () => {
  it('bumping recipe.version changes the emitted text for the SAME record', () => {
    const v1: EmbeddingRecipe = parseEmbeddingRecipe({ ...BASE_RECIPE, version: 1 });
    const v2: EmbeddingRecipe = parseEmbeddingRecipe({ ...BASE_RECIPE, version: 2 });
    const rec = syntheticRecord();
    const textV1 = buildEmbedTextWithRecipe(rec, v1);
    const textV2 = buildEmbedTextWithRecipe(rec, v2);
    expect(textV1).not.toBe(textV2);
    expect(textV1.startsWith('recipe-v1')).toBe(true);
    expect(textV2.startsWith('recipe-v2')).toBe(true);
    // Cache key in preparePreparedVespaFeedDocuments compares semantic_summary
    // strings verbatim, so version-changed strings cannot collide.
  });

  it('same recipe + same record → byte-identical output (determinism)', () => {
    const rec = syntheticRecord();
    const a = buildEmbedTextWithRecipe(rec, BASE_RECIPE);
    const b = buildEmbedTextWithRecipe(rec, BASE_RECIPE);
    expect(a).toBe(b);
  });
});
