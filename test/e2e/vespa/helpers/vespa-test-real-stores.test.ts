import { afterEach, describe, expect, it } from 'vitest';
import { createVespaTestRealStores } from './vespa-test-real-stores.js';

describe('createVespaTestRealStores', () => {
  const originalTestDbUrl = process.env['TEST_DB_URL'];

  afterEach(() => {
    if (originalTestDbUrl === undefined) {
      delete process.env['TEST_DB_URL'];
    } else {
      process.env['TEST_DB_URL'] = originalTestDbUrl;
    }
  });

  it('falls back to in-memory stores when TEST_DB_URL is not set', async () => {
    delete process.env['TEST_DB_URL'];

    const stores = await createVespaTestRealStores();

    expect(stores.backing).toBe('memory');
    await expect(stores.close()).resolves.toBeUndefined();
  });
});
