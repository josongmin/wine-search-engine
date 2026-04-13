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
    it('rejects when one getDocument rejects and hydration becomes incomplete', async () => {
      const goodId = 'entity-good';
      const failId = 'entity-fail';
      const doc = makeDoc(goodId);
      const input = makeGeneratorInputWithAnchors([goodId, failId]);

      const entityLookup = {
        getDocument: vi.fn(async (id: EntityId) => {
          if (String(id) === failId) {
            throw new Error('Vespa timeout');
          }
          return doc;
        }),
      };

      await expect(buildResolverCandidatesFromGenerator(input, entityLookup)).rejects.toMatchObject({
        code: 'INTERNAL_INCONSISTENCY',
      });
    });

    it('rejects when all getDocument calls reject', async () => {
      const input = makeGeneratorInputWithAnchors(['a', 'b']);
      const entityLookup = {
        getDocument: vi.fn(async () => {
          throw new Error('total Vespa outage');
        }),
      };

      await expect(buildResolverCandidatesFromGenerator(input, entityLookup)).rejects.toMatchObject({
        code: 'INTERNAL_INCONSISTENCY',
      });
    });
  });

  describe('VespaCandidateAttributes.loadAttributes (fallback path)', () => {
    it('returns surviving attributes when one entity fetch fails', async () => {
      const goodId = createEntityId('good-1');
      const failId = createEntityId('fail-1');
      const goodDoc = makeDoc('good-1');

      const docs = new Map<string, RetrievalDocument>([[String(goodId), goodDoc]]);
      const index = makeSearchIndexStub(docs, new Set([String(failId)]));
      // Ensure the fallback path is used (no getDocuments method)
      delete (index as Record<string, unknown>)['getDocuments'];

      const attrs = new VespaCandidateAttributes(index);
      const result = await attrs.loadAttributes([goodId, failId]);

      expect(result.size).toBe(1);
      expect(result.has(goodId)).toBe(true);
      expect(result.has(failId)).toBe(false);
    });
  });

  describe('WatchlistAwareSearchIndex.getDocuments (fallback path)', () => {
    it('returns surviving docs when one getDocument fails', async () => {
      const goodId = createEntityId('wl-good');
      const failId = createEntityId('wl-fail');
      const goodDoc = makeDoc('wl-good');

      const docs = new Map<string, RetrievalDocument>([[String(goodId), goodDoc]]);
      const inner = makeSearchIndexStub(docs, new Set([String(failId)]));
      // Ensure the fallback path is used (no getDocuments method)
      delete (inner as Record<string, unknown>)['getDocuments'];

      const publisher = {
        publishUpdate: vi.fn(),
      };

      const index = new WatchlistAwareSearchIndex({
        inner,
        publisher,
      });

      const result = await index.getDocuments([goodId, failId]);

      expect(result.size).toBe(1);
      expect(result.has(goodId)).toBe(true);
      expect(result.has(failId)).toBe(false);
    });

    it('returns empty map when all getDocument calls reject', async () => {
      const inner = makeSearchIndexStub(new Map(), new Set(['a', 'b']));
      delete (inner as Record<string, unknown>)['getDocuments'];

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
