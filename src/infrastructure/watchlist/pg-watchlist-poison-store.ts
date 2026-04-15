/**
 * Wave 3 / H12 — Postgres-backed watchlist DLQ.
 *
 * Durable implementation of WatchlistPoisonStore. Events written here
 * survive process restarts so ops can investigate repeated handler
 * failures without relying on ephemeral in-memory state.
 *
 * Write path: `RedisWatchlistSubscriber.handleEvent()` calls `push()` after
 * all retries have been exhausted.
 *
 * Failure contract: `push()` throws on SQL failure. The subscriber's
 * `handleEvent` catches the throw and increments a distinct
 * `cache_write_failure` counter tagged `watchlist_dlq.push`, so both the
 * poisoned event AND the DLQ-write failure are visible in observability.
 */
import type { Pool } from 'pg';
import type {
  WatchlistPoisonStore,
  WatchlistPoisonRecord,
} from './redis-watchlist-subscriber.js';

export class PgWatchlistPoisonStore implements WatchlistPoisonStore {
  constructor(private readonly pool: Pool) {}

  async push(record: WatchlistPoisonRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO watchlist_poison_dlq
         (entity_id, raw_payload, attempts, last_error, first_seen_at, poisoned_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.entityId,
        record.rawPayload,
        record.attempts,
        record.lastError,
        record.firstSeenAt,
        record.poisonedAt,
      ],
    );
  }

  async size(): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM watchlist_poison_dlq`,
    );
    const raw = res.rows[0]?.count ?? '0';
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
