import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn(async () => undefined);
const getPgPool = vi.fn(() => ({ query }));
const readFileSync = vi.fn(() => '-- migration sql');

vi.mock('fs', () => ({
  readFileSync,
}));

vi.mock('../infrastructure/db/pg-pool.js', () => ({
  getPgPool,
}));

describe('runMigrations', () => {
  beforeEach(() => {
    query.mockClear();
    getPgPool.mockClear();
    readFileSync.mockClear();
  });

  it('executes the bundled initial schema migration', async () => {
    const { runMigrations } = await import('../infrastructure/db/migrate.js');

    await runMigrations();

    expect(getPgPool).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenCalledWith(
      expect.stringContaining('001_initial_schema.sql'),
      'utf-8',
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('-- migration sql');
  });
});
