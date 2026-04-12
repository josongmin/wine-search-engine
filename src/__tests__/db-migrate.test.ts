import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const query = vi.fn(async () => undefined);
const getPgPool = vi.fn(() => ({ query }));
const readFileSync = vi.fn(() => '-- migration sql');

vi.mock('fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Vitest `importOriginal` needs a concrete module type; `import('fs')` is the stable Node entry.
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync,
  };
});

vi.mock('../infrastructure/db/pg-pool.js', () => ({
  getPgPool,
}));

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../infrastructure/db/migrations',
);

describe('runMigrations', () => {
  beforeEach(() => {
    query.mockClear();
    getPgPool.mockClear();
    readFileSync.mockClear();
  });

  it('executes every bundled SQL migration in lexical order', async () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- `vi.importActual` requires a module type operand.
    const { readdirSync: readdirActual } = await vi.importActual<typeof import('fs')>('fs');
    const expectedMigrationFiles = readdirActual(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort((left, right) => left.localeCompare(right, 'en'));

    const { runMigrations } = await import('../infrastructure/db/migrate.js');

    await runMigrations();

    expect(getPgPool).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenCalledTimes(expectedMigrationFiles.length);
    expect(query).toHaveBeenCalledTimes(expectedMigrationFiles.length);
    for (const fileName of expectedMigrationFiles) {
      expect(readFileSync).toHaveBeenCalledWith(
        expect.stringContaining(fileName),
        'utf-8',
      );
    }
    expect(query).toHaveBeenCalledWith('-- migration sql');
  });
});
