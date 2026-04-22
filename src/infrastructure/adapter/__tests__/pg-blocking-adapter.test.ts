import { describe, expect, it, vi } from 'vitest';
import { PgBlockingAdapter } from '../pg-blocking-adapter.js';

describe('PgBlockingAdapter', () => {
  it('returns an empty candidate set when aliases table is absent', async () => {
    const pool = {
      async query(): Promise<never> {
        const err = new Error('relation "aliases" does not exist') as Error & { code?: string };
        err.code = '42P01';
        throw err;
      },
    };

    const adapter = new PgBlockingAdapter(pool as never);

    await expect(adapter.block('opus one', 'opus one')).resolves.toEqual([]);
  });

  it('uses QueryNormalizer lookup variants for Korean transliteration recall', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          active_snapshot_id: 'search-snapshot:test',
          previous_snapshot_id: null,
          content_hash: 'hash',
          promoted_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ entity_id: 'wine-chateau-margaux' }],
      });
    const pool = { query };
    const adapter = new PgBlockingAdapter(pool as never);

    await expect(adapter.block('샤토 마고', '샤토 마고')).resolves.toEqual(['wine-chateau-margaux']);

    const aliasQueryArgs = query.mock.calls[1];
    expect(aliasQueryArgs?.[1]?.[0]).toEqual(
      expect.arrayContaining(['샤토 마고', 'chateau margaux', 'chateaumargaux']),
    );
  });
});
