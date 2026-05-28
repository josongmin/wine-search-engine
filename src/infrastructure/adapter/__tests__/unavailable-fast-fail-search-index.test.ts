import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import type { SearchIndexPort } from '../../../domain/retrieval/port/search-index.port.js';
import { CircuitBreakerOpenError } from '../../../domain/shared/error/circuit-breaker-open-error.js';
import type {
  RetrievalDocument,
  RetrievalDrinkingWindowProjection,
} from '../../../domain/retrieval/model/retrieval-document.js';
import type { CanonicalEntityId } from '../../../domain/shared/types/index.js';
import { SearchIndexAliasMatcher } from '../search-index-alias-matcher.js';
import { VespaHttpError, VespaNetworkError } from '../../vespa/vespa-client.js';
import { UnavailableFastFailSearchIndex } from '../unavailable-fast-fail-search-index.js';

function createSearchIndexStub(): SearchIndexPort & {
  readonly sparseSearch: ReturnType<typeof vi.fn>;
  readonly denseSearch: ReturnType<typeof vi.fn>;
  readonly searchLearnedSparse: ReturnType<typeof vi.fn>;
} {
  return {
    sparseSearch: vi.fn(async () => []),
    denseSearch: vi.fn(async () => []),
    searchLearnedSparse: vi.fn(async () => []),
    getDocument: vi.fn(async () => null),
    getDocuments: vi.fn(async () => new Map<CanonicalEntityId, RetrievalDocument>()),
    getDrinkingWindowDocuments: vi.fn(async () => new Map<CanonicalEntityId, RetrievalDrinkingWindowProjection>()),
    upsertDocument: vi.fn(async () => {}),
    bulkUpsert: vi.fn(async () => {}),
  };
}

describe('UnavailableFastFailSearchIndex', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on Vespa transport failure and fast-fails subsequent retrieval calls', async () => {
    const inner = createSearchIndexStub();
    inner.sparseSearch.mockRejectedValueOnce(
      new VespaNetworkError('Vespa request timed out after 3000ms', new Error('connect ETIMEDOUT')),
    );
    const searchIndex = new UnavailableFastFailSearchIndex(inner);

    await expect(searchIndex.sparseSearch(['medium body united states'])).rejects.toBeInstanceOf(VespaNetworkError);
    await expect(searchIndex.denseSearch([0.1, 0.2, 0.3])).rejects.toBeInstanceOf(CircuitBreakerOpenError);

    expect(inner.sparseSearch).toHaveBeenCalledTimes(1);
    expect(inner.denseSearch).not.toHaveBeenCalled();
  });

  it('does not open on Vespa client errors caused by bad queries', async () => {
    const inner = createSearchIndexStub();
    inner.sparseSearch.mockRejectedValueOnce(
      new VespaHttpError('Vespa sparseSearch failed [HTTP 400]: bad query', 400, false, true),
    );
    const searchIndex = new UnavailableFastFailSearchIndex(inner);

    await expect(searchIndex.sparseSearch(['invalid yql'])).rejects.toBeInstanceOf(VespaHttpError);
    await expect(searchIndex.denseSearch([0.1, 0.2, 0.3])).resolves.toEqual([]);

    expect(inner.sparseSearch).toHaveBeenCalledTimes(1);
    expect(inner.denseSearch).toHaveBeenCalledTimes(1);
  });

  it('carries alias lookup transport failure forward to later retrieval calls on the same shared search index', async () => {
    const inner = createSearchIndexStub();
    inner.sparseSearch.mockRejectedValueOnce(
      new VespaNetworkError('Vespa request timed out after 3000ms', new Error('connect ETIMEDOUT')),
    );
    const searchIndex = new UnavailableFastFailSearchIndex(inner);
    const aliasMatcher = new SearchIndexAliasMatcher(searchIndex);

    const matches = await aliasMatcher.findMatchesBatch(['medium body united states']);

    expect(matches.get('medium body united states')).toEqual([]);
    await expect(searchIndex.denseSearch([0.1, 0.2, 0.3])).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(inner.sparseSearch).toHaveBeenCalledTimes(1);
    expect(inner.denseSearch).not.toHaveBeenCalled();
  });

  it('allows a half-open probe after the recovery window elapses', async () => {
    vi.useFakeTimers();

    const inner = createSearchIndexStub();
    inner.sparseSearch
      .mockRejectedValueOnce(
        new VespaNetworkError('Vespa request timed out after 3000ms', new Error('connect ETIMEDOUT')),
      )
      .mockResolvedValueOnce([]);
    const searchIndex = new UnavailableFastFailSearchIndex(inner, {
      recoveryTimeoutMs: 1_000,
    });

    await expect(searchIndex.sparseSearch(['first miss'])).rejects.toBeInstanceOf(VespaNetworkError);
    await expect(searchIndex.sparseSearch(['still open'])).rejects.toBeInstanceOf(CircuitBreakerOpenError);

    vi.advanceTimersByTime(1_000);

    await expect(searchIndex.sparseSearch(['half open probe'])).resolves.toEqual([]);
    expect(inner.sparseSearch).toHaveBeenCalledTimes(2);
  });
});
