import { describe, expect, it, vi } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { VespaClient } from '../vespa-client.js';
import { VespaSearchIndex } from '../vespa-search-index.js';

describe('VespaSearchIndex', () => {
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
                canonical_label: 'Vespa Wine',
                producer: 'Vespa Producer',
                producer_prestige: 0.93,
                drinking_window_model_version: 'dw-vespa-v4',
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
        producerPrestige: 0.93,
        drinkingWindowModelVersion: 'dw-vespa-v4',
        searchTextEn: 'V'.repeat(800),
      },
    });
  });
});
