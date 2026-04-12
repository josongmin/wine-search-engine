import { describe, expect, it } from 'vitest';
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
});
