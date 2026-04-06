import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { PgWatchlistStore } from '../../../src/infrastructure/watchlist/pg-watchlist-store.js';
import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
} from '../../../src/domain/watchlist/model/watchlist-entry.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];

async function applyMigrations(pool: Pool): Promise<void> {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../src/infrastructure/db/migrations',
  );
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
  }
}

describe.skipIf(!PG_TEST_URL)('PgWatchlistStore integration', () => {
  let pool: Pool;
  let store: PgWatchlistStore;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: PG_TEST_URL,
      max: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
    });
    await applyMigrations(pool);
    await pool.query('TRUNCATE TABLE watchlist_delivery_logs, watchlists RESTART IDENTITY');
    store = new PgWatchlistStore(pool);
  });

  afterAll(async () => {
    await pool.query('TRUNCATE TABLE watchlist_delivery_logs, watchlists RESTART IDENTITY');
    await pool.end();
  });

  it('persists entries, delivery logs, and cascades logs on delete', async () => {
    const entry: WatchlistEntry = {
      id: randomUUID(),
      userId: randomUUID(),
      entityId: 'wine-opus-one-2018',
      triggerConditions: [
        {
          type: 'price_drop',
          threshold: 10,
          baselinePrice: 120,
        },
      ],
      callbackUrl: 'https://example.com/webhook',
      createdAt: new Date('2026-04-06T00:00:00.000Z'),
      expiresAt: null,
    };
    const log: WatchlistDeliveryLogEntry = {
      id: randomUUID(),
      watchlistId: entry.id,
      attempt: 1,
      statusCode: 200,
      errorMessage: null,
      deliveredAt: new Date('2026-04-06T10:00:00.000Z'),
    };

    await store.save(entry);
    await store.append(log);

    await expect(store.findById(entry.id)).resolves.toEqual(entry);
    await expect(store.findByUserId(entry.userId)).resolves.toEqual([entry]);
    await expect(store.findByEntityId(entry.entityId)).resolves.toEqual([entry]);
    await expect(store.listByWatchlistId(entry.id)).resolves.toEqual([log]);

    await expect(store.delete(entry.id)).resolves.toBe(true);
    await expect(store.findById(entry.id)).resolves.toBeNull();
    await expect(store.listByWatchlistId(entry.id)).resolves.toEqual([]);
  });
});
