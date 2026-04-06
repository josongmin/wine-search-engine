import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn(async () => undefined);
const getPgPool = vi.fn(() => ({ query }));
const readdirSync = vi.fn(() => [
  '010_later.sql',
  '001_initial.sql',
  '002_watchlist.sql',
]);
const readFileSync = vi.fn((path: string) => `-- ${path}`);

vi.mock('fs', () => ({
  readdirSync,
  readFileSync,
}));

vi.mock('../infrastructure/db/pg-pool.js', () => ({
  getPgPool,
}));

describe('runMigrations', () => {
  beforeEach(() => {
    query.mockClear();
    getPgPool.mockClear();
    readdirSync.mockClear();
    readFileSync.mockClear();
  });

  it('executes all SQL migration files in sorted order', async () => {
    const { runMigrations } = await import('../infrastructure/db/migrate.js');

    await runMigrations();

    expect(getPgPool).toHaveBeenCalledTimes(1);
    expect(readdirSync).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/migrations/001_initial.sql'),
      'utf-8',
    );
    expect(readFileSync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/migrations/002_watchlist.sql'),
      'utf-8',
    );
    expect(readFileSync).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('/migrations/010_later.sql'),
      'utf-8',
    );
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/migrations/001_initial.sql'),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/migrations/002_watchlist.sql'),
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('/migrations/010_later.sql'),
    );
  });
});
