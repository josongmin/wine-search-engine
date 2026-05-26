/**
 * Regression: partial resolver hydration is permanently fail-closed.
 *
 * Contract pinned here:
 *  1. Any unresolved entity id throws `partial_resolution_forbidden`.
 *  2. Legacy env toggles do NOT re-enable graceful subset resolution.
 *  3. Fully resolved hydration remains unaffected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildResolverCandidatesFromGenerator } from '../../src/application/search/search-usecase-resolver-candidates.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import type { EntityDocumentLookupPort } from '../../src/application/search/port/search-pipeline-deps.port.js';

function makeDoc(id: string): RetrievalDocument {
  return {
    entityId: createEntityId(id),
    canonicalLabel: id,
    producer: 'p',
    region: 'r',
    grapes: ['Cabernet Sauvignon'],
    aliases: [],
    aliasFloors: {},
  } as unknown as RetrievalDocument;
}

function makeAnchor(ids: readonly string[]) {
  return {
    surfaceForm: 'x',
    normalizedForm: 'x',
    confidence: 0.9,
    candidateEntityIds: ids.map((s) => createEntityId(s)),
    lookupStrategies: ['exact'],
    aliasType: 'canonical',
    source: 'alias',
  } as never;
}

function makePartialLookup(presentIds: readonly string[]): EntityDocumentLookupPort {
  return {
    async getDocuments(ids) {
      const present = new Set(presentIds);
      const out = new Map();
      for (const id of ids) {
        if (present.has(String(id))) out.set(id, makeDoc(String(id)));
      }
      return out;
    },
  } as never;
}

describe('partial_resolution is strict fail-closed', () => {
  const originalFlag = process.env['WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION'];

  beforeEach(() => {
    delete process.env['WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION'];
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env['WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION'];
    else process.env['WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION'] = originalFlag;
  });

  it('STRICT (default): throws partial_resolution_forbidden when any id is unresolved', async () => {
    const input = {
      anchors: [makeAnchor(['e1', 'e2'])],
      rawQuery: 'q',
      normalizedQuery: 'q',
      blockerOnlyIds: [],
      preloadedDocs: null,
    } as never;
    const lookup = makePartialLookup(['e1']);  // e2 missing
    await expect(
      buildResolverCandidatesFromGenerator(input, lookup),
    ).rejects.toThrow(/partial_resolution_forbidden/);
  });

  it('ignores legacy WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION=1 and still rejects partial hydration', async () => {
    process.env['WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION'] = '1';
    const input = {
      anchors: [makeAnchor(['e1', 'e2'])],
      rawQuery: 'q',
      normalizedQuery: 'q',
      blockerOnlyIds: [],
      preloadedDocs: null,
    } as never;
    const lookup = makePartialLookup(['e1']);
    await expect(buildResolverCandidatesFromGenerator(input, lookup)).rejects.toThrow(
      /partial_resolution_forbidden/,
    );
  });

  it('all ids found remains unaffected', async () => {
    process.env['WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION'] = '1';
    const input = {
      anchors: [makeAnchor(['e1', 'e2'])],
      rawQuery: 'q',
      normalizedQuery: 'q',
      blockerOnlyIds: [],
      preloadedDocs: null,
    } as never;
    const lookup = makePartialLookup(['e1', 'e2']);  // all present
    const result = await buildResolverCandidatesFromGenerator(input, lookup);
    expect(result.length).toBe(2);
  });
});
