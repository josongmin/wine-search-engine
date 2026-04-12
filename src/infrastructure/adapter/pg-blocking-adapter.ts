import type { Pool } from 'pg';
import type { BlockingPort } from '../../domain/resolver/port/blocking.port.js';
import { createCanonicalEntityId, type EntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';

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

export class PgBlockingAdapter implements BlockingPort {
  private static readonly DEFAULT_LIMIT = 50;

  constructor(private readonly pool: Pool) {}

  async block(
    query: string,
    normalizedQuery: string,
    limit: number = PgBlockingAdapter.DEFAULT_LIMIT,
  ): Promise<readonly EntityId[]> {
    // Strategy 1: exact normalized_value match (highest recall, fastest)
    // Strategy 2: prefix match on normalized_value
    // Strategy 3: ILIKE fallback on surface_form using the raw query
    // All three unioned, deduplicated, ordered by priority.
    let result: { rows: CandidateRow[] };
    try {
      result = await this.pool.query<CandidateRow>(
        `WITH exact_match AS (
          SELECT entity_id, 1 AS priority
          FROM aliases
          WHERE normalized_value = $1
            AND is_suppressed = FALSE
        ),
        prefix_match AS (
          SELECT entity_id, 2 AS priority
          FROM aliases
          WHERE normalized_value LIKE $2
            AND is_suppressed = FALSE
            AND entity_id NOT IN (SELECT entity_id FROM exact_match)
        ),
        ilike_match AS (
          SELECT entity_id, 3 AS priority
          FROM aliases
          WHERE (surface_form ILIKE $3 OR normalized_value ILIKE $3)
            AND is_suppressed = FALSE
            AND entity_id NOT IN (SELECT entity_id FROM exact_match)
            AND entity_id NOT IN (SELECT entity_id FROM prefix_match)
        ),
        all_candidates AS (
          SELECT entity_id, priority FROM exact_match
          UNION ALL
          SELECT entity_id, priority FROM prefix_match
          UNION ALL
          SELECT entity_id, priority FROM ilike_match
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
          normalizedQuery,
          `${escapeLikePattern(normalizedQuery)}%`,
          `%${escapeLikePattern(query)}%`,
          limit,
        ],
      );
    } catch (err: unknown) {
      const code = readPgSqlState(err);
      if (code !== '42P01') {
        throw err;
      }
      bootstrapLogger.info(
        '[PgBlockingAdapter] aliases table does not exist yet — blocker alias lookup disabled for this request',
      );
      return [];
    }

    return result.rows.map((row) => createCanonicalEntityId(row.entity_id));
  }
}
