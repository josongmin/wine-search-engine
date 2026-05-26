import { describe, expect, it, vi } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import { VespaHttpError, type VespaClient } from '../vespa-client.js';
import type { VespaQueryResponse } from '../vespa-client.js';
import { VESPA_BULK_HYDRATION_BATCH_SIZE } from '../per-channel-timeouts.js';
import { VespaSearchIndex } from '../vespa-search-index.js';

/** Builds a minimal VespaQueryResponse returning given entity IDs as hits. */
function makeQueryResponse(entityIds: string[]): VespaQueryResponse {
  return {
    root: {
      id: 'root',
      relevance: 1,
      children: entityIds.map((id) => ({
        id: `id:wine:wine_entity::${id}`,
        relevance: 0.5,
        source: 'content',
        fields: { entity_id: id, canonical_label: `Label for ${id}` },
      })),
    },
  };
}

function makeDocumentFields(entityId: string): Record<string, unknown> {
  return {
    entity_id: entityId,
    entity_type: 'wine',
    canonical_label: `Label for ${entityId}`,
    aliases_identity_safe: [`Label for ${entityId}`],
    aliases_noisy_recall: [`Alias for ${entityId}`],
    producer: 'Producer',
    region: 'Region',
    grapes: ['Cabernet Sauvignon'],
    search_text_ko: '와인 검색어',
    search_text_en: 'Wine search text',
    semantic_summary: 'Wine semantic summary',
    style: 'red',
    price_band: 'premium',
    pairing: ['steak'],
    availability: true,
    popularity_score: 0.8,
    country: 'United States',
    drinking_window_start: 2024,
    drinking_window_end: 2038,
  };
}

describe('VespaSearchIndex', () => {
  describe('YQL injection prevention in fetchWithHitSummary', () => {
    it('escapes double-quotes in entity IDs to prevent YQL injection', async () => {
      // If entity IDs with " were interpolated raw, the YQL would break.
      // The fix uses yqlEscapeString which replaces " with \".
      const maliciousId = 'wine" OR 1=1 OR entity_id="other';
      const capturedQueries: string[] = [];

      const client = {
        query: vi.fn().mockImplementation((yql: string) => {
          capturedQueries.push(yql);
          return Promise.resolve(makeQueryResponse([]));
        }),
      } as unknown as VespaClient;

      const index = new VespaSearchIndex(client);
      await index.fetchWithHitSummary([createEntityId(maliciousId)]);

      expect(capturedQueries).toHaveLength(1);
      const yql = capturedQueries[0]!;
      // The " in the entity ID must be escaped as \"
      expect(yql).toContain('\\"');
      // The raw unescaped injection payload must not appear in the YQL
      expect(yql).not.toContain('" OR 1=1 OR entity_id="');
    });

    it('escapes backslashes in entity IDs', async () => {
      const idWithBackslash = 'wine\\adversarial';
      const capturedQueries: string[] = [];

      const client = {
        query: vi.fn().mockImplementation((yql: string) => {
          capturedQueries.push(yql);
          return Promise.resolve(makeQueryResponse([]));
        }),
      } as unknown as VespaClient;

      const index = new VespaSearchIndex(client);
      await index.fetchWithHitSummary([createEntityId(idWithBackslash)]);

      const yql = capturedQueries[0]!;
      // Backslash must be escaped as \\ in the YQL string literal
      expect(yql).toContain('\\\\');
    });
  });

  describe('fetchWithHitSummary batching', () => {
    it('splits >200 entity IDs into multiple Vespa query calls', async () => {
      // Build 250 entity IDs (exceeds the 200-ID batch limit).
      const ids = Array.from({ length: 250 }, (_, i) =>
        createEntityId(`wine-batch-${String(i).padStart(4, '0')}`),
      );

      let callCount = 0;
      const client = {
        query: vi.fn().mockImplementation((_yql: string) => {
          callCount++;
          return Promise.resolve(makeQueryResponse([]));
        }),
      } as unknown as VespaClient;

      const index = new VespaSearchIndex(client);
      await index.fetchWithHitSummary(ids);

      expect(callCount).toBe(Math.ceil(ids.length / VESPA_BULK_HYDRATION_BATCH_SIZE));
    });

    it('splits >200 entity IDs in fetchWithFeatureSummary as well', async () => {
      const ids = Array.from({ length: 205 }, (_, i) =>
        createEntityId(`wine-feature-${String(i).padStart(4, '0')}`),
      );

      let callCount = 0;
      const client = {
        query: vi.fn().mockImplementation((_yql: string) => {
          callCount++;
          return Promise.resolve({
            root: { id: 'root', relevance: 1, children: [] },
          } as VespaQueryResponse);
        }),
      } as unknown as VespaClient;

      const index = new VespaSearchIndex(client);
      await index.fetchWithFeatureSummary(ids);

      expect(callCount).toBe(Math.ceil(ids.length / VESPA_BULK_HYDRATION_BATCH_SIZE));
    });

    it('returns empty array without calling Vespa when entity list is empty', async () => {
      const client = {
        query: vi.fn(),
      } as unknown as VespaClient;

      const index = new VespaSearchIndex(client);
      const result = await index.fetchWithHitSummary([]);
      expect(result).toHaveLength(0);
      expect(client.query).not.toHaveBeenCalled();
    });
  });

  it('hydrates getDocuments by public entity_id even when the Vespa doc id differs', async () => {
    const publicEntityId = createEntityId('wine-ce-public-entity-id');
    const client = {
      get: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue({
        root: {
          id: 'root',
          relevance: 1,
          children: [
            {
              id: 'id:wine:wine_entity::internal-doc-id-123',
              relevance: 1,
              source: 'content',
              fields: makeDocumentFields(publicEntityId),
            },
          ],
        },
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    const docs = await index.getDocuments([publicEntityId]);

    expect(docs.get(publicEntityId)?.canonicalLabel).toBe(`Label for ${publicEntityId}`);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0]?.[0]).toContain(`entity_id in ("${publicEntityId}")`);
  });

  it('skips malformed getDocuments hits and returns remaining valid documents', async () => {
    const validId = createEntityId('vespa-get-doc-valid');
    const malformedId = createEntityId('vespa-get-doc-malformed');
    const client = {
      get: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue({
        root: {
          id: 'root',
          relevance: 1,
          children: [
            {
              id: `id:wine:wine_entity::${validId}`,
              relevance: 1,
              source: 'content',
              fields: {
                entity_id: validId,
                entity_type: 'wine',
                canonical_label: 'Valid Wine',
                producer: 'Valid Producer',
                region: 'Region A',
                grapes: ['Merlot'],
                search_text_ko: '검색 텍스트',
                search_text_en: 'search text',
                semantic_summary: 'summary',
                style: 'red',
                price_band: 'mid',
                pairing: ['steak'],
                availability: true,
                popularity_score: 0.8,
                country: 'France',
                drinking_window_start: 2024,
                drinking_window_end: 2030,
              },
            },
            {
              id: `id:wine:wine_entity::${malformedId}`,
              relevance: 1,
              source: 'content',
              fields: {
                entity_id: malformedId,
                entity_type: 'wine',
                // canonical_label omitted on purpose -> malformed doc
                producer: 'Malformed Producer',
                region: 'Region B',
                grapes: ['Pinot'],
                search_text_ko: 'bad',
                search_text_en: 'bad',
                semantic_summary: 'bad',
                style: 'red',
                price_band: 'mid',
                pairing: ['soup'],
                availability: true,
                popularity_score: 0.5,
                country: 'Italy',
                drinking_window_start: 2025,
                drinking_window_end: 2031,
              },
            },
          ],
        },
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    const docs = await index.getDocuments([validId, malformedId]);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(docs.get(validId)).toBeDefined();
    expect(docs.get(validId)?.canonicalLabel).toBe('Valid Wine');
    expect(docs.get(malformedId)).toBeUndefined();
  });

  it('hydrates drinking-window projection by public entity_id without full document fields', async () => {
    const publicEntityId = createEntityId('wine-ce-drinking-window-only');
    const client = {
      query: vi.fn().mockResolvedValue({
        root: {
          id: 'root',
          relevance: 1,
          children: [
            {
              id: 'id:wine:wine_entity::internal-doc-id-456',
              relevance: 1,
              source: 'content',
              fields: {
                entity_id: publicEntityId,
                canonical_label: 'Opus One 2018',
                drinking_window_start: 2024,
                drinking_window_end: 2038,
                drinking_window_model_version: 'dw-v1',
              },
            },
          ],
        },
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    const docs = await index.getDrinkingWindowDocuments([publicEntityId]);

    expect(docs.get(publicEntityId)).toEqual({
      entityId: publicEntityId,
      canonicalLabel: 'Opus One 2018',
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2038,
      drinkingWindowModelVersion: 'dw-v1',
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0]?.[0]).toContain(
      'select entity_id, canonical_label, drinking_window_start, drinking_window_end, drinking_window_model_version',
    );
    expect(client.query.mock.calls[0]?.[1]).toEqual({ 'presentation.summary': 'full' });
  });

  it('skips malformed feature-summary hits and returns remaining valid projections', async () => {
    const validId = createEntityId('vespa-feature-valid');
    const malformedId = createEntityId('vespa-feature-malformed');
    const client = {
      query: vi.fn().mockResolvedValue({
        root: {
          id: 'root',
          relevance: 1,
          children: [
            {
              id: `id:wine:wine_entity::${validId}`,
              relevance: 1,
              source: 'content',
              fields: {
                entity_id: validId,
                body: 0.7,
                tannin: 0.4,
                acidity: 0.2,
                sweetness: 0.1,
                critic_score_normalized: 0.91,
              },
            },
            {
              id: `id:wine:wine_entity::${malformedId}`,
              relevance: 1,
              source: 'content',
              fields: {
                // entity_id omitted on purpose -> malformed hit
                body: 0.3,
              },
            },
          ],
        },
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    const docs = await index.fetchWithFeatureSummary([validId, malformedId]);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.entityId).toBe(validId);
    expect(docs[0]?.body).toBe(0.7);
  });

  it('maps hit summaries through the shared retrieval summary transport', async () => {
    const entityId = createEntityId('vespa-summary-test');
    const client = {
      query: vi.fn().mockResolvedValue({
        root: {
          id: 'root',
          relevance: 1,
          children: [
            {
              id: `id:wine:wine_entity::${entityId}`,
              relevance: 0.97,
              source: 'content',
              fields: {
                entity_id: entityId,
                canonical_label: '  Vespa Wine  ',
                producer: '  Vespa Producer  ',
                pairing: ['steak'],
                occasion: ['cellaring'],
                producer_prestige: 0.93,
                country: '  France  ',
                drinking_window_model_version: 'dw-vespa-v4',
                certifications: ['organic'],
                search_text_en: `  ${'V'.repeat(810)}  `,
              },
            },
          ],
        },
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    const [hit] = await index.sparseSearch(['Vespa Wine'], [], 5);

    expect(hit).toMatchObject({
      entityId,
      summary: {
        canonicalLabel: 'Vespa Wine',
        producer: 'Vespa Producer',
        pairing: ['steak'],
        occasion: ['cellaring'],
        producerPrestige: 0.93,
        country: 'France',
        drinkingWindowModelVersion: 'dw-vespa-v4',
        certifications: ['organic'],
        searchTextEn: 'V'.repeat(800),
      },
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ 'presentation.summary': 'hit_summary' }),
      undefined,
      undefined,
      undefined,
    );
  });

  it('includes alias prefix substrate matching in sparseSearch YQL', async () => {
    let capturedYql = '';
    let capturedParams: Record<string, unknown> | undefined;
    const client = {
      query: vi.fn().mockImplementation((yql: string, params?: Record<string, unknown>) => {
        capturedYql = yql;
        capturedParams = params;
        return Promise.resolve(makeQueryResponse([]));
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    await index.sparseSearch(['opu'], [], 5);

    expect(capturedYql).toContain('aliases_noisy_recall contains phrase(@query0)');
    expect(capturedYql).toContain('alias_prefix_terms contains ({prefix:true}@query0_prefix)');
    expect(capturedParams?.['query0_prefix']).toBe('opu');
  });

  it('retries sparseSearch without alias prefix substrate when deployed Vespa schema lacks the field', async () => {
    const capturedYql: string[] = [];
    const client = {
      query: vi.fn().mockImplementation((yql: string) => {
        capturedYql.push(yql);
        if (capturedYql.length === 1) {
          return Promise.reject(
            new VespaHttpError(
              'Vespa query failed [HTTP 400]: {"root":{"errors":[{"message":"Field \'alias_prefix_terms\' does not exist."}]}}',
              400,
              false,
              true,
            ),
          );
        }
        return Promise.resolve(makeQueryResponse([]));
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    await index.sparseSearch(['opu'], [], 5);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(capturedYql[0]).toContain('alias_prefix_terms contains ({prefix:true}@query0_prefix)');
    expect(capturedYql[1]).not.toContain('alias_prefix_terms contains ({prefix:true}@query0_prefix)');
  });

  it('remembers alias prefix substrate downgrade after first schema-mismatch retry', async () => {
    const capturedYql: string[] = [];
    const client = {
      query: vi.fn().mockImplementation((yql: string) => {
        capturedYql.push(yql);
        if (capturedYql.length === 1) {
          return Promise.reject(
            new VespaHttpError(
              'Vespa query failed [HTTP 400]: {"root":{"errors":[{"message":"Field \'alias_prefix_terms\' does not exist."}]}}',
              400,
              false,
              true,
            ),
          );
        }
        return Promise.resolve(makeQueryResponse([]));
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    await index.sparseSearch(['opu'], [], 5);
    await index.sparseSearch(['opu'], [], 5);

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(capturedYql[1]).not.toContain('alias_prefix_terms contains ({prefix:true}@query0_prefix)');
    expect(capturedYql[2]).not.toContain('alias_prefix_terms contains ({prefix:true}@query0_prefix)');
  });

  it('rejects Vespa hits whose indexed entity_id uses the forbidden source-record public namespace (ADR-007)', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        root: {
          id: 'root',
          relevance: 1,
          children: [
            {
              id: 'id:wine:wine_entity::wine-legit-fallback-id',
              relevance: 0.9,
              source: 'content',
              fields: {
                entity_id: 'vivino-deadbeefcafe',
                canonical_label: 'Contaminated',
              },
            },
          ],
        },
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    await expect(index.sparseSearch(['test'], [], 5)).rejects.toThrow(/ADR-007/);
  });

  it('rejects Vespa URI doc id segment when entity_id field is absent but doc id is source-record namespace', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        root: {
          id: 'root',
          relevance: 1,
          children: [
            {
              id: 'id:wine:wine_entity::vivino-onlyfrom-uri-segment',
              relevance: 0.88,
              source: 'content',
              fields: {
                canonical_label: 'No entity_id field',
              },
            },
          ],
        },
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    await expect(index.sparseSearch(['test'], [], 5)).rejects.toThrow(/ADR-007/);
  });

  describe('YQL numeric-interpolation safety', () => {
    // Regression: the YQL `limit N`, `{targetHits: N}`, and
    // `hnsw.exploreAdditionalHits: N` clauses must never emit `NaN`,
    // `Infinity`, or a negative / fractional value — even if a misbehaving
    // caller passes a non-integer `number` at runtime. The port type is
    // `number`, which TypeScript does not enforce at runtime.
    function makeCapturingClient(): {
      client: VespaClient;
      queries: string[];
    } {
      const queries: string[] = [];
      const client = {
        query: vi.fn().mockImplementation((yql: string) => {
          queries.push(yql);
          return Promise.resolve(makeQueryResponse([]));
        }),
      } as unknown as VespaClient;
      return { client, queries };
    }

    it('coerces NaN limit to a safe integer in sparseSearch', async () => {
      const { client, queries } = makeCapturingClient();
      const index = new VespaSearchIndex(client);
      await index.sparseSearch(['bordeaux'], [], Number.NaN);
      expect(queries).toHaveLength(1);
      expect(queries[0]).not.toContain('NaN');
      expect(queries[0]).toMatch(/ limit \d+$/);
    });

    it('coerces Infinity limit to the MAX_YQL_LIMIT cap in sparseSearch', async () => {
      const { client, queries } = makeCapturingClient();
      const index = new VespaSearchIndex(client);
      await index.sparseSearch(['bordeaux'], [], Number.POSITIVE_INFINITY);
      expect(queries[0]).not.toContain('Infinity');
      expect(queries[0]).toMatch(/ limit 400$/);
    });

    it('coerces negative limit to MIN_YQL_LIMIT in sparseSearch', async () => {
      const { client, queries } = makeCapturingClient();
      const index = new VespaSearchIndex(client);
      await index.sparseSearch(['bordeaux'], [], -5);
      expect(queries[0]).toMatch(/ limit 1$/);
    });

    it('floors fractional limit in sparseSearch (no fractional YQL literal)', async () => {
      const { client, queries } = makeCapturingClient();
      const index = new VespaSearchIndex(client);
      await index.sparseSearch(['bordeaux'], [], 17.9);
      expect(queries[0]).toMatch(/ limit 17$/);
    });

    it('coerces NaN limit in denseSearch without emitting NaN into targetHits/limit', async () => {
      const { client, queries } = makeCapturingClient();
      const index = new VespaSearchIndex(client);
      await index.denseSearch([0.1, 0.2, 0.3], [], Number.NaN);
      expect(queries).toHaveLength(1);
      expect(queries[0]).not.toContain('NaN');
      // Both {targetHits: N} and `limit N` must be integers
      expect(queries[0]).toMatch(/targetHits: \d+/);
      expect(queries[0]).toMatch(/hnsw\.exploreAdditionalHits: \d+/);
      expect(queries[0]).toMatch(/ limit \d+$/);
    });

    it('coerces Infinity limit in denseSearch without emitting Infinity', async () => {
      const { client, queries } = makeCapturingClient();
      const index = new VespaSearchIndex(client);
      await index.denseSearch([0.1, 0.2, 0.3], [], Number.POSITIVE_INFINITY);
      expect(queries[0]).not.toContain('Infinity');
      expect(queries[0]).toMatch(/targetHits: 400/);
      expect(queries[0]).toMatch(/ limit 400$/);
    });

    it('coerces NaN limit in searchLearnedSparse without emitting NaN', async () => {
      const { client, queries } = makeCapturingClient();
      const index = new VespaSearchIndex(client);
      await index.searchLearnedSparse(
        [{ token: 'wine', weight: 1 }],
        [],
        Number.NaN,
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]).not.toContain('NaN');
      expect(queries[0]).toMatch(/targetHits: \d+/);
      expect(queries[0]).toMatch(/ limit \d+$/);
    });

    it('coerces Infinity limit in searchLearnedSparse to Vespa maxHits cap', async () => {
      const { client, queries } = makeCapturingClient();
      const index = new VespaSearchIndex(client);
      await index.searchLearnedSparse(
        [{ token: 'wine', weight: 1 }],
        [],
        Number.POSITIVE_INFINITY,
      );
      expect(queries[0]).not.toContain('Infinity');
      expect(queries[0]).toMatch(/targetHits: 400/);
      expect(queries[0]).toMatch(/ limit 400$/);
    });
  });

  describe('yqlEscapeString SSoT usage in fetchWithHitSummary', () => {
    // Regression: the local duplicate `yqlEscapeString` previously defined in
    // vespa-search-index.ts did NOT strip control characters, so an entity ID
    // containing a NUL byte (\x00), line separator (\u2028), or BOM (\uFEFF)
    // would reach Vespa intact and could break parsing. The fix imports the
    // SSoT from mapping.ts which strips ASCII/Unicode control characters
    // before escaping.
    it('strips ASCII control characters from entity IDs', async () => {
      const controlId = 'wine\x00\x01\x1funsafe';
      const capturedQueries: string[] = [];
      const client = {
        query: vi.fn().mockImplementation((yql: string) => {
          capturedQueries.push(yql);
          return Promise.resolve(makeQueryResponse([]));
        }),
      } as unknown as VespaClient;
      const index = new VespaSearchIndex(client);
      await index.fetchWithHitSummary([createEntityId(controlId)]);
      const yql = capturedQueries[0]!;
      expect(yql).not.toContain('\x00');
      expect(yql).not.toContain('\x01');
      expect(yql).not.toContain('\x1f');
      expect(yql).toContain('"wineunsafe"');
    });

    it('strips Unicode line-separator (U+2028) and BOM (U+FEFF)', async () => {
      const unicodeId = 'wine\u2028mid\uFEFFend';
      const capturedQueries: string[] = [];
      const client = {
        query: vi.fn().mockImplementation((yql: string) => {
          capturedQueries.push(yql);
          return Promise.resolve(makeQueryResponse([]));
        }),
      } as unknown as VespaClient;
      const index = new VespaSearchIndex(client);
      await index.fetchWithHitSummary([createEntityId(unicodeId)]);
      const yql = capturedQueries[0]!;
      expect(yql).not.toContain('\u2028');
      expect(yql).not.toContain('\uFEFF');
      expect(yql).toContain('"winemidend"');
    });
  });

  it('passes structured query feature params to Vespa sparse search', async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const client = {
      query: vi.fn().mockImplementation((_yql: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return Promise.resolve(makeQueryResponse(['structured-1']));
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    await index.sparseSearch(
      ['bordeaux red wine', 'Cabernet Merlot'],
      ['country:France', 'region:Bordeaux'],
      5,
    );

    expect(capturedParams?.['ranking.features.query(structured_query_terms_count)']).toBe(1);
    expect(capturedParams?.['ranking.features.query(structured_query_strength)']).toBeGreaterThan(0);
    expect(capturedParams?.['ranking.features.query(structured_region_boost)']).toBe(1);
    expect(capturedParams?.['ranking.features.query(structured_grape_boost)']).toBe(1);
    expect(capturedParams?.['ranking.features.query(filter_strength)']).toBeGreaterThan(0);
    expect(capturedParams?.['presentation.summary']).toBe('hit_summary');
  });

  it('uses hit_summary for denseSearch retrieval hits', async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const client = {
      query: vi.fn().mockImplementation((_yql: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return Promise.resolve(makeQueryResponse(['dense-summary-1']));
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    await index.denseSearch([0.1, 0.2, 0.3], ['wine_type:white'], 5);

    expect(capturedParams?.['presentation.summary']).toBe('hit_summary');
  });

  it('uses hit_summary for learned sparse retrieval hits', async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const client = {
      query: vi.fn().mockImplementation((_yql: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return Promise.resolve(makeQueryResponse(['learned-summary-1']));
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    await index.searchLearnedSparse([{ token: 'wine', weight: 1 }], ['wine_type:sparkling'], 5);

    expect(capturedParams?.['presentation.summary']).toBe('hit_summary');
  });
});
