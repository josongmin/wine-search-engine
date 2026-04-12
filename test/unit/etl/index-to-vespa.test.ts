import { describe, expect, it } from 'vitest';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';
import {
  buildSearchTextKo,
  deterministicEmbedding,
  silverToRetrievalDoc,
} from '../../../scripts/etl/index-to-vespa.js';
import { toVespaFields } from '../../../src/infrastructure/vespa/mapping.js';
import { SOURCE_SYSTEM_VIVINO_SILVER } from '../../../src/shared/constants/source-systems.js';
import { stableJsonStringify } from '../../../src/shared/utils/stable-json.js';
import {
  LEARNED_SPARSE_EVAL_KEY,
  LEARNED_SPARSE_FIELD_KEY,
  LEARNED_SPARSE_ETL_KEY,
  validateLearnedSparseVector,
} from '../../../scripts/etl/learned-sparse-spec.js';

function makeEnrichedRecord(
  overrides: Partial<EnrichedSilverRecord> = {},
): EnrichedSilverRecord {
  return {
    sourceId: 'vivino:opus-one-2018',
    externalId: '123',
    canonicalLabel: 'Opus One 2018',
    producer: 'Opus One',
    vintageYear: 2018,
    country: 'United States',
    region: 'Napa Valley',
    appellation: 'Oakville',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    body: 0.82,
    sweetness: 0.08,
    acidity: 0.56,
    tannin: 0.71,
    pairingTags: ['steak', 'aged cheese'],
    flavorProfiles: ['black fruit', 'cedar'],
    searchTextEn: 'Full-bodied Napa Cabernet with dark fruit and cedar.',
    ratingAvg: 4.7,
    ratingsCount: 812,
    priceUsd: 420,
    priceBand: 'luxury',
    popularityScore: 0.93,
    scrapedAt: '2026-04-06T00:00:00.000Z',
    aliases: {
      proposed: [
        {
          value: '오푸스원',
          type: 'translation',
          source: 'fixture',
          confidencePrior: 0.95,
          needsReview: false,
        },
        {
          value: 'Opus One',
          type: 'catalog_noise_alias',
          source: 'fixture',
          confidencePrior: 0.8,
          needsReview: false,
        },
      ],
      identitySafeProjection: ['Opus One 2018', 'Opus One'],
      noisyRecallProjection: ['Opus One', '오푸스원'],
    },
    finishLength: 0.75,
    alcoholPct: 14.0,
    producerPrestige: null,
    isTopRated: false,
    ...overrides,
  };
}

describe('index-to-vespa bridge', () => {
  it('builds Korean search text from Hangul aliases only', () => {
    const record = makeEnrichedRecord();

    expect(buildSearchTextKo(record)).toBe('Opus One 2018 오푸스원');
  });

  it('maps Silver sourceId into Vespa source_record_refs_json via retrieval document', () => {
    const record = makeEnrichedRecord();
    const embedding = deterministicEmbedding(
      record.body,
      record.sweetness,
      record.acidity,
      record.tannin,
    );
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    const expected = stableJsonStringify([
      { sourceSystem: SOURCE_SYSTEM_VIVINO_SILVER, sourceRecordId: record.sourceId },
    ]);
    expect(fields['source_record_refs_json']).toBe(expected);
    expect(doc.sourceRecordRefs).toEqual([
      { sourceSystem: SOURCE_SYSTEM_VIVINO_SILVER, sourceRecordId: record.sourceId },
    ]);
  });

  it('maps enriched records into retrieval documents and omits absent optionals', () => {
    const record = makeEnrichedRecord({
      acidity: 0,
      tannin: 0,
      grapePrimary: null,
      country: '',
      priceUsd: null,
      flavorProfiles: [],
      ratingAvg: null,
    });

    const embedding = deterministicEmbedding(
      record.body,
      record.sweetness,
      record.acidity,
      record.tannin,
    );
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    expect(doc.aliasesIdentitySafe).toEqual(['Opus One 2018', 'Opus One']);
    expect(doc.aliasesNoisyRecall).toEqual(['Opus One', '오푸스원']);
    expect(doc.searchTextKo).toBe('Opus One 2018 오푸스원');
    expect(doc.semanticSummary).toContain('Full-bodied Napa Cabernet');
    expect(doc.criticScoreNormalized).toBeUndefined();
    expect(doc.grapePrimary).toBeUndefined();
    expect(doc.country).toBeUndefined();
    expect(doc.priceUsd).toBeUndefined();
    expect(doc.flavorProfiles).toBeUndefined();

    expect(fields).not.toHaveProperty('grape_primary');
    expect(fields).not.toHaveProperty('country');
    expect(fields).not.toHaveProperty('price_usd');
    expect(fields).not.toHaveProperty('flavor_profiles');
    expect(fields).not.toHaveProperty('critic_score_normalized');
  });

  it('propagates an explicit search snapshot id into the retrieval document and Vespa payload', () => {
    const record = makeEnrichedRecord();
    const embedding = deterministicEmbedding(
      record.body,
      record.sweetness,
      record.acidity,
      record.tannin,
    );
    const doc = silverToRetrievalDoc(record, embedding, 'search-snapshot:v1:test-1234');
    const fields = toVespaFields(doc);

    expect(doc.searchSnapshotId).toBe('search-snapshot:v1:test-1234');
    expect(fields['search_snapshot_id']).toBe('search-snapshot:v1:test-1234');
  });

  it('deterministicEmbedding produces 1024-dim vectors matching Vespa schema', () => {
    const embedding = deterministicEmbedding(0.5, 0.3, 0.6, 0.8);
    expect(embedding).toHaveLength(1024);
    // Verify L2-normalized (unit vector)
    const norm = Math.sqrt(embedding.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });
});

describe('taxonomy field ingest contract', () => {
  it('derives grape_family from grapePrimary and writes it to Vespa', () => {
    const record = makeEnrichedRecord({ grapePrimary: 'Cabernet Sauvignon' });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.grapeFamily).toBe('Cabernet');
    expect(fields['grape_family']).toBe('Cabernet');
  });

  // ── Round 2 audit regression: grape family map for multi-word varieties ──
  it('maps "Nero d\'Avola" → "Nero d\'Avola" (multi-word identity mapping)', () => {
    const record = makeEnrichedRecord({ grapePrimary: "Nero d'Avola" });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.grapeFamily).toBe("Nero d'Avola");
    expect(fields['grape_family']).toBe("Nero d'Avola");
  });

  it('maps "Sauvignon Blanc" → "Sauvignon Blanc" (multi-word identity mapping)', () => {
    const record = makeEnrichedRecord({ grapePrimary: 'Sauvignon Blanc' });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.grapeFamily).toBe('Sauvignon Blanc');
    expect(fields['grape_family']).toBe('Sauvignon Blanc');
  });

  it('maps "Shiraz" → "Syrah" (synonym family mapping)', () => {
    const record = makeEnrichedRecord({ grapePrimary: 'Shiraz' });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));

    expect(doc.grapeFamily).toBe('Syrah');
  });

  it('falls back to first word for unknown grape ("Tempranillo Roriz")', () => {
    const record = makeEnrichedRecord({ grapePrimary: 'Tempranillo Roriz' });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));

    expect(doc.grapeFamily).toBe('Tempranillo');
  });

  it('omits grape_family when grapePrimary is null', () => {
    const record = makeEnrichedRecord({ grapePrimary: null });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.grapeFamily).toBeUndefined();
    expect(fields).not.toHaveProperty('grape_family');
  });

  it('parses region into region_hierarchy, deduplicating segments', () => {
    const record = makeEnrichedRecord({
      region: 'Spain / Ribera del Duero / Spain / Castilla y León / Ribera del Duero',
    });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.regionHierarchy).toEqual(['Spain', 'Ribera del Duero', 'Castilla y León']);
    expect(fields['region_hierarchy']).toEqual(['Spain', 'Ribera del Duero', 'Castilla y León']);
  });

  it('maps priceBand label to price_band_numeric ordinal', () => {
    const cases: Array<[EnrichedSilverRecord['priceBand'], number]> = [
      ['value', 1],
      ['mid', 2],
      ['premium', 3],
      ['luxury', 4],
    ];
    for (const [band, expected] of cases) {
      const record = makeEnrichedRecord({ priceBand: band });
      const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
      const fields = toVespaFields(doc);

      expect(doc.priceBandNumeric).toBe(expected);
      expect(fields['price_band_numeric']).toBe(expected);
    }
  });

  it('propagates finishLength from silver record to Vespa finish_length', () => {
    const record = makeEnrichedRecord({ finishLength: 0.85 });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.finishLength).toBe(0.85);
    expect(fields['finish_length']).toBe(0.85);
  });

  it('preserves finish_length when finishLength is 0 (legitimate zero)', () => {
    const record = makeEnrichedRecord({ finishLength: 0 });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.finishLength).toBe(0);
    expect(fields).toHaveProperty('finish_length', 0);
  });

  it('toVespaFields never writes an empty-string key', () => {
    const record = makeEnrichedRecord();
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(Object.keys(fields)).not.toContain('');
  });
});

describe('learned sparse ingest contract (T4.1a)', () => {
  it('LEARNED_SPARSE_EVAL_KEY is the eval presence flag used by offline eval scripts', () => {
    expect(LEARNED_SPARSE_EVAL_KEY).toBe('learned_sparse_present');
  });

  it('LEARNED_SPARSE_FIELD_KEY matches the Vespa schema field name', () => {
    expect(LEARNED_SPARSE_FIELD_KEY).toBe('learned_sparse_weights');
  });

  it('LEARNED_SPARSE_ETL_KEY matches the Silver record property name', () => {
    expect(LEARNED_SPARSE_ETL_KEY).toBe('learnedSparseWeights');
  });

  it('toVespaFields serializes learnedSparseWeights as Vespa mapped tensor cells', () => {
    const record = makeEnrichedRecord({
      learnedSparseWeights: {
        entries: [
          { token: 'cabernet', weight: 1.2 },
          { token: 'napa', weight: 0.8 },
          { token: 'tannin', weight: 0.5 },
          { token: 'oak', weight: 0.4 },
          { token: 'cassis', weight: 0.9 },
          { token: 'cedar', weight: 0.7 },
          { token: 'dark', weight: 0.6 },
          { token: 'fruit', weight: 0.55 },
          { token: 'bold', weight: 0.45 },
          { token: 'finish', weight: 0.35 },
        ],
        weightSum: 6.45,
        modelId: 'splade-v1',
        schemaVersion: 1,
      },
    });

    const embedding = deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin);
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    expect(fields).toHaveProperty(LEARNED_SPARSE_FIELD_KEY);
    const tensor = fields[LEARNED_SPARSE_FIELD_KEY] as { cells: unknown[] };
    expect(Array.isArray(tensor.cells)).toBe(true);
    expect(tensor.cells).toHaveLength(10);

    const firstCell = tensor.cells[0] as { address: { token: string }; value: number };
    expect(firstCell).toHaveProperty('address');
    expect(firstCell.address).toHaveProperty('token');
    expect(typeof firstCell.value).toBe('number');
  });

  it('toVespaFields omits learned_sparse_weights when entries is empty', () => {
    const record = makeEnrichedRecord({
      learnedSparseWeights: {
        entries: [],
        weightSum: 0,
        modelId: 'splade-v1',
        schemaVersion: 1,
      },
    });

    const embedding = deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin);
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    expect(fields).not.toHaveProperty(LEARNED_SPARSE_FIELD_KEY);
  });

  it('silverToRetrievalDoc passes learnedSparseWeights through to RetrievalDocument', () => {
    const sparseWeights = {
      entries: [
        { token: 'cabernet', weight: 1.2 },
        { token: 'napa', weight: 0.8 },
        { token: 'tannin', weight: 0.5 },
        { token: 'oak', weight: 0.4 },
        { token: 'cassis', weight: 0.9 },
        { token: 'cedar', weight: 0.7 },
        { token: 'dark', weight: 0.6 },
        { token: 'fruit', weight: 0.55 },
        { token: 'bold', weight: 0.45 },
        { token: 'finish', weight: 0.35 },
      ],
      weightSum: 6.45,
      modelId: 'splade-v1',
      schemaVersion: 1,
    };

    const validation = validateLearnedSparseVector(sparseWeights);
    expect(validation.valid).toBe(true);

    const record = makeEnrichedRecord({ learnedSparseWeights: sparseWeights });
    const embedding = deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin);
    const doc = silverToRetrievalDoc(record, embedding);

    expect(doc.learnedSparseWeights).toBeDefined();
    expect(doc.learnedSparseWeights?.entries).toHaveLength(10);
    expect(doc.learnedSparseWeights?.modelId).toBe('splade-v1');
  });

  it('silverToRetrievalDoc omits learnedSparseWeights when absent from Silver record', () => {
    const record = makeEnrichedRecord();
    const embedding = deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin);
    const doc = silverToRetrievalDoc(record, embedding);

    expect(doc).not.toHaveProperty(LEARNED_SPARSE_ETL_KEY);
  });
});

// ── BUG-02 gate: synthetic_queries Vespa PUT payload ────────────────────────
// These tests are a CI gate: if toVespaFields() stops emitting synthetic_queries,
// Doc2Query BM25 silently degrades to zero contribution without any test failure.

describe('Doc2Query synthetic_queries ingest gate (BUG-02)', () => {
  it('toVespaFields emits synthetic_queries when syntheticQueries is present and non-empty', () => {
    const record = makeEnrichedRecord({ syntheticQueries: ['full-bodied red wine', 'napa cabernet blend'] });
    const embedding = deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin);
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    expect(fields['synthetic_queries']).toEqual(['full-bodied red wine', 'napa cabernet blend']);
  });

  it('toVespaFields omits synthetic_queries when syntheticQueries is undefined', () => {
    const record = makeEnrichedRecord({ syntheticQueries: undefined });
    const embedding = deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin);
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    expect(fields).not.toHaveProperty('synthetic_queries');
  });

  it('toVespaFields omits synthetic_queries when syntheticQueries is an empty array', () => {
    const record = makeEnrichedRecord({ syntheticQueries: [] });
    const embedding = deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin);
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    // Empty array → omit, consistent with learned_sparse_weights behaviour
    expect(fields).not.toHaveProperty('synthetic_queries');
  });

  it('round-trip: synthetic_queries values survive serialization (no mutation)', () => {
    const queries = ['elegant red', 'bordeaux style blend', '와인 추천'];
    const record = makeEnrichedRecord({ syntheticQueries: queries });
    const embedding = deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin);
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    // Values preserved exactly — no lowercasing, trimming, or deduplication
    expect(fields['synthetic_queries']).toEqual(queries);
    // Verify it is a copy, not the original reference (defensive spread)
    expect(fields['synthetic_queries']).not.toBe(queries);
  });
});
