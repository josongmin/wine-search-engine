/**
 * Regression: `VespaSearchIndex.getDocumentsReport` surfaces partial-success
 * shape so callers can fail loud on silent data loss.
 *
 * Pre-fix: `getDocuments(ids)` returned `ReadonlyMap<EntityId, Doc>` only.
 * When (a) a batch-level Vespa query rejected, or (b) an individual hit
 * failed `fromVespaFields()` parsing, the affected ids were silently
 * omitted from the map. The only signal was a `bootstrapLogger.warn` line;
 * callers had no programmatic handle on `missingIds` / `parseFailures` /
 * `batchFailures`, so policy-blocking downstream code could not enforce
 * "all-or-nothing" semantics without re-computing the diff against the
 * requested id list.
 *
 * The fix introduces `getDocumentsReport(ids)` returning:
 *
 *   {
 *     docs: ReadonlyMap<CanonicalEntityId, RetrievalDocument>,
 *     missingIds: readonly CanonicalEntityId[],
 *     parseFailures: number,
 *     batchFailures: number,
 *   }
 *
 * The legacy `getDocuments(ids)` still returns the bare Map (backward
 * compatible), but is now implemented in terms of `getDocumentsReport`
 * and emits a stronger warn() line when `parseFailures > 0` or
 * `batchFailures > 0`.
 *
 * Pins:
 *  1. Success-case: full hydration, missingIds empty, parseFailures=0,
 *     batchFailures=0.
 *  2. Partial parse failure: the malformed id appears in missingIds, the
 *     parseFailures count matches, and the valid doc is still returned.
 *  3. Whole-batch failure (Vespa query rejects): every id in the failing
 *     batch lands in missingIds, batchFailures increments by 1, and any
 *     parallel batch's docs are preserved.
 */

import { describe, expect, it, vi } from 'vitest';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import { VespaSearchIndex } from '../../src/infrastructure/vespa/vespa-search-index.js';
import type { VespaClient, VespaQueryResponse } from '../../src/infrastructure/vespa/vespa-client.js';
import { VESPA_BULK_HYDRATION_BATCH_SIZE } from '../../src/infrastructure/vespa/per-channel-timeouts.js';

function fullDocFields(entityId: string): Record<string, unknown> {
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

function malformedDocFields(entityId: string): Record<string, unknown> {
  // canonical_label intentionally omitted -> fromVespaFields throws.
  return {
    entity_id: entityId,
    entity_type: 'wine',
    producer: 'Bad Producer',
    region: 'Bad Region',
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
  };
}

function makeQueryResponse(fieldsList: Record<string, unknown>[]): VespaQueryResponse {
  return {
    root: {
      id: 'root',
      relevance: 1,
      children: fieldsList.map((fields, index) => ({
        id: `id:wine:wine_entity::doc-${index}`,
        relevance: 1,
        source: 'content',
        fields,
      })),
    },
  };
}

describe('VespaSearchIndex.getDocumentsReport (regression)', () => {
  it('success case: missingIds is empty, parseFailures=0, batchFailures=0', async () => {
    const idA = createEntityId('partial-success-a');
    const idB = createEntityId('partial-success-b');
    const client = {
      get: vi.fn(),
      query: vi.fn().mockResolvedValue(
        makeQueryResponse([fullDocFields(idA), fullDocFields(idB)]),
      ),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    const report = await index.getDocumentsReport([idA, idB]);

    expect(report.docs.size).toBe(2);
    expect(report.docs.get(idA)).toBeDefined();
    expect(report.docs.get(idB)).toBeDefined();
    expect(report.missingIds).toEqual([]);
    expect(report.parseFailures).toBe(0);
    expect(report.batchFailures).toBe(0);
  });

  it('parse failure: malformed id appears in missingIds, parseFailures matches, valid doc preserved', async () => {
    const validId = createEntityId('partial-parse-valid');
    const malformedId = createEntityId('partial-parse-malformed');
    const client = {
      get: vi.fn(),
      query: vi.fn().mockResolvedValue(
        makeQueryResponse([fullDocFields(validId), malformedDocFields(malformedId)]),
      ),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    const report = await index.getDocumentsReport([validId, malformedId]);

    expect(report.docs.size).toBe(1);
    expect(report.docs.get(validId)).toBeDefined();
    expect(report.docs.get(malformedId)).toBeUndefined();
    expect(report.missingIds).toContain(malformedId);
    expect(report.missingIds).not.toContain(validId);
    expect(report.parseFailures).toBe(1);
    expect(report.batchFailures).toBe(0);
  });

  it('whole-batch failure: every id in failing batch lands in missingIds, batchFailures increments, parallel batch survives', async () => {
    // Force two batches by exceeding FETCH_SUMMARY_BATCH_SIZE.
    const batchSize = VESPA_BULK_HYDRATION_BATCH_SIZE;
    const firstBatchIds = Array.from({ length: batchSize }, (_unused, i) =>
      createEntityId(`partial-batchfail-first-${i}`),
    );
    const secondBatchIds = [createEntityId('partial-batchfail-second-0')];

    let queryCallCount = 0;
    const client = {
      get: vi.fn(),
      query: vi.fn().mockImplementation(() => {
        queryCallCount += 1;
        if (queryCallCount === 1) {
          // First batch — surviving. Returns all firstBatch docs.
          return Promise.resolve(makeQueryResponse(firstBatchIds.map((id) => fullDocFields(id))));
        }
        // Second batch — entire query fails (e.g. Vespa timeout / 5xx).
        return Promise.reject(new Error('Vespa timeout simulated'));
      }),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    const report = await index.getDocumentsReport([...firstBatchIds, ...secondBatchIds]);

    // First batch survived — all firstBatchIds present in docs.
    expect(report.docs.size).toBe(firstBatchIds.length);
    for (const id of firstBatchIds) {
      expect(report.docs.get(id)).toBeDefined();
    }
    // Second batch wiped — its sole id is in missingIds.
    expect(report.missingIds).toEqual(secondBatchIds);
    expect(report.batchFailures).toBe(1);
    // parseFailures untouched by batch-level failure.
    expect(report.parseFailures).toBe(0);
  });

  it('legacy getDocuments(ids) remains backward-compatible: returns Map only', async () => {
    const idA = createEntityId('legacy-shape-a');
    const client = {
      get: vi.fn(),
      query: vi.fn().mockResolvedValue(makeQueryResponse([fullDocFields(idA)])),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);
    const docs = await index.getDocuments([idA]);

    // Shape: ReadonlyMap, not the report object.
    expect(docs).toBeInstanceOf(Map);
    expect(docs.size).toBe(1);
    expect(docs.get(idA)).toBeDefined();
  });
});
