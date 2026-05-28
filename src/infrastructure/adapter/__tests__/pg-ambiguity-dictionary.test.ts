import { describe, expect, it, vi } from 'vitest';
import { PgAmbiguityDictionary } from '../pg-ambiguity-dictionary.js';

describe('PgAmbiguityDictionary', () => {
  it('treats missing ambiguity_registry as no ambiguity data', async () => {
    const pool = {
      async query(): Promise<never> {
        const err = new Error('relation "ambiguity_registry" does not exist') as Error & {
          code?: string;
        };
        err.code = '42P01';
        throw err;
      },
    };
    const dictionary = new PgAmbiguityDictionary(pool as never);

    await expect(dictionary.isKnownAmbiguous('opus one')).resolves.toBe(false);
    await expect(dictionary.getAmbiguityInfo('opus one')).resolves.toBeNull();
  });

  it('uses the explicit snapshot override instead of the active pointer', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        normalized_form: 'opus one',
        ambiguity_types: ['producer'],
        severity: 'medium',
      }],
    });
    const pool = { query };
    const dictionary = new PgAmbiguityDictionary(pool as never, 'search-snapshot:v1:target');

    await expect(dictionary.getAmbiguityInfo('opus one')).resolves.toEqual({
      types: ['producer'],
      severity: 'medium',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('search_snapshot_id = $2'),
      ['opus one', 'search-snapshot:v1:target'],
    );
  });
});
