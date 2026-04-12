import { describe, expect, it } from 'vitest';
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
});
