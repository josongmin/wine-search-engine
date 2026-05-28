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

  it('uses the explicit snapshot override instead of resolving the active pointer', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ entity_id: 'wine-opus-one' }],
    });
    const pool = { query };
    const adapter = new PgBlockingAdapter(pool as never, 'search-snapshot:v1:target');

    await expect(adapter.block('opus one', 'opus one')).resolves.toEqual(['wine-opus-one']);

    expect(query).toHaveBeenCalledTimes(1);
    const aliasQueryArgs = query.mock.calls[0];
    const params = aliasQueryArgs?.[1] as readonly unknown[];
    expect(params[4]).toBe('search-snapshot:v1:target');
  });

  describe('phase 4 — pg_trgm fuzzy match', () => {
    function makeMockedPool() {
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
          rows: [{ entity_id: 'wine-sassicaia' }],
        });
      const pool = { query };
      return { pool, query };
    }

    it('threads the normalized query, similarity threshold, and trigram cap into the alias-lookup SQL params', async () => {
      const { pool, query } = makeMockedPool();
      const adapter = new PgBlockingAdapter(pool as never);

      // Typo case: caller types "Sasicaia" → blocker should still find the
      // canonical "Sassicaia" via the trigram fuzzy phase.
      await adapter.block('Sasicaia', 'sasicaia');

      const aliasQueryArgs = query.mock.calls[1];
      const sqlText = aliasQueryArgs?.[0] as string;
      const params = aliasQueryArgs?.[1] as readonly unknown[];

      // SQL phase 4 must be present and join the union.
      expect(sqlText).toMatch(/trigram_fuzzy_match/);
      expect(sqlText).toMatch(/similarity\(normalized_value/);
      // Pre-existing phases preserved.
      expect(sqlText).toMatch(/exact_match/);
      expect(sqlText).toMatch(/prefix_match/);
      expect(sqlText).toMatch(/ilike_match/);

      // $6 = normalized query string fed into similarity().
      expect(params[5]).toBe('sasicaia');
      // $7 = fuzzy similarity threshold (numeric in [0, 1]).
      expect(typeof params[6]).toBe('number');
      expect(params[6]).toBeGreaterThan(0);
      expect(params[6]).toBeLessThanOrEqual(1);
      // $8 = trigram phase cap (positive integer).
      expect(typeof params[7]).toBe('number');
      expect(params[7]).toBeGreaterThan(0);
      expect(Number.isInteger(params[7])).toBe(true);
    });

    it('returns the union of all four phases (e.g. trigram_fuzzy_match contributes recall the substring phases miss)', async () => {
      const { pool } = makeMockedPool();
      const adapter = new PgBlockingAdapter(pool as never);
      await expect(adapter.block('Sasicaia', 'sasicaia')).resolves.toEqual(['wine-sassicaia']);
    });
  });
});
