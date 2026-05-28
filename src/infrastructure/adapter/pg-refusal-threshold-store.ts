/**
 * PgRefusalThresholdStore — PostgreSQL-backed adapter for the per-class
 * refusal-threshold table introduced in migration 021.
 *
 * Reference: P0.2 (AURC-derived per-class refusal threshold). The store
 * implements {@link RefusalThresholdProvider} and layers an in-process TTL
 * cache so that the runtime policy can call `loadThresholds()` on every
 * request without amortising the DB round-trip itself.
 *
 * Hard guarantees (per CLAUDE.md):
 *   - Every NUMERIC/INT/TIMESTAMPTZ column is validated via Zod before any
 *     consumer sees the value; we never `as RefusalThreshold` a raw row.
 *   - Provider unavailability (DB error, empty table) is surfaced via
 *     `{ status: 'unavailable' }` — the adapter NEVER fabricates a hardcoded
 *     fallback threshold.
 *   - The TTL cache is invalidation-free: cache misses trigger a fresh
 *     fetch; failures cause the cached value (if any) to be invalidated so
 *     subsequent calls re-attempt the DB read.
 */

import type { Pool } from 'pg';
import { z } from 'zod';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { RefusalThreshold } from '../../domain/decision/model/refusal-threshold.js';
import type {
  RefusalThresholdLookup,
  RefusalThresholdProvider,
} from '../../domain/decision/port/refusal-threshold-provider.port.js';
import { runAbortablePgQuery } from '../db/abortable-pg-query.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';

const log = bootstrapLogger.child({ component: 'PgRefusalThresholdStore' });

/**
 * Default TTL for the in-process cache. 5 minutes balances staleness against
 * connection churn for nightly-fit cadence; operators can override via
 * `REFUSAL_THRESHOLD_TTL_SECONDS`. Justification: a refit happens at most
 * once per nightly cron; serving 5-minute stale thresholds is far cheaper
 * than re-querying on every request, and the upper bound (1 day) is
 * enforced at the env-schema layer.
 */
const DEFAULT_REFUSAL_THRESHOLD_TTL_SECONDS = 300;

/** Milliseconds per second — named to keep the multiplication self-documenting. */
const MILLIS_PER_SECOND = 1_000;

/**
 * Zod schema for a single row out of `refusal_thresholds`. Numeric columns
 * arrive as JS numbers when the `pg` driver parses them; we still call
 * `.finite()` to reject NaN/Infinity sourced from any external loader path.
 * `.strict()` is intentional — surplus columns are a schema-drift signal
 * the operator should see.
 */
const RefusalThresholdRowSchema = z
  .object({
    query_class: z.string().min(1),
    threshold: z.coerce.number().finite().min(0).max(1),
    target_coverage: z.coerce.number().finite().gt(0).max(1),
    risk_at_coverage: z.coerce.number().finite().min(0).max(1),
    sample_size: z.coerce.number().int().nonnegative(),
    aurc: z.coerce.number().finite().min(0).max(1),
    fitted_at: z.union([z.date(), z.string().min(1)]),
    dataset_hash: z.string().min(1),
  })
  .strict();

type RefusalThresholdRowParsed = z.infer<typeof RefusalThresholdRowSchema>;

function rowToThreshold(row: RefusalThresholdRowParsed): RefusalThreshold {
  const fittedAt = row.fitted_at instanceof Date ? row.fitted_at : new Date(row.fitted_at);
  if (!Number.isFinite(fittedAt.getTime())) {
    throw new Error(
      `[PgRefusalThresholdStore] invalid fitted_at value for query_class="${row.query_class}"`,
    );
  }
  return {
    queryClass: row.query_class,
    threshold: row.threshold,
    targetCoverage: row.target_coverage,
    riskAtCoverage: row.risk_at_coverage,
    sampleSize: row.sample_size,
    aurc: row.aurc,
    fittedAt,
    datasetHash: row.dataset_hash,
  };
}

interface PgRefusalThresholdStoreOptions {
  readonly ttlSeconds?: number;
  /**
   * Injection seam for tests — defaults to `Date.now`. The store does NOT
   * use a wall clock for any control-flow decision other than TTL expiry.
   */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly fetchedAtMs: number;
  readonly lookup: RefusalThresholdLookup;
}

export class PgRefusalThresholdStore implements RefusalThresholdProvider {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: CacheEntry | undefined;

  constructor(
    private readonly pool: Pool,
    options: PgRefusalThresholdStoreOptions = {},
  ) {
    const ttlSeconds = options.ttlSeconds ?? DEFAULT_REFUSAL_THRESHOLD_TTL_SECONDS;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(
        `[PgRefusalThresholdStore] ttlSeconds must be a positive finite number, got ${ttlSeconds}`,
      );
    }
    this.ttlMs = ttlSeconds * MILLIS_PER_SECOND;
    this.now = options.now ?? Date.now;
  }

  async loadThresholds(signal?: AbortSignal): Promise<RefusalThresholdLookup> {
    const cached = this.cache;
    if (cached !== undefined && this.now() - cached.fetchedAtMs < this.ttlMs) {
      return cached.lookup;
    }

    const lookup = await this.fetch(signal);
    // Only cache successful loads; cache invalidation on failure forces the
    // next request to retry the DB so transient outages self-heal once the
    // database recovers, rather than being pinned to an `unavailable` for
    // the full TTL window.
    if (lookup.status === 'ok') {
      this.cache = { fetchedAtMs: this.now(), lookup };
    } else {
      this.cache = undefined;
    }
    return lookup;
  }

  private async fetch(signal?: AbortSignal): Promise<RefusalThresholdLookup> {
    let rows: readonly unknown[];
    try {
      const result = await runAbortablePgQuery(
        this.pool,
        signal,
        `SELECT
           query_class,
           threshold,
           target_coverage,
           risk_at_coverage,
           sample_size,
           aurc,
           fitted_at,
           dataset_hash
         FROM refusal_thresholds`,
      );
      rows = result.rows;
    } catch (err) {
      // A caller-driven abort is NOT a provider outage — re-throw so it reaches
      // the HTTP error path instead of masquerading as `unavailable`, which
      // would silently skip the admission-gate confidence check.
      if (isAbortError(err)) {
        throw err;
      }
      log.warn({ err }, 'failed to load refusal_thresholds — degrading to unavailable');
      return {
        status: 'unavailable',
        reason: err instanceof Error ? err.message : 'pg_query_failed',
      };
    }

    if (rows.length === 0) {
      return { status: 'unavailable', reason: 'refusal_thresholds_table_empty' };
    }

    const thresholds = new Map<string, RefusalThreshold>();
    for (const raw of rows) {
      const parsed = RefusalThresholdRowSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn(
          { issues: parsed.error.issues, row: raw },
          'refusal_thresholds row failed schema validation; skipping',
        );
        continue;
      }
      try {
        const threshold = rowToThreshold(parsed.data);
        thresholds.set(threshold.queryClass, threshold);
      } catch (err) {
        log.warn({ err, row: parsed.data }, 'refusal_thresholds row rejected after parse');
      }
    }

    if (thresholds.size === 0) {
      return {
        status: 'unavailable',
        reason: 'refusal_thresholds_all_rows_invalid',
      };
    }

    return { status: 'ok', thresholds };
  }

  /**
   * Test-only seam: invalidate the in-process cache so subsequent calls go
   * back to the database. Not part of the production surface.
   */
  invalidateForTesting(): void {
    this.cache = undefined;
  }
}
