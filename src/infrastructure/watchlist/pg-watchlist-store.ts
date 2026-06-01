import type { Pool, PoolClient } from 'pg';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';

interface WatchlistTriggerCondition {
  readonly type: string;
  readonly minVintage?: number | undefined;
}

interface WatchlistEntry {
  readonly id: string;
  readonly userId: string;
  readonly entityId: string;
  readonly triggerConditions: readonly WatchlistTriggerCondition[];
  readonly callbackUrl: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

interface WatchlistDeliveryLogEntry {
  readonly id: string;
  readonly watchlistId: string;
  readonly attempt: number;
  readonly statusCode: number | null;
  readonly errorMessage: string | null;
  readonly deliveredAt: Date;
}

interface WatchlistStoragePort {
  save(entry: WatchlistEntry): Promise<void>;
  findById(id: string): Promise<WatchlistEntry | null>;
  findByUserId(userId: string): Promise<readonly WatchlistEntry[]>;
  findByEntityId(entityId: string): Promise<readonly WatchlistEntry[]>;
  delete(id: string): Promise<boolean>;
  listByWatchlistId(watchlistId: string): Promise<readonly WatchlistDeliveryLogEntry[]>;
  append(log: WatchlistDeliveryLogEntry): Promise<void>;
  clear(): Promise<void>;
}

interface TransactionalWatchlistStore extends WatchlistStoragePort {
  findByIdForUpdate(id: string): Promise<WatchlistEntry | null>;
  withTransaction<T>(fn: (tx: TransactionalWatchlistStore) => Promise<T>): Promise<T>;
}

interface QueryExecutor {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-explicit-any
  query<T = any>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface WatchlistRow {
  watchlist_id: string;
  user_id: string;
  entity_id: string;
  trigger_conditions: unknown;
  callback_url: string;
  created_at: Date;
  expires_at: Date | null;
}

interface WatchlistDeliveryLogRow {
  delivery_log_id: string;
  watchlist_id: string;
  attempt: number;
  status_code: number | null;
  error_message: string | null;
  delivered_at: Date;
}

function parseWatchlistTriggers(raw: unknown): readonly WatchlistTriggerCondition[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const parsed: WatchlistTriggerCondition[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return null;
    }
    const record = item as Record<string, unknown>;
    const type = record['type'];
    if (typeof type !== 'string' || type.length === 0) {
      return null;
    }
    const minVintage = record['minVintage'];
    if (minVintage !== undefined && (!Number.isFinite(minVintage) || typeof minVintage !== 'number')) {
      return null;
    }
    parsed.push({
      type,
      ...(typeof minVintage === 'number' ? { minVintage } : {}),
    });
  }
  return parsed;
}

function rowToWatchlistEntry(row: WatchlistRow): WatchlistEntry {
  const triggerConditions = parseWatchlistTriggers(row.trigger_conditions);
  if (triggerConditions === null) {
    throw new Error(`Invalid watchlist trigger_conditions for watchlist ${row.watchlist_id}`);
  }

  return {
    id: row.watchlist_id,
    userId: row.user_id,
    entityId: row.entity_id,
    triggerConditions,
    callbackUrl: row.callback_url,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

const pgWatchlistStoreLog = bootstrapLogger.child({ component: 'PgWatchlistStore' });

function mapRowsSafe(rows: WatchlistRow[]): WatchlistEntry[] {
  const out: WatchlistEntry[] = [];
  for (const row of rows) {
    try {
      out.push(rowToWatchlistEntry(row));
    } catch (err) {
      pgWatchlistStoreLog.warn(
        { err, watchlistId: row.watchlist_id },
        'Skipping watchlist row with invalid trigger_conditions',
      );
    }
  }
  return out;
}

function rowToDeliveryLogEntry(row: WatchlistDeliveryLogRow): WatchlistDeliveryLogEntry {
  return {
    id: row.delivery_log_id,
    watchlistId: row.watchlist_id,
    attempt: row.attempt,
    statusCode: row.status_code,
    errorMessage: row.error_message,
    deliveredAt: row.delivered_at,
  };
}

export class PgWatchlistStore implements WatchlistStoragePort, TransactionalWatchlistStore {
  private readonly executor: QueryExecutor;
  private readonly pool: Pool | null;

  constructor(poolOrClient: Pool | PoolClient) {
    this.executor = poolOrClient;
    this.pool = 'connect' in poolOrClient && typeof (poolOrClient as Pool).connect === 'function'
      ? (poolOrClient as Pool)
      : null;
  }

  async save(entry: WatchlistEntry): Promise<void> {
    await this.executor.query(
      `INSERT INTO watchlists (
        watchlist_id,
        user_id,
        entity_id,
        trigger_conditions,
        callback_url,
        created_at,
        expires_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
      ON CONFLICT (user_id, entity_id, callback_url) DO NOTHING`,
      [
        entry.id,
        entry.userId,
        entry.entityId,
        JSON.stringify(entry.triggerConditions),
        entry.callbackUrl,
        entry.createdAt,
        entry.expiresAt,
      ],
    );
  }

  async findById(id: string): Promise<WatchlistEntry | null> {
    const result = await this.executor.query<WatchlistRow>(
      `SELECT * FROM watchlists WHERE watchlist_id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    try {
      return rowToWatchlistEntry(row);
    } catch (err) {
      pgWatchlistStoreLog.warn({ err, id }, 'watchlist.findById: corrupt row skipped');
      return null;
    }
  }

  async findByUserId(userId: string): Promise<readonly WatchlistEntry[]> {
    const result = await this.executor.query<WatchlistRow>(
      `SELECT * FROM watchlists WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1000`,
      [userId],
    );
    return mapRowsSafe(result.rows);
  }

  async findByEntityId(entityId: string): Promise<readonly WatchlistEntry[]> {
    const result = await this.executor.query<WatchlistRow>(
      `SELECT * FROM watchlists WHERE entity_id = $1 ORDER BY created_at ASC LIMIT 1000`,
      [entityId],
    );
    return mapRowsSafe(result.rows);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.executor.query<{ watchlist_id: string }>(
      `DELETE FROM watchlists WHERE watchlist_id = $1 RETURNING watchlist_id`,
      [id],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async listByWatchlistId(
    watchlistId: string,
  ): Promise<readonly WatchlistDeliveryLogEntry[]> {
    const result = await this.executor.query<WatchlistDeliveryLogRow>(
      `SELECT * FROM watchlist_delivery_logs
       WHERE watchlist_id = $1
       ORDER BY delivered_at DESC, attempt DESC
       LIMIT 1000`,
      [watchlistId],
    );
    return result.rows.map(rowToDeliveryLogEntry);
  }

  async append(log: WatchlistDeliveryLogEntry): Promise<void> {
    await this.executor.query(
      `INSERT INTO watchlist_delivery_logs (
        delivery_log_id,
        watchlist_id,
        attempt,
        status_code,
        error_message,
        delivered_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (delivery_log_id) DO NOTHING`,
      [
        log.id,
        log.watchlistId,
        log.attempt,
        log.statusCode,
        log.errorMessage,
        log.deliveredAt,
      ],
    );
  }

  async clear(): Promise<void> {
    await this.executor.query('TRUNCATE TABLE watchlist_delivery_logs, watchlists RESTART IDENTITY');
  }

  async findByIdForUpdate(id: string): Promise<WatchlistEntry | null> {
    const result = await this.executor.query<WatchlistRow>(
      `SELECT * FROM watchlists WHERE watchlist_id = $1 FOR UPDATE`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    try {
      return rowToWatchlistEntry(row);
    } catch (err) {
      pgWatchlistStoreLog.warn({ err, id }, 'watchlist.findByIdForUpdate: corrupt row skipped');
      return null;
    }
  }

  async withTransaction<T>(fn: (tx: TransactionalWatchlistStore) => Promise<T>): Promise<T> {
    if (this.pool === null) {
      throw new Error('withTransaction requires a Pool, not a PoolClient (already in a transaction)');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txStore = new PgWatchlistStore(client);
      const result = await fn(txStore);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      let rollbackError: unknown;
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        rollbackError = rbErr;
      }
      if (rollbackError !== undefined) {
        throw new TransactionRollbackFailedError(err, rollbackError);
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

class TransactionRollbackFailedError extends Error {
  readonly originalError: unknown;
  readonly rollbackError: unknown;

  constructor(originalError: unknown, rollbackError: unknown) {
    const origMsg = originalError instanceof Error ? originalError.message : String(originalError);
    const rbMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    super(
      `Transaction rollback FAILED after business error. `
      + `Original: ${origMsg}. Rollback error: ${rbMsg}. `
      + 'Transaction state is unknown — check PG state and connection pool health immediately.',
    );
    this.name = 'TransactionRollbackFailedError';
    this.originalError = originalError;
    this.rollbackError = rollbackError;
  }
}
