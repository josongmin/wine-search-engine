/**
 * Regression: Promise.all → Promise.allSettled resilience.
 *
 * Verifies that parallel document fetches (resolver candidates, candidate
 * attributes, watchlist getDocuments) degrade gracefully when individual
 * lookups fail, instead of aborting the entire batch.
 *
 * Bug: Promise.all propagates the first rejection, causing N-1 successful
 * fetches to be discarded when a single Vespa/network error occurs.
 * Fix: Switch to Promise.allSettled and collect fulfilled results only.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildResolverCandidatesFromPlan } from '../../src/application/search/search-usecase-resolver-candidates.js';
import { VespaCandidateAttributes } from '../../src/infrastructure/vespa/vespa-candidate-attributes.js';
import { WatchlistAwareSearchIndex } from '../../src/infrastructure/watchlist/watchlist-aware-search-index.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { EntityId } from '../../src/domain/shared/types/index.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import type { SearchIndexPort } from '../../src/domain/retrieval/port/search-index.port.js';

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

function makePlanWithAnchors(entityIds: string[]): QueryPlanV1 {
  return {
    route: 'hybrid',
    queryClass: 'entity_lookup',
    normalizedQuery: 'test',
    retrievalMode: 'hybrid',
    constraints: { hard: [], soft: [] },
    expansions: { lexical: [], semantic: [] },
    anchors: entityIds.map((id) => ({
      surfaceForm: `wine-${id}`,
      normalizedForm: `wine-${id}`,
      candidateEntityIds: [createEntityId(id)],
      confidence: 0.9,
    })),
  } as QueryPlanV1;
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
  describe('buildResolverCandidatesFromPlan', () => {
    it('returns surviving candidates when one getDocument rejects', async () => {
      const goodId = 'entity-good';
      const failId = 'entity-fail';
      const doc = makeDoc(goodId);
      const plan = makePlanWithAnchors([goodId, failId]);

      const entityLookup = {
        getDocument: vi.fn(async (id: EntityId) => {
          if (String(id) === failId) {
            throw new Error('Vespa timeout');
          }
          return doc;
        }),
      };

      const result = await buildResolverCandidatesFromPlan(plan, entityLookup);
      expect(result.length).toBe(1);
      expect(result[0]!.entityId).toBe(createEntityId(goodId));
    });

    it('returns empty array when all getDocument calls reject', async () => {
      const plan = makePlanWithAnchors(['a', 'b']);
      const entityLookup = {
        getDocument: vi.fn(async () => {
          throw new Error('total Vespa outage');
        }),
      };

      const result = await buildResolverCandidatesFromPlan(plan, entityLookup);
      expect(result).toEqual([]);
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
