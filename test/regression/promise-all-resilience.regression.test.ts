/**
 * Regression: Promise.all → Promise.allSettled resilience.
 *
 * Verifies that parallel document fetches either complete fully or fail
 * loudly when hydration is incomplete. Candidate generation no longer hides
 * partial hydration, while other adapters still collect surviving records.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildResolverCandidatesFromGenerator } from '../../src/application/search/search-usecase-resolver-candidates.js';
import { VespaCandidateAttributes } from '../../src/infrastructure/vespa/vespa-candidate-attributes.js';
import { WatchlistAwareSearchIndex } from '../../src/infrastructure/watchlist/watchlist-aware-search-index.js';
import type { EntityId } from '../../src/domain/shared/types/index.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import type { SearchIndexPort } from '../../src/domain/retrieval/port/search-index.port.js';
import type { EntityCandidateGeneratorInput } from '../../src/domain/resolver/model/entity-candidate-generator-input.js';

// ── helpers ──────────────────────────────────────────────────────────────

function makeDoc(entityId: string): RetrievalDocument {
  return {
    entityId: createEntityId(entityId),
    entityType: 'wine',
    canonicalLabel: `Wine ${entityId}`,
    identitySignature: entityId,
    availability: true,
  } as RetrievalDocument;
}

function makeGeneratorInputWithAnchors(entityIds: string[]): EntityCandidateGeneratorInput {
  return {
    rawQuery: 'test',
    normalizedQuery: 'test',
    anchors: entityIds.map((id) => ({
      surfaceForm: `wine-${id}`,
      normalizedForm: `wine-${id}`,
      candidateEntityIds: [createEntityId(id)],
      confidence: 0.9,
      source: 'alias' as const,
    })),
  };
}

function makeSearchIndexStub(
  docs: Map<string, RetrievalDocument>,
  failIds: Set<string>,
): SearchIndexPort {
  return {
    getDocument: vi.fn(async (id: EntityId) => {
      if (failIds.has(String(id))) {
        throw new Error(`Vespa network error for ${String(id)}`);
      }
      return docs.get(String(id)) ?? null;
    }),
    sparseSearch: vi.fn(),
    denseSearch: vi.fn(),
    searchLearnedSparse: vi.fn(),
    upsertDocument: vi.fn(),
    bulkUpsert: vi.fn(),
  } as unknown as SearchIndexPort;
}

// ── tests ────────────────────────────────────────────────────────────────

describe('Promise.all → allSettled resilience (regression)', () => {
  describe('buildResolverCandidatesFromGenerator', () => {
    it('rejects when batch getDocuments returns partial results (T-E4-01: batch-only path)', async () => {
      const goodId = 'entity-good';
      const failId = 'entity-fail';
      const doc = makeDoc(goodId);
      const input = makeGeneratorInputWithAnchors([goodId, failId]);

      // T-E4-01: getDocuments is the required path. Return only the good doc
      // to simulate a partial result — the failId is missing from the map.
      const entityLookup = {
        getDocuments: vi.fn(async () => new Map([[goodId, doc]])),
      };

      await expect(buildResolverCandidatesFromGenerator(input, entityLookup)).rejects.toMatchObject({
        code: 'INTERNAL_INCONSISTENCY',
      });
    });

    it('rejects when batch getDocuments throws (T-E4-01: batch_lookup_failed)', async () => {
      const input = makeGeneratorInputWithAnchors(['a', 'b']);
      const entityLookup = {
        getDocuments: vi.fn(async () => {
          throw new Error('total Vespa outage');
        }),
      };

      await expect(buildResolverCandidatesFromGenerator(input, entityLookup)).rejects.toMatchObject({
        code: 'INTERNAL_INCONSISTENCY',
      });
    });
  });

  describe('VespaCandidateAttributes.loadAttributes (batch path)', () => {
    it('returns surviving attributes when batch getDocuments omits one entity', async () => {
      const goodId = createEntityId('good-1');
      const failId = createEntityId('fail-1');
      const goodDoc = makeDoc('good-1');

      const docs = new Map<string, RetrievalDocument>([[String(goodId), goodDoc]]);
      const index = makeSearchIndexStub(docs, new Set());
      index.getDocuments = vi.fn(async () => new Map([[goodId, goodDoc]]));

      const attrs = new VespaCandidateAttributes(index);
      const result = await attrs.loadAttributes([goodId, failId]);

      expect(result.size).toBe(1);
      expect(result.has(goodId)).toBe(true);
      expect(result.has(failId)).toBe(false);
    });
  });

  describe('WatchlistAwareSearchIndex.getDocuments (fallback path)', () => {
    it('T-E4-01: delegates batch getDocuments to inner when partial results (fallback removed)', async () => {
      // T-E4-01: getDocuments is now required on SearchIndexPort; the single-fetch
      // fallback has been removed. This test verifies that WatchlistAwareSearchIndex
      // delegates to inner.getDocuments and returns partial results as-is.
      const goodId = createEntityId('wl-good');
      const failId = createEntityId('wl-fail');
      const goodDoc = makeDoc('wl-good');

      const inner = makeSearchIndexStub(new Map([[String(goodId), goodDoc]]), new Set());
      // Override getDocuments to return only the good doc (simulating Vespa partial return)
      inner.getDocuments = vi.fn(async () => new Map([[goodId, goodDoc]]));

      const publisher = { publishUpdate: vi.fn() };
      const index = new WatchlistAwareSearchIndex({ inner, publisher });

      const result = await index.getDocuments([goodId, failId]);

      expect(result.size).toBe(1);
      expect(result.has(goodId)).toBe(true);
      expect(result.has(failId)).toBe(false);
    });

    it('T-E4-01: returns empty map when inner getDocuments returns empty', async () => {
      // T-E4-01: getDocuments is now required on SearchIndexPort.
      // Verify that WatchlistAwareSearchIndex delegates empty results correctly.
      const inner = makeSearchIndexStub(new Map(), new Set());
      inner.getDocuments = vi.fn(async () => new Map());

      const publisher = { publishUpdate: vi.fn() };
      const index = new WatchlistAwareSearchIndex({ inner, publisher });

      const result = await index.getDocuments([
        createEntityId('a'),
        createEntityId('b'),
      ]);

      expect(result.size).toBe(0);
    });
  });
});
