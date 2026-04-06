import { describe, expect, it } from 'vitest';
import { buildCoreAdapterServices } from '../container-adapters.js';
import { parseEnv } from '../env.js';

describe('buildCoreAdapterServices', () => {
  it('rejects stub-backed core adapters in production without PostgreSQL', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    expect(() => buildCoreAdapterServices(config, {})).toThrowError(/PostgreSQL-backed adapters/);
  });

  it('still allows local stub-backed adapters outside production', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    expect(() => buildCoreAdapterServices(config, {})).not.toThrow();
  });
});
