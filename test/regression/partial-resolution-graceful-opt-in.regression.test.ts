/**
 * Regression: `partial_resolution_forbidden` is opt-in-graceful via
 * `WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION=1` (F8).
 *
 * Pre-fix: ANY unresolved entity in the hydration set threw a hard
 * `INTERNAL_INCONSISTENCY` DomainError. The PtE bench's 8 critical-fails
 * (#117-#124) traced to PG alias-overlay drift, NOT to wrong agent code —
 * the strict mode short-circuited otherwise-recoverable scenarios into
 * Layer-4 fallback.
 *
 * The opt-in flag lets bench/operator environments with known data drift
 * proceed with the resolved subset (legacy ReAct's tolerance) while
 * production remains strict-reject by default.
 *
 * Contract pinned here:
 *  1. Flag UNSET / not exactly `'1'` → strict reject (existing behaviour).
 *  2. Flag === `'1'` → log + proceed with the resolved subset.
 *  3. Empty unresolved set is a no-op regardless of flag.
 *
 * The graceful path is verified via a structural call into
 * `buildResolverCandidatesFromGenerator` with a mock entityLookup that
 * returns partial results.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildResolverCandidatesFromGenerator } from '../../src/application/search/search-usecase-resolver-candidates.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import type { EntityDocumentLookupPort } from '../../src/application/search/port/entity-document-lookup.port.js';

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
    confidence: 0.9,
    candidateEntityIds: ids.map((s) => createEntityId(s)),
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

describe('partial_resolution graceful opt-in (F8 regression)', () => {
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

  it('GRACEFUL (WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION=1): proceeds with resolved subset, logs warning', async () => {
    process.env['WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION'] = '1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const input = {
      anchors: [makeAnchor(['e1', 'e2'])],
      rawQuery: 'q',
      normalizedQuery: 'q',
      blockerOnlyIds: [],
      preloadedDocs: null,
    } as never;
    const lookup = makePartialLookup(['e1']);

    // The graceful path returns successfully (just the resolved subset).
    const result = await buildResolverCandidatesFromGenerator(input, lookup);
    // exactly one resolved candidate (e1); e2 was dropped.
    expect(result.length).toBe(1);
    // Audit log fired with the deviation summary.
    const warnedWithEvent = warnSpy.mock.calls.some(([msg]) =>
      typeof msg === 'string' && msg.includes('partial_resolution_graceful')
    );
    expect(warnedWithEvent).toBe(true);
    warnSpy.mockRestore();
  });

  it('REJECTS typo values: WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION=true is NOT honoured (must be exactly "1")', async () => {
    process.env['WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION'] = 'true';
    const input = {
      anchors: [makeAnchor(['e1', 'e2'])],
      rawQuery: 'q',
      normalizedQuery: 'q',
      blockerOnlyIds: [],
      preloadedDocs: null,
    } as never;
    const lookup = makePartialLookup(['e1']);
    await expect(
      buildResolverCandidatesFromGenerator(input, lookup),
    ).rejects.toThrow(/partial_resolution_forbidden/);
  });

  it('NO-OP: empty unresolved set (all ids found) is unaffected by the flag', async () => {
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
