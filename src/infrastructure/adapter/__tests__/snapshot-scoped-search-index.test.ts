import { describe, expect, it, vi } from 'vitest';
import { SnapshotScopedSearchIndex } from '../snapshot-scoped-search-index.js';

describe('SnapshotScopedSearchIndex', () => {
  it('appends the target snapshot filter to sparse/dense/learned-sparse queries', async () => {
    const inner = {
      sparseSearch: vi.fn(async () => []),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(),
      getDocuments: vi.fn(),
      upsertDocument: vi.fn(),
      bulkUpsert: vi.fn(),
    } as never;
    const index = new SnapshotScopedSearchIndex({
      inner,
      snapshotId: 'search-snapshot:v1:target',
    });

    await index.sparseSearch(['barolo'], ['wine_type:red'], 10, 'hybrid', 'req-1');
    await index.denseSearch([0.1, 0.2], ['price_usd_max:20'], 5, 'hybrid', 'req-2');
    await index.searchLearnedSparse([{ token: 'barolo', weight: 1 }], ['country:Italy'], 8, 'req-3');

    expect(inner.sparseSearch).toHaveBeenCalledWith(
      ['barolo'],
      ['wine_type:red', 'search_snapshot_id:search-snapshot:v1:target'],
      10,
      'hybrid',
      'req-1',
    );
    expect(inner.denseSearch).toHaveBeenCalledWith(
      [0.1, 0.2],
      ['price_usd_max:20', 'search_snapshot_id:search-snapshot:v1:target'],
      5,
      'hybrid',
      'req-2',
    );
    expect(inner.searchLearnedSparse).toHaveBeenCalledWith(
      [{ token: 'barolo', weight: 1 }],
      ['country:Italy', 'search_snapshot_id:search-snapshot:v1:target'],
      8,
      'req-3',
    );
  });

  it('does not duplicate the target snapshot filter when it is already present', async () => {
    const inner = {
      sparseSearch: vi.fn(async () => []),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(),
      getDocuments: vi.fn(),
      upsertDocument: vi.fn(),
      bulkUpsert: vi.fn(),
    } as never;
    const index = new SnapshotScopedSearchIndex({
      inner,
      snapshotId: 'search-snapshot:v1:target',
    });

    await index.sparseSearch(['barolo'], ['search_snapshot_id:search-snapshot:v1:target']);

    expect(inner.sparseSearch).toHaveBeenCalledWith(
      ['barolo'],
      ['search_snapshot_id:search-snapshot:v1:target'],
      undefined,
      undefined,
      undefined,
    );
  });

  it('fails closed on conflicting snapshot filters', async () => {
    const inner = {
      sparseSearch: vi.fn(async () => []),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(),
      getDocuments: vi.fn(),
      upsertDocument: vi.fn(),
      bulkUpsert: vi.fn(),
    } as never;
    const index = new SnapshotScopedSearchIndex({
      inner,
      snapshotId: 'search-snapshot:v1:target',
    });

    expect(() =>
      index.sparseSearch(['barolo'], ['search_snapshot_id:search-snapshot:v1:other']),
    ).toThrow(/conflicting search_snapshot_id filter/);
    expect(inner.sparseSearch).not.toHaveBeenCalled();
  });
});
