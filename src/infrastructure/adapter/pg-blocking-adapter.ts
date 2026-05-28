import type { Pool } from 'pg';
import type { BlockingPort } from '../../domain/resolver/port/blocking.port.js';
import { createCanonicalEntityId, type EntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';
import {
  isActiveSnapshotSubstrateBootstrapAllowed,
  resolveActiveSnapshot,
} from '../db/active-snapshot-resolver.js';
import { globalSilentSkipCounter } from '../../domain/observability/silent-skip-counters.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';

interface CandidateRow {
  entity_id: string;
}

/**
 * Escapes PostgreSQL LIKE pattern metacharacters (`%`, `_`, `\`).
 * Exported for property-based regression tests.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, '\\$&');
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function buildBlockingLookupVariants(query: string, normalizedQuery: string): readonly string[] {
  const rawViews = buildNormalizedQueryViews(query);
  const normalizedViews = buildNormalizedQueryViews(normalizedQuery);
  return uniqueNonEmpty([
    normalizedQuery,
    ...rawViews.lookupVariants,
    ...normalizedViews.lookupVariants,
  ]);
}

export class PgBlockingAdapter implements BlockingPort {
  private static readonly DEFAULT_LIMIT = 50;

  /**
   * Minimum `pg_trgm.similarity()` score for a row to qualify in the fuzzy
   * trigram phase (phase 4). The pg_trgm extension's similarity() returns a
   * Jaccard-style score on shared trigrams. 0.4 is conservative relative to
   * PG's default `pg_trgm.similarity_threshold` (0.3) — empirically it
   * recalls real typos / morphological variants (Sasicaia↔Sassicaia,
   * 샤또↔샤토) while excluding incidental short-token coincidences.
   *
   * @see migrations/001_initial_schema.sql — pg_trgm extension + GIN indexes.
   */
  private static readonly TRIGRAM_FUZZY_THRESHOLD = 0.4;

  /**
   * Cap on rows returned from the fuzzy trigram phase. Bounds tail-latency
   * on fat alias tables where a frequent token would otherwise return many
   * low-similarity rows. The outer LIMIT then truncates the unioned set if
   * needed.
   */
  private static readonly TRIGRAM_FUZZY_LIMIT = 50;

  constructor(
    private readonly pool: Pool,
    private readonly snapshotIdOverride?: string,
  ) {}

  async block(
    query: string,
    normalizedQuery: string,
    limit: number = PgBlockingAdapter.DEFAULT_LIMIT,
  ): Promise<readonly EntityId[]> {
    // Strategy 1: exact normalized_value match (highest recall, fastest)
    // Strategy 2: prefix match on normalized_value
    // Strategy 3: ILIKE substring fallback on surface_form / normalized_value
    // Strategy 4: pg_trgm fuzzy match on normalized_value — catches typos
    //             and morphological variants the substring matches miss
    //             (e.g. Sasicaia → Sassicaia, 샤또 → 샤토).
    // All four unioned, deduplicated, ordered by priority.
    let activeSnapshotId = this.snapshotIdOverride;
    if (activeSnapshotId === undefined) {
      try {
        ({ activeSnapshotId } = await resolveActiveSnapshot(this.pool));
      } catch (err: unknown) {
        if (readPgSqlState(err) === '42P01') {
          if (!isActiveSnapshotSubstrateBootstrapAllowed()) {
            throw err;
          }
          // Snapshot pointer table missing = fresh DB, pre-publish. This is
          // distinct from "aliases table exists but query failed" (counted
          // below) — operators need the distinction to decide between
          // "publish a snapshot" vs "investigate PG outage".
          globalSilentSkipCounter.increment('blocker_disabled_snapshot_pointer_missing', {
            surface: 'PgBlockingAdapter',
          });
          bootstrapLogger.info(
            '[PgBlockingAdapter] active_search_snapshot table missing — blocker alias lookup disabled for this request',
          );
          return [];
        }
        globalSilentSkipCounter.increment('blocker_snapshot_resolve_failure', {
          surface: 'PgBlockingAdapter',
          errorClass: err instanceof Error ? err.constructor.name : 'unknown',
        });
        throw err;
      }
    }
    const lookupVariants = buildBlockingLookupVariants(query, normalizedQuery);
    const prefixPatterns = lookupVariants.map((variant) => `${escapeLikePattern(variant)}%`);
    let result: { rows: CandidateRow[] };
    try {
      result = await this.pool.query<CandidateRow>(
        `WITH exact_match AS (
          SELECT entity_id, 1 AS priority
          FROM aliases
          WHERE normalized_value = ANY($1::text[])
            AND search_snapshot_id = $5
            AND is_suppressed = FALSE
        ),
        prefix_match AS (
          SELECT entity_id, 2 AS priority
          FROM aliases
          WHERE normalized_value LIKE ANY($2::text[])
            AND search_snapshot_id = $5
            AND is_suppressed = FALSE
            AND entity_id NOT IN (SELECT entity_id FROM exact_match)
        ),
        ilike_match AS (
          SELECT entity_id, 3 AS priority
          FROM aliases
          WHERE (surface_form ILIKE $3 OR normalized_value ILIKE $3)
            AND search_snapshot_id = $5
            AND is_suppressed = FALSE
            AND entity_id NOT IN (SELECT entity_id FROM exact_match)
            AND entity_id NOT IN (SELECT entity_id FROM prefix_match)
        ),
        trigram_fuzzy_match AS (
          -- pg_trgm fuzzy: \`% \` operator triggers GIN-index lookup (uses
          -- session pg_trgm.similarity_threshold), explicit similarity() >=
          -- $7 is the deterministic post-filter. ORDER BY similarity DESC
          -- prefers the best matches when LIMIT bites.
          SELECT entity_id, 4 AS priority
          FROM aliases
          WHERE normalized_value % $6
            AND similarity(normalized_value, $6) >= $7
            AND search_snapshot_id = $5
            AND is_suppressed = FALSE
            AND entity_id NOT IN (SELECT entity_id FROM exact_match)
            AND entity_id NOT IN (SELECT entity_id FROM prefix_match)
            AND entity_id NOT IN (SELECT entity_id FROM ilike_match)
          ORDER BY similarity(normalized_value, $6) DESC
          LIMIT $8
        ),
        all_candidates AS (
          SELECT entity_id, priority FROM exact_match
          UNION ALL
          SELECT entity_id, priority FROM prefix_match
          UNION ALL
          SELECT entity_id, priority FROM ilike_match
          UNION ALL
          SELECT entity_id, priority FROM trigram_fuzzy_match
        ),
        ranked AS (
          SELECT entity_id, MIN(priority) AS best_priority
          FROM all_candidates
          GROUP BY entity_id
        )
        SELECT entity_id
        FROM ranked
        ORDER BY best_priority ASC
        LIMIT $4`,
        [
          lookupVariants,
          prefixPatterns,
          `%${escapeLikePattern(query)}%`,
          limit,
          activeSnapshotId,
          normalizedQuery,
          PgBlockingAdapter.TRIGRAM_FUZZY_THRESHOLD,
          PgBlockingAdapter.TRIGRAM_FUZZY_LIMIT,
        ],
      );
    } catch (err: unknown) {
      const code = readPgSqlState(err);
      if (code !== '42P01') {
        globalSilentSkipCounter.increment('blocker_alias_query_failure', {
          surface: 'PgBlockingAdapter',
          errorClass: err instanceof Error ? err.constructor.name : 'unknown',
        });
        throw err;
      }
      if (!isActiveSnapshotSubstrateBootstrapAllowed()) {
        throw err;
      }
      globalSilentSkipCounter.increment('blocker_disabled_aliases_table_missing', {
        surface: 'PgBlockingAdapter',
      });
      bootstrapLogger.info(
        '[PgBlockingAdapter] aliases table does not exist yet — blocker alias lookup disabled for this request',
      );
      return [];
    }

    return result.rows.map((row) => createCanonicalEntityId(row.entity_id));
  }
}
