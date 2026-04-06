import type { Pool } from 'pg';
import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
} from '../../domain/watchlist/model/watchlist-entry.js';
import { parseWatchlistTriggers } from '../../domain/watchlist/model/watchlist-entry.js';
import type { WatchlistStoragePort } from '../../domain/watchlist/port/watchlist-repository.port.js';

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

export class PgWatchlistStore implements WatchlistStoragePort {
  constructor(private readonly pool: Pool) {}

  async save(entry: WatchlistEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO watchlists (
        watchlist_id,
        user_id,
        entity_id,
        trigger_conditions,
        callback_url,
        created_at,
        expires_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
      ON CONFLICT (watchlist_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        entity_id = EXCLUDED.entity_id,
        trigger_conditions = EXCLUDED.trigger_conditions,
        callback_url = EXCLUDED.callback_url,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at`,
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
    const result = await this.pool.query<WatchlistRow>(
      `SELECT * FROM watchlists WHERE watchlist_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row !== undefined ? rowToWatchlistEntry(row) : null;
  }

  async findByUserId(userId: string): Promise<readonly WatchlistEntry[]> {
    const result = await this.pool.query<WatchlistRow>(
      `SELECT * FROM watchlists WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    return result.rows.map(rowToWatchlistEntry);
  }

  async findByEntityId(entityId: string): Promise<readonly WatchlistEntry[]> {
    const result = await this.pool.query<WatchlistRow>(
      `SELECT * FROM watchlists WHERE entity_id = $1 ORDER BY created_at ASC`,
      [entityId],
    );
    return result.rows.map(rowToWatchlistEntry);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query<{ watchlist_id: string }>(
      `DELETE FROM watchlists WHERE watchlist_id = $1 RETURNING watchlist_id`,
      [id],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async listByWatchlistId(
    watchlistId: string,
  ): Promise<readonly WatchlistDeliveryLogEntry[]> {
    const result = await this.pool.query<WatchlistDeliveryLogRow>(
      `SELECT * FROM watchlist_delivery_logs
       WHERE watchlist_id = $1
       ORDER BY delivered_at ASC, attempt ASC`,
      [watchlistId],
    );
    return result.rows.map(rowToDeliveryLogEntry);
  }

  async append(log: WatchlistDeliveryLogEntry): Promise<void> {
    await this.pool.query(
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
    await this.pool.query('TRUNCATE TABLE watchlist_delivery_logs, watchlists RESTART IDENTITY');
  }
}
