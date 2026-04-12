import type { Pool } from 'pg';
import type {
  FeedbackStore,
  FeedbackFilter,
  AggregatedFeedbackStats,
} from '../../domain/learning/port/feedback-store.port.js';
import type { FeedbackSignal, FeedbackType } from '../../domain/learning/model/feedback-signal.js';
import type { CanonicalEntityId, QueryClass } from '../../domain/shared/types/index.js';
import { createCanonicalEntityId, isCorruptedSnapshot } from '../../domain/shared/types/index.js';
import { isQueryClass } from '../../domain/shared/types/query-class.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { parseDecisionSnapshotJsonb } from './jsonb-schemas.js';

const feedbackLog = bootstrapLogger.child({ component: 'PgFeedbackStore' });

function toFeedbackType(value: string): FeedbackType {
  if (
    value === 'click' ||
    value === 'purchase' ||
    value === 'explicit_feedback' ||
    value === 'clarification_resolution' ||
    value === 'session_success'
  ) return value;
  throw new Error(`PgFeedbackStore: unknown feedback signal_type "${value}" — schema drift or corrupted row`);
}

function toQueryClass(value: string): QueryClass {
  if (isQueryClass(value)) return value;
  throw new Error(`PgFeedbackStore: unknown query_class "${value}" — schema drift or corrupted row`);
}

interface FeedbackRow {
  signal_id: string;
  signal_type: string;
  query: string;
  query_class: string;
  entity_id: string;
  is_positive: boolean;
  session_id: string;
  decision_snapshot: unknown;
  created_at: Date;
}

function rowToSignal(row: FeedbackRow): FeedbackSignal {
  return {
    signalId: row.signal_id,
    type: toFeedbackType(row.signal_type),
    query: row.query,
    queryClass: toQueryClass(row.query_class),
    entityId: createCanonicalEntityId(row.entity_id),
    isPositive: row.is_positive,
    timestamp: row.created_at,
    sessionId: row.session_id,
    decisionSnapshot: parseDecisionSnapshotJsonb(row.decision_snapshot, 'PgFeedbackStore'),
  };
}

export class PgFeedbackStore implements FeedbackStore {
  constructor(private readonly pool: Pool) {}

  async saveFeedback(signal: FeedbackSignal): Promise<void> {
    if (isCorruptedSnapshot(signal.decisionSnapshot)) {
      feedbackLog.warn(
        { signalId: signal.signalId },
        'PgFeedbackStore: refusing to persist feedback with corrupted decision snapshot',
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO feedback_signals (
        signal_id, signal_type, query, query_class,
        entity_id, is_positive, session_id, decision_snapshot, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (signal_id) DO NOTHING`,
      [
        signal.signalId,
        signal.type,
        signal.query,
        signal.queryClass,
        signal.entityId,
        signal.isPositive,
        signal.sessionId,
        JSON.stringify(signal.decisionSnapshot),
        signal.timestamp,
      ],
    );
  }

  async getFeedback(filter?: FeedbackFilter): Promise<readonly FeedbackSignal[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter?.since != null) {
      conditions.push(`created_at >= $${idx++}`);
      params.push(filter.since);
    }
    if (filter?.queryClass != null) {
      conditions.push(`query_class = $${idx++}`);
      params.push(filter.queryClass);
    }
    if (filter?.entityId != null) {
      conditions.push(`entity_id = $${idx++}`);
      params.push(filter.entityId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<FeedbackRow>(
      `SELECT * FROM feedback_signals ${where} ORDER BY created_at ASC`,
      params,
    );
    return result.rows.map(rowToSignal);
  }

  async pruneExpiredFeedback(olderThan: Date, signalTypes?: readonly FeedbackType[]): Promise<number> {
    const hasTypes = signalTypes !== undefined && signalTypes.length > 0;
    const typeClause = hasTypes ? `AND signal_type = ANY($2::text[])` : '';
    const params: unknown[] = hasTypes ? [olderThan, signalTypes] : [olderThan];
    const result = await this.pool.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM feedback_signals
         WHERE created_at < $1 ${typeClause}
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM deleted`,
      params,
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  async getAggregatedStats(entityId: CanonicalEntityId): Promise<AggregatedFeedbackStats> {
    const result = await this.pool.query<{
      clicks: string;
      purchases: string;
      session_successes: string;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE signal_type = 'click' AND is_positive = TRUE) AS clicks,
        COUNT(*) FILTER (WHERE signal_type = 'purchase' AND is_positive = TRUE) AS purchases,
        COUNT(*) FILTER (WHERE signal_type = 'session_success' AND is_positive = TRUE) AS session_successes
       FROM feedback_signals
       WHERE entity_id = $1`,
      [entityId],
    );

    const row = result.rows[0];
    return {
      clicks: parseInt(row?.clicks ?? '0', 10),
      purchases: parseInt(row?.purchases ?? '0', 10),
      sessionSuccesses: parseInt(row?.session_successes ?? '0', 10),
    };
  }
}
