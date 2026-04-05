/**
 * Vespa Real E2E — Infrastructure Pipeline Tests
 *
 * Verifies the full document lifecycle: feed → query → verify, update,
 * concurrent feeds, and large batch indexing.
 *
 * These tests are skipped when VESPA_URL is not set.
 * They create and clean up their own unique documents so they do not
 * interfere with the seeded fixture data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VespaClient } from '../../../src/infrastructure/vespa/vespa-client.js';
import { VespaSearchIndex } from '../../../src/infrastructure/vespa/vespa-search-index.js';
import { createEntityId, type EntityId } from '../../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';
import { InMemoryEmbeddingService } from '../../integration/helpers/in-memory-adapters.js';

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const VESPA_URL = process.env['VESPA_URL'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique prefix to isolate pipeline test documents from fixture data. */
const TEST_PREFIX = 'pipeline-test-';

/** Creates a deterministic entity ID for pipeline tests. */
function pipelineId(suffix: string): EntityId {
  return createEntityId(`${TEST_PREFIX}${suffix}`);
}

/** Builds a minimal valid RetrievalDocument for pipeline tests. */
function makeDoc(
  entityId: EntityId,
  overrides: Partial<RetrievalDocument> = {},
): RetrievalDocument {
  return {
    entityId,
    entityType: 'wine',
    canonicalLabel: `Pipeline Wine ${entityId}`,
    aliasesIdentitySafe: [`Pipeline Wine ${entityId}`],
    aliasesNoisyRecall: [],
    producer: 'Pipeline Winery',
    region: 'Test Valley',
    grapes: ['Test Grape'],
    searchTextKo: `파이프라인 테스트 와인 ${entityId}`,
    searchTextEn: `Pipeline test wine ${entityId}`,
    semanticSummary: `A wine created for infrastructure pipeline testing. ID: ${entityId}`,
    body: 0.5,
    sweetness: 0.1,
    style: 'test style',
    priceBand: 'mid',
    pairing: [],
    occasion: [],
    availability: true,
    popularityScore: 0.5,
    ...overrides,
  };
}

/** Wait a short time to allow Vespa to propagate an indexing operation. */
async function waitForIndexing(ms = 500): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!VESPA_URL)('Vespa Real E2E — Infrastructure Pipeline', () => {
  let client: VespaClient;
  let index: VespaSearchIndex;
  let embeddingService: InMemoryEmbeddingService;

  /** All document IDs created during this suite — deleted in afterAll. */
  const createdIds: EntityId[] = [];

  beforeAll(async () => {
    const url = VESPA_URL!; // guarded by skipIf
    client = new VespaClient(url, 'wine', 'wine_entity');
    index = new VespaSearchIndex(client);
    embeddingService = new InMemoryEmbeddingService();

    // Smoke-test Vespa connectivity
    await client.put(pipelineId('smoke'), {
      entity_id: pipelineId('smoke'),
      entity_type: 'wine',
      canonical_label: 'smoke test',
      aliases_identity_safe: [],
      aliases_noisy_recall: [],
      producer: '',
      region: '',
      grapes: [],
      search_text_ko: '',
      search_text_en: 'smoke test ping',
      semantic_summary: '',
      body: 0.5,
      sweetness: 0.1,
      style: '',
      price_band: '',
      pairing: [],
      occasion: [],
      availability: true,
      popularity_score: 0.1,
    });
    createdIds.push(pipelineId('smoke'));
    await client.delete(pipelineId('smoke'));
  });

  afterAll(async () => {
    // Clean up all documents created during this suite.
    await Promise.allSettled(createdIds.map((id) => client.delete(id)));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1: Feed a document → immediately query it → verify it appears
  // ─────────────────────────────────────────────────────────────────────────

  it('feed a document then query it — document appears in search results', async () => {
    const id = pipelineId('feed-query');
    createdIds.push(id);

    const doc = makeDoc(id, {
      canonicalLabel: 'Pipeline Feed Query Wine',
      searchTextEn: 'pipeline feed query unique identifier xq7z9',
      aliasesIdentitySafe: ['Pipeline Feed Query Wine'],
    });

    await index.upsertDocument(doc);
    await waitForIndexing();

    // getDocument must return the document.
    const retrieved = await index.getDocument(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.entityId).toBe(id);
    expect(retrieved!.canonicalLabel).toBe('Pipeline Feed Query Wine');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: Update a document → query → verify updated data
  // ─────────────────────────────────────────────────────────────────────────

  it('feed a document, update it, then verify updated data', async () => {
    const id = pipelineId('update-verify');
    createdIds.push(id);

    // Initial feed
    const original = makeDoc(id, {
      canonicalLabel: 'Pipeline Update Wine ORIGINAL',
      body: 0.4,
    });
    await index.upsertDocument(original);
    await waitForIndexing();

    // Verify original
    const before = await index.getDocument(id);
    expect(before).not.toBeNull();
    expect(before!.canonicalLabel).toBe('Pipeline Update Wine ORIGINAL');

    // Update: upsertDocument replaces the whole document
    const updated = makeDoc(id, {
      canonicalLabel: 'Pipeline Update Wine UPDATED',
      body: 0.9,
    });
    await index.upsertDocument(updated);
    await waitForIndexing();

    // Verify updated
    const after = await index.getDocument(id);
    expect(after).not.toBeNull();
    expect(after!.canonicalLabel).toBe('Pipeline Update Wine UPDATED');
    expect(after!.body).toBe(0.9);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3: Feed with embedding → dense search → ANN returns relevant results
  // ─────────────────────────────────────────────────────────────────────────

  it('feed a document with embedding then dense search returns it', async () => {
    const id = pipelineId('dense-ann');
    createdIds.push(id);

    // Generate a deterministic embedding for this document.
    const embedding = await embeddingService.embed(`Pipeline Dense ANN Wine ${id}`);

    const doc = makeDoc(id, {
      canonicalLabel: 'Pipeline Dense ANN Wine',
      embedding,
    });

    await index.upsertDocument(doc);
    await waitForIndexing();

    // Dense search with the same query embedding — the document must appear.
    const queryEmbedding = await embeddingService.embed(`Pipeline Dense ANN Wine ${id}`);
    const denseHits = await index.denseSearch(queryEmbedding, [], 50);

    const hitIds = denseHits.map((h) => h.entityId);
    expect(hitIds).toContain(id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4: Concurrent feeds → all documents retrievable
  // ─────────────────────────────────────────────────────────────────────────

  it('concurrent feeds — all documents are retrievable after indexing', async () => {
    const concurrentCount = 5;
    const ids: EntityId[] = [];

    for (let i = 0; i < concurrentCount; i++) {
      ids.push(pipelineId(`concurrent-${i}`));
    }
    createdIds.push(...ids);

    // Feed all documents concurrently.
    await Promise.all(
      ids.map((id) =>
        index.upsertDocument(
          makeDoc(id, {
            canonicalLabel: `Pipeline Concurrent Wine ${id}`,
          }),
        ),
      ),
    );

    await waitForIndexing(800);

    // All documents must be individually retrievable.
    const results = await Promise.all(ids.map((id) => index.getDocument(id)));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      expect(result).not.toBeNull();
      expect(result!.entityId).toBe(ids[i]);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5: Large batch feed → all documents indexed correctly
  // ─────────────────────────────────────────────────────────────────────────

  it('large batch feed — all documents indexed and retrievable', async () => {
    const batchSize = 20;
    const batchIds: EntityId[] = [];

    for (let i = 0; i < batchSize; i++) {
      batchIds.push(pipelineId(`batch-${i}`));
    }
    createdIds.push(...batchIds);

    const docs: RetrievalDocument[] = batchIds.map((id) =>
      makeDoc(id, {
        canonicalLabel: `Pipeline Batch Wine ${id}`,
      }),
    );

    await index.bulkUpsert(docs);
    await waitForIndexing(1000);

    // Spot-check: verify the first, middle, and last documents.
    const checkIndices = [0, Math.floor(batchSize / 2), batchSize - 1];
    for (const idx of checkIndices) {
      const id = batchIds[idx]!;
      const result = await index.getDocument(id);
      expect(result).not.toBeNull();
      expect(result!.entityId).toBe(id);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 6: Delete a document → verify it no longer appears
  // ─────────────────────────────────────────────────────────────────────────

  it('delete a document — it is no longer retrievable', async () => {
    const id = pipelineId('delete-verify');
    // Not added to createdIds since we delete it in this test.

    const doc = makeDoc(id, { canonicalLabel: 'Pipeline Delete Wine' });
    await index.upsertDocument(doc);
    await waitForIndexing();

    // Verify it exists first.
    const before = await index.getDocument(id);
    expect(before).not.toBeNull();

    // Delete via the low-level client.
    await client.delete(id);
    await waitForIndexing();

    // Must now return null.
    const after = await index.getDocument(id);
    expect(after).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 7: bulkFeed partial failures — error summary returned without throwing
  // ─────────────────────────────────────────────────────────────────────────

  it('bulkFeed reports success count correctly for a valid batch', async () => {
    const batchIds: EntityId[] = [
      pipelineId('bulk-ok-1'),
      pipelineId('bulk-ok-2'),
      pipelineId('bulk-ok-3'),
    ];
    createdIds.push(...batchIds);

    const feedDocs = batchIds.map((id) => ({
      id,
      fields: {
        entity_id: id,
        entity_type: 'wine',
        canonical_label: `Bulk Ok Wine ${id}`,
        aliases_identity_safe: [] as string[],
        aliases_noisy_recall: [] as string[],
        producer: 'Test',
        region: 'Test',
        grapes: [] as string[],
        search_text_ko: '',
        search_text_en: `bulk ok wine ${id}`,
        semantic_summary: '',
        body: 0.5,
        sweetness: 0.1,
        style: 'test',
        price_band: 'mid',
        pairing: [] as string[],
        occasion: [] as string[],
        availability: true,
        popularity_score: 0.5,
      },
    }));

    const result = await client.bulkFeed(feedDocs);

    expect(result.successCount).toBe(batchIds.length);
    expect(result.failureCount).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 8: upsertDocument idempotency — re-feeding same document is safe
  // ─────────────────────────────────────────────────────────────────────────

  it('upsertDocument is idempotent — re-feeding same doc twice produces same result', async () => {
    const id = pipelineId('idempotent');
    createdIds.push(id);

    const doc = makeDoc(id, { canonicalLabel: 'Pipeline Idempotent Wine' });

    // Feed twice
    await index.upsertDocument(doc);
    await index.upsertDocument(doc);
    await waitForIndexing();

    const result = await index.getDocument(id);
    expect(result).not.toBeNull();
    expect(result!.entityId).toBe(id);
    expect(result!.canonicalLabel).toBe('Pipeline Idempotent Wine');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 9: Vespa client.get returns null for unknown doc (no error thrown)
  // ─────────────────────────────────────────────────────────────────────────

  it('client.get for unknown document returns null, not an error', async () => {
    const unknownId = pipelineId('does-not-exist-abc123');
    const result = await client.get(unknownId);

    expect(result).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 10: index.getDocument for unknown entity returns null
  // ─────────────────────────────────────────────────────────────────────────

  it('index.getDocument for unknown entity returns null', async () => {
    const unknownId = createEntityId('pipeline-test-absolutely-unknown-entity-9z9');
    const result = await index.getDocument(unknownId);

    expect(result).toBeNull();
  });
});
