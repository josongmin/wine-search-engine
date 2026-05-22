import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';
import {
  assertPreparedFeedCompatibleWithLiveDocumentSchema,
  buildPreparedFeedSchemaProbe,
  buildReusableEmbeddingIndex,
  buildSearchTextKo,
  deterministicEmbedding,
  parsePreparedVespaFeedDocuments,
  preparePreparedVespaFeedDocuments,
  serializePreparedVespaFeedDocuments,
  silverToRetrievalDoc,
} from '../../../scripts/etl/index-to-vespa.js';
import { toVespaFields } from '../../../src/infrastructure/vespa/mapping.js';
import {
  SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
  SOURCE_SYSTEM_VIVINO_SILVER,
} from '../../../src/domain/shared/constants/source-systems.js';
import { stableJsonStringify } from '../../../src/domain/shared/utils/stable-json.js';
import {
  LEARNED_SPARSE_EVAL_KEY,
  LEARNED_SPARSE_FIELD_KEY,
  LEARNED_SPARSE_ETL_KEY,
  validateLearnedSparseVector,
} from '../../../scripts/etl/learned-sparse-spec.js';

afterEach(() => {
  delete process.env['OPENAI_API_KEY'];
  vi.unstubAllGlobals();
});

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
    reviewCount: 133,
    ratingDistribution: { '1': 2, '2': 10, '3': 115, '4': 300, '5': 385 },
    wineryRatingCount: 54321,
    priceUsd: 420,
    priceBand: 'luxury',
    popularityScore: 0.93,
    scrapedAt: '2026-04-06T00:00:00.000Z',
    bottleSizeMl: 750,
    bottleSize: '750ml',
    closure: 'Cork',
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
    expect(doc.ratingAvg).toBe(4.7);
    expect(doc.ratingsCount).toBe(812);
    expect(doc.reviewCount).toBe(133);
    expect(doc.ratingDistribution).toEqual({ '1': 2, '2': 10, '3': 115, '4': 300, '5': 385 });
    expect(doc.wineryRatingCount).toBe(54321);
    expect(doc.bottleSizeMl).toBe(750);
    expect(doc.bottleSize).toBe('750ml');
    expect(doc.closure).toBe('Cork');
    expect(fields['rating_avg']).toBe(4.7);
    expect(fields['ratings_count']).toBe(812);
    expect(fields['review_count']).toBe(133);
    expect(fields['rating_distribution_json']).toBe(
      stableJsonStringify({ '1': 2, '2': 10, '3': 115, '4': 300, '5': 385 }),
    );
    expect(fields['winery_rating_count']).toBe(54321);
    expect(fields['bottle_size_ml']).toBe(750);
    expect(fields['bottle_size']).toBe('750ml');
    expect(fields['closure']).toBe('Cork');
  });

  it('preserves benchmark-anchor canonical ids and lineage authority through retrieval projection', () => {
    const record = {
      ...makeEnrichedRecord({
        sourceId: 'benchmark-anchor-opus-one-2018',
        externalId: 'opus-one-2018',
      }),
      benchmarkAnchorEntityId: 'opus-one-2018',
      sourceSystemOverride: SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
    } as EnrichedSilverRecord & {
      readonly benchmarkAnchorEntityId: string;
      readonly sourceSystemOverride: string;
    };
    const embedding = deterministicEmbedding(
      record.body,
      record.sweetness,
      record.acidity,
      record.tannin,
    );
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    expect(String(doc.entityId)).toBe('opus-one-2018');
    expect(fields['entity_id']).toBe('opus-one-2018');
    expect(fields['source_record_refs_json']).toBe(
      stableJsonStringify([
        {
          sourceSystem: SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
          sourceRecordId: 'benchmark-anchor-opus-one-2018',
        },
      ]),
    );
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

  it('round-trips prepared Vespa feed artifacts as exact replay documents', () => {
    const record = makeEnrichedRecord();
    const doc = silverToRetrievalDoc(
      record,
      deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin),
      'search-snapshot:v1:test-1234',
    );
    const prepared = [
      {
        id: String(doc.entityId),
        fields: toVespaFields(doc),
      },
    ] as const;

    const raw = serializePreparedVespaFeedDocuments(prepared);

    expect(parsePreparedVespaFeedDocuments(raw, 'prepared-feed.ndjson')).toEqual(prepared);
  });

  it('builds a schema probe that unions prepared-feed fields and rewrites entity identity', () => {
    const first = makeEnrichedRecord();
    const second = makeEnrichedRecord({
      sourceId: 'vivino:opus-one-2019',
      externalId: '124',
      canonicalLabel: 'Opus One 2019',
      vintageYear: 2019,
      closure: 'Screw cap',
      reviewCount: 144,
    });
    const docs = [
      {
        id: 'doc-1',
        fields: toVespaFields(
          silverToRetrievalDoc(first, deterministicEmbedding(first.body, first.sweetness, first.acidity, first.tannin)),
        ),
      },
      {
        id: 'doc-2',
        fields: toVespaFields(
          silverToRetrievalDoc(second, deterministicEmbedding(second.body, second.sweetness, second.acidity, second.tannin)),
        ),
      },
    ] as const;

    const probe = buildPreparedFeedSchemaProbe(docs);

    expect(probe).not.toBeNull();
    expect(probe?.docId).toContain('schema-probe-');
    expect(probe?.fields['entity_id']).toBe(probe?.docId);
    expect(probe?.fields['canonical_label']).toBe('Prepared Feed Schema Probe');
    expect(probe?.fields['price_usd']).toBe(420);
    expect(probe?.fields['review_count']).toBe(133);
    expect(probe?.fields['closure']).toBe('Cork');
  });

  it('smoke-checks the live document schema before bulk replay', async () => {
    const record = makeEnrichedRecord();
    const docs = [
      {
        id: 'doc-1',
        fields: toVespaFields(
          silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin)),
        ),
      },
    ] as const;
    const writer = {
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    await expect(assertPreparedFeedCompatibleWithLiveDocumentSchema(writer, docs)).resolves.toBeUndefined();
    expect(writer.put).toHaveBeenCalledTimes(1);
    expect(writer.delete).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when the live document schema rejects a prepared-feed field', async () => {
    const record = makeEnrichedRecord();
    const docs = [
      {
        id: 'doc-1',
        fields: toVespaFields(
          silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin)),
        ),
      },
    ] as const;
    const writer = {
      put: vi.fn(async () => {
        throw new Error(`Vespa document POST failed [HTTP 400]: {"message":"Field 'rating_avg' is not defined"}`);
      }),
      delete: vi.fn(async () => undefined),
    };

    await expect(assertPreparedFeedCompatibleWithLiveDocumentSchema(writer, docs)).rejects.toThrow(
      /Prepared Vespa feed is incompatible with the live document schema: .*rating_avg/,
    );
    expect(writer.put).toHaveBeenCalledTimes(1);
    expect(writer.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects legacy silver rows as prepared Vespa feed artifacts', () => {
    const legacyRaw = `${JSON.stringify(makeEnrichedRecord())}\n`;

    expect(() => parsePreparedVespaFeedDocuments(legacyRaw, 'legacy-feed.ndjson')).toThrow(
      /prepared Vespa feed artifact/,
    );
  });

  it('reuses embeddings from a prepared feed when entity_id and semantic_summary match exactly', async () => {
    const record = makeEnrichedRecord();
    const reusedEmbedding = deterministicEmbedding(0.1, 0.2, 0.3, 0.4);
    const previousDoc = silverToRetrievalDoc(record, reusedEmbedding, 'search-snapshot:v1:prev');
    const reusablePreparedDocs = [
      {
        id: String(previousDoc.entityId),
        fields: toVespaFields(previousDoc),
      },
    ] as const;

    const docs = await preparePreparedVespaFeedDocuments({
      records: [record],
      snapshotId: 'search-snapshot:v1:next',
      reusablePreparedDocs,
    });

    const embedding = (((docs[0]?.fields['embedding'] as { values: number[] }).values));
    expect(embedding).toEqual(reusedEmbedding);
    expect(docs[0]?.fields['search_snapshot_id']).toBe('search-snapshot:v1:next');
  });

  it('reuses embeddings across entity-id remaps when source lineage and semantic summary still match', async () => {
    const benchmarkRecord = {
      ...makeEnrichedRecord({
        sourceId: 'benchmark-anchor-opus-one-2018',
        externalId: 'opus-one-2018',
      }),
      benchmarkAnchorEntityId: 'opus-one-2018',
      sourceSystemOverride: SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
    } as EnrichedSilverRecord & {
      readonly benchmarkAnchorEntityId: string;
      readonly sourceSystemOverride: string;
    };
    const reusedEmbedding = deterministicEmbedding(0.15, 0.25, 0.35, 0.45);
    const previousDoc = silverToRetrievalDoc(
      benchmarkRecord,
      reusedEmbedding,
      'search-snapshot:v1:prev',
    );
    const reusablePreparedDocs = [
      {
        id: 'wine-ce-legacy-opus-one-2018',
        fields: {
          ...toVespaFields(previousDoc),
          entity_id: 'wine-ce-legacy-opus-one-2018',
        },
      },
    ] as const;

    const docs = await preparePreparedVespaFeedDocuments({
      records: [benchmarkRecord],
      snapshotId: 'search-snapshot:v1:next',
      reusablePreparedDocs,
    });

    expect(docs[0]?.id).toBe('opus-one-2018');
    expect((((docs[0]?.fields['embedding'] as { values: number[] }).values))).toEqual(reusedEmbedding);
  });

  it('re-embeds only changed records when reusable prepared docs do not match semantic_summary', async () => {
    const unchanged = makeEnrichedRecord();
    const changed = makeEnrichedRecord({
      sourceId: 'vivino:opus-one-2019',
      externalId: '124',
      canonicalLabel: 'Opus One 2019',
      vintageYear: 2019,
      searchTextEn: 'Structured Napa blend with fresher cassis and graphite.',
    });
    const reusedEmbedding = deterministicEmbedding(0.11, 0.21, 0.31, 0.41);
    const previousUnchanged = silverToRetrievalDoc(unchanged, reusedEmbedding, 'search-snapshot:v1:prev');
    const previousChanged = silverToRetrievalDoc(changed, deterministicEmbedding(0.5, 0.5, 0.5, 0.5), 'search-snapshot:v1:prev');
    const reusablePreparedDocs = [
      { id: String(previousUnchanged.entityId), fields: toVespaFields(previousUnchanged) },
      {
        id: String(previousChanged.entityId),
        fields: {
          ...toVespaFields(previousChanged),
          semantic_summary: 'stale semantic summary',
        },
      },
    ] as const;

    process.env['OPENAI_API_KEY'] = 'test-key';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ index: 0, embedding: deterministicEmbedding(0.7, 0.6, 0.5, 0.4) }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const docs = await preparePreparedVespaFeedDocuments({
      records: [unchanged, changed],
      snapshotId: 'search-snapshot:v1:next',
      reusablePreparedDocs,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((((docs[0]?.fields['embedding'] as { values: number[] }).values))).toEqual(reusedEmbedding);
    expect((((docs[1]?.fields['embedding'] as { values: number[] }).values))).toEqual(
      deterministicEmbedding(0.7, 0.6, 0.5, 0.4),
    );
  });

  it('indexes only prepared docs with usable embedding payloads for reuse', () => {
    const index = buildReusableEmbeddingIndex([
      {
        id: 'wine-1',
        fields: {
          entity_id: 'wine-1',
          semantic_summary: 'same summary',
          embedding: { values: [0.1, 0.2, 0.3] },
        },
      },
      {
        id: 'wine-2',
        fields: {
          entity_id: 'wine-2',
          semantic_summary: 'missing embedding',
        },
      },
    ]);

    expect(index.get('wine-1')).toEqual({
      semanticSummary: 'same summary',
      embedding: [0.1, 0.2, 0.3],
    });
    expect(index.has('wine-2')).toBe(false);
  });
});

describe('taxonomy field ingest contract', () => {
  it('derives grape_family from GRAPE_FAMILY_MAP when no authoritative upstream value is present', () => {
    const record = makeEnrichedRecord({ grapePrimary: 'Cabernet Sauvignon', grapeFamily: undefined });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.grapeFamily).toBe('Cabernet Sauvignon');
    expect(fields['grape_family']).toBe('Cabernet Sauvignon');
  });

  it('preserves authoritative grape_family when provided upstream', () => {
    const record = makeEnrichedRecord({ grapePrimary: "Nero d'Avola", grapeFamily: "Nero d'Avola" });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.grapeFamily).toBe("Nero d'Avola");
    expect(fields['grape_family']).toBe("Nero d'Avola");
  });

  it('fails closed when wineType is missing instead of synthesizing a default style', () => {
    const record = makeEnrichedRecord({ wineType: undefined as unknown as EnrichedSilverRecord['wineType'] });

    expect(() =>
      silverToRetrievalDoc(
        record,
        deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin),
      ),
    ).toThrow(/wineType is required/);
  });

  it('omits style for a red wine missing body instead of synthesizing one from wineType', () => {
    const record = makeEnrichedRecord({ wineType: 'red', body: null });
    const doc = silverToRetrievalDoc(
      record,
      deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin),
    );
    const fields = toVespaFields(doc);

    expect(doc.style).toBeUndefined();
    expect(fields).not.toHaveProperty('style');
  });

  it('omits style for a white wine missing sweetness instead of synthesizing one from wineType', () => {
    const record = makeEnrichedRecord({ wineType: 'white', sweetness: null });
    const doc = silverToRetrievalDoc(
      record,
      deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin),
    );
    const fields = toVespaFields(doc);

    expect(doc.style).toBeUndefined();
    expect(fields).not.toHaveProperty('style');
  });

  it('derives style for a red wine with full body/sweetness data', () => {
    const record = makeEnrichedRecord({ wineType: 'red', body: 0.82, sweetness: 0.08 });
    const doc = silverToRetrievalDoc(
      record,
      deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin),
    );
    const fields = toVespaFields(doc);

    expect(doc.style).toBe('bold red');
    expect(fields['style']).toBe('bold red');
  });

  it('derives sparkling style without body/sweetness (deterministic wineType mapping)', () => {
    const record = makeEnrichedRecord({ wineType: 'sparkling', body: null, sweetness: null });
    const doc = silverToRetrievalDoc(
      record,
      deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin),
    );

    expect(doc.style).toBe('sparkling');
  });

  it('derives grape_family via split fallback when grapePrimary is not in GRAPE_FAMILY_MAP', () => {
    const record = makeEnrichedRecord({ grapePrimary: 'Shiraz', grapeFamily: undefined });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));

    expect(doc.grapeFamily).toBe('Shiraz');
  });

  it('omits grape_family when grapePrimary is null', () => {
    const record = makeEnrichedRecord({ grapePrimary: null });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.grapeFamily).toBeUndefined();
    expect(fields).not.toHaveProperty('grape_family');
  });

  it('preserves authoritative region_hierarchy when provided upstream', () => {
    const record = makeEnrichedRecord({
      region: 'Spain / Ribera del Duero / Spain / Castilla y León / Ribera del Duero',
      regionHierarchy: ['Spain', 'Ribera del Duero', 'Castilla y León'],
    });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.regionHierarchy).toEqual(['Spain', 'Ribera del Duero', 'Castilla y León']);
    expect(fields['region_hierarchy']).toEqual(['Spain', 'Ribera del Duero', 'Castilla y León']);
  });

  it('omits soil_type and producer_type when ETL has no authoritative source', () => {
    const record = makeEnrichedRecord();
    Object.assign(record as Record<string, unknown>, { soilType: undefined, producerType: undefined });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.soilType).toBeUndefined();
    expect(doc.producerType).toBeUndefined();
    expect(fields).not.toHaveProperty('soil_type');
    expect(fields).not.toHaveProperty('producer_type');
  });

  it('preserves authoritative soil_type and producer_type when provided upstream', () => {
    const record = makeEnrichedRecord();
    Object.assign(record as Record<string, unknown>, { soilType: 'limestone', producerType: 'estate' });
    const doc = silverToRetrievalDoc(record, deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin));
    const fields = toVespaFields(doc);

    expect(doc.soilType).toBe('limestone');
    expect(doc.producerType).toBe('estate');
    expect(fields['soil_type']).toBe('limestone');
    expect(fields['producer_type']).toBe('estate');
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
