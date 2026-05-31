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
import type { EntityId } from '../../src/domain/shared/types/index.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import type { SearchIndexPort } from '../../src/domain/retrieval/port/search-index.port.js';
import type { EntityCandidateGeneratorInput } from '../../src/domain/resolver/model/entity-candidate-generator-input.js';
import { createSilentSkipCounter } from '../../src/domain/observability/silent-skip-counters.js';

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

    it('prefers the non-deprecated getDocumentsReport over getDocuments when the index exposes it', async () => {
      const goodId = createEntityId('good-1');
      const goodDoc = makeDoc('good-1');

      const index = makeSearchIndexStub(new Map(), new Set());
      const legacyGetDocuments = vi.fn(async () => new Map([[goodId, goodDoc]]));
      index.getDocuments = legacyGetDocuments;
      const reportFn = vi.fn(async () => ({
        docs: new Map([[goodId, goodDoc]]),
        missingIds: [] as EntityId[],
        parseFailures: 0,
        batchFailures: 0,
      }));
      (index as unknown as { getDocumentsReport: typeof reportFn }).getDocumentsReport = reportFn;

      const attrs = new VespaCandidateAttributes(index);
      const result = await attrs.loadAttributes([goodId]);

      expect(reportFn).toHaveBeenCalledTimes(1);
      expect(legacyGetDocuments).not.toHaveBeenCalled();
      expect(result.has(goodId)).toBe(true);
    });

    it('surfaces partial-hydration diagnostics via the silent-skip counter when using getDocumentsReport', async () => {
      const goodId = createEntityId('good-1');
      const missingId = createEntityId('missing-1');
      const goodDoc = makeDoc('good-1');

      const counter = createSilentSkipCounter();
      const index = makeSearchIndexStub(new Map(), new Set());
      const reportFn = vi.fn(async () => ({
        docs: new Map([[goodId, goodDoc]]),
        missingIds: [missingId] as EntityId[],
        parseFailures: 1,
        batchFailures: 0,
      }));
      (index as unknown as { getDocumentsReport: typeof reportFn }).getDocumentsReport = reportFn;

      const attrs = new VespaCandidateAttributes(index, counter);
      const result = await attrs.loadAttributes([goodId, missingId]);

      expect(result.has(goodId)).toBe(true);
      expect(result.has(missingId)).toBe(false);
      const snap = counter.snapshot();
      expect(snap.candidate_attributes_hydration_missing).toBe(1);
      expect(snap.candidate_attributes_hydration_parse_failure).toBe(1);
      expect(snap.candidate_attributes_hydration_batch_failure).toBe(0);
    });
  });

});
