import type { Pool, PoolClient } from 'pg';
import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
} from '../../domain/watchlist/model/watchlist-entry.js';
import { parseWatchlistTriggers } from '../../domain/watchlist/model/watchlist-entry.js';
import type {
  WatchlistStoragePort,
  TransactionalWatchlistStore,
} from '../../domain/watchlist/port/watchlist-repository.port.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

/** Minimal query interface shared by Pool and PoolClient. */
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

/**
 * Maps an array of DB rows to WatchlistEntry objects with per-record error isolation.
 * A single row with corrupt trigger_conditions will not fail the entire query —
 * the bad row is skipped and a warning is emitted, so callers receive all valid rows.
 */
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
    // Only a Pool can create transactions; PoolClient is already inside one.
    // Pool has `connect()` method; PoolClient does not.
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
    // Hard server-side cap of 1000 entries per user to prevent unbounded
    // memory growth from accidental or malicious mass-creation. The route
    // layer applies the caller's offset/limit on top of this set.
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
    // Hard server-side cap of 1000 delivery records to bound memory.
    // Older history must be queried via dedicated archival paths.
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
      // Wave 3 (fail-loud): previously the rollback rejection was swallowed
      // with `.catch(() => {})`. Now we capture it and, if rollback fails
      // (e.g. connection dropped mid-transaction), we throw a TransactionRollbackFailedError
      // that wraps BOTH the original error and the rollback error. Operators
      // see the compound failure instead of only the original error while the
      // transaction silently stays in an unknown state.
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

/**
 * Wave 3 (fail-loud): thrown when a transactional rollback itself fails.
 * The original business error and the rollback error are both preserved —
 * operators cannot diagnose "connection dropped mid-commit" without seeing
 * both.
 */
export class TransactionRollbackFailedError extends Error {
  readonly originalError: unknown;
  readonly rollbackError: unknown;

  constructor(originalError: unknown, rollbackError: unknown) {
    const origMsg = originalError instanceof Error ? originalError.message : String(originalError);
    const rbMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    super(
      `Transaction rollback FAILED after business error. ` +
      `Original: ${origMsg}. Rollback error: ${rbMsg}. ` +
      'Transaction state is unknown — check PG state and connection pool health immediately.',
    );
    this.name = 'TransactionRollbackFailedError';
    this.originalError = originalError;
    this.rollbackError = rollbackError;
  }
}
