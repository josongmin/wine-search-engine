import { describe, expect, it, vi } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { VespaClient } from '../vespa-client.js';
import type { VespaQueryResponse } from '../vespa-client.js';
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

      // 250 IDs with batch size 200 → 2 calls (200 + 50)
      expect(callCount).toBe(2);
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

      // 205 IDs with batch size 200 → 2 calls (200 + 5)
      expect(callCount).toBe(2);
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
  });
});
