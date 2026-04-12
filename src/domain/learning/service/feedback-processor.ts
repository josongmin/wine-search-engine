import type { CanonicalEntityId } from '../../shared/types/index.js';
import { createCanonicalEntityId } from '../../shared/types/index.js';
import type { FeedbackSignal } from '../model/feedback-signal.js';
import type { FeedbackStore } from '../port/feedback-store.port.js';
import { MS_PER_DAY } from '../../shared/utils/time-units.js';

/** Default rolling window when `since` omitted (unbounded table guard). */
const DEFAULT_FEEDBACK_AGGREGATION_WINDOW_DAYS = 90;

/**
 * Aggregated feedback for a single query-entity pair.
 */
export interface QueryEntityAggregation {
  /** The query string. */
  readonly query: string;

  /** The entity that received the feedback. */
  readonly entityId: CanonicalEntityId;

  /** Total positive signals. */
  readonly positiveCount: number;

  /** Total negative signals. */
  readonly negativeCount: number;

  /** Distinct session count. */
  readonly sessionCount: number;

  /** Click count. */
  readonly clicks: number;

  /** Purchase count. */
  readonly purchases: number;

  /** Session-success count. */
  readonly sessionSuccesses: number;

  /** First feedback timestamp. */
  readonly firstSeen: Date;

  /** Most recent feedback timestamp. */
  readonly lastSeen: Date;
}

/**
 * A detected quality issue in the feedback stream.
 */
export interface FeedbackQualityIssue {
  /** Type of issue detected. */
  readonly type: 'click_spam' | 'session_bounce' | 'contradictory_signals';

  /** Description of the issue. */
  readonly description: string;

  /** The affected entity, if applicable. */
  readonly entityId?: CanonicalEntityId;

  /** The affected session, if applicable. */
  readonly sessionId?: string;

  /** Number of suspicious signals. */
  readonly signalCount: number;
}

/**
 * Processes raw feedback signals into aggregated, quality-checked data,
 * per RFC-010 §3.
 *
 * Responsibilities:
 * - Aggregates click/purchase/session signals per query-entity pair.
 * - Identifies strong patterns (repeated queries resolving to the same entity).
 * - Detects feedback quality issues (click spam, session bounces).
 */
export class FeedbackProcessor {
  /** Maximum clicks per session before flagging as spam. */
  private static readonly CLICK_SPAM_THRESHOLD = 20;

  /** Minimum session duration (ms) — sessions shorter are bounces. */
  private static readonly BOUNCE_THRESHOLD_MS = 2000;

  constructor(private readonly feedbackStore: FeedbackStore) {}

  /**
   * Aggregates feedback signals into per-query-entity statistics.
   *
   * @param since - Only process signals since this timestamp.
   * @returns Aggregated statistics per query-entity pair.
   */
  async aggregateByQueryEntity(since?: Date): Promise<readonly QueryEntityAggregation[]> {
    // Default to 90 days when no window is specified to prevent unbounded
    // memory growth from loading the entire feedback table (production can
    // have millions of rows). Callers that need broader windows must
    // explicitly pass a Date.
    const effectiveSince =
      since
      ?? new Date(
        Date.now()
        - DEFAULT_FEEDBACK_AGGREGATION_WINDOW_DAYS * MS_PER_DAY,
      );
    const signals = await this.feedbackStore.getFeedback({ since: effectiveSince });

    return this.computeAggregations(signals);
  }

  /**
   * Identifies strong patterns: query-entity pairs where the same query
   * consistently resolves to the same entity with positive outcomes.
   *
   * @param aggregations - Pre-computed aggregations.
   * @param minSessions - Minimum distinct sessions (default: 5).
   * @param minPositiveRate - Minimum positive signal rate (default: 0.7).
   * @returns Strong patterns suitable for alias proposal consideration.
   */
  identifyStrongPatterns(
    aggregations: readonly QueryEntityAggregation[],
    minSessions: number = 5,
    minPositiveRate: number = 0.7,
  ): readonly QueryEntityAggregation[] {
    return aggregations.filter((agg) => {
      const total = agg.positiveCount + agg.negativeCount;
      if (total === 0) return false;

      const positiveRate = agg.positiveCount / total;
      return agg.sessionCount >= minSessions && positiveRate >= minPositiveRate;
    });
  }

  /**
   * Detects quality issues in the feedback stream.
   *
   * Checks for:
   * - Click spam: too many clicks from a single session on an entity.
   * - Session bounce: very short sessions with immediate negative signals.
   * - Contradictory signals: same session sending both positive and negative.
   *
   * @param since - Only check signals since this timestamp.
   * @returns Detected quality issues.
   */
  async detectQualityIssues(since?: Date): Promise<readonly FeedbackQualityIssue[]> {
    const signals = await this.feedbackStore.getFeedback(
      since ? { since } : undefined,
    );

    const issues: FeedbackQualityIssue[] = [];

    // Check for click spam per session-entity.
    // Use \u0000 (null byte) as separator so sessionIds containing colons
    // (composite IDs like `tenant:session`, UUIDs in some formats) don't
    // collide. Colons are valid in many ID schemes; \u0000 is not.
    const SEP = '\u0000';
    const sessionEntityClicks = new Map<string, FeedbackSignal[]>();
    for (const signal of signals) {
      if (signal.type !== 'click') continue;
      const key = `${signal.sessionId}${SEP}${String(signal.entityId)}`;
      const existing = sessionEntityClicks.get(key);
      if (existing) {
        existing.push(signal);
      } else {
        sessionEntityClicks.set(key, [signal]);
      }
    }

    for (const [key, clicks] of sessionEntityClicks) {
      if (clicks.length >= FeedbackProcessor.CLICK_SPAM_THRESHOLD) {
        const sepIdx = key.indexOf(SEP);
        const sessionId = sepIdx >= 0 ? key.slice(0, sepIdx) : key;
        const entityId = sepIdx >= 0 ? key.slice(sepIdx + 1) : '';
        issues.push({
          type: 'click_spam',
          description: `Session ${sessionId} generated ${clicks.length} clicks on entity ${entityId}`,
          entityId: createCanonicalEntityId(entityId),
          sessionId,
          signalCount: clicks.length,
        });
      }
    }

    // Check for session bounces
    const sessionSignals = new Map<string, FeedbackSignal[]>();
    for (const signal of signals) {
      const existing = sessionSignals.get(signal.sessionId);
      if (existing) {
        existing.push(signal);
      } else {
        sessionSignals.set(signal.sessionId, [signal]);
      }
    }

    for (const [sessionId, sessionSigs] of sessionSignals) {
      if (sessionSigs.length < 2) continue;

      const sorted = [...sessionSigs].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
      );
      const duration =
        sorted[sorted.length - 1]!.timestamp.getTime() -
        sorted[0]!.timestamp.getTime();

      if (
        duration < FeedbackProcessor.BOUNCE_THRESHOLD_MS &&
        sorted.some((s) => !s.isPositive)
      ) {
        issues.push({
          type: 'session_bounce',
          description: `Session ${sessionId} lasted ${duration}ms with negative signals`,
          sessionId,
          signalCount: sorted.length,
        });
      }

      // Check for contradictory signals within same session-entity
      const entitySignals = new Map<string, { positive: number; negative: number }>();
      for (const sig of sessionSigs) {
        const eid = String(sig.entityId);
        const existing = entitySignals.get(eid) ?? { positive: 0, negative: 0 };
        if (sig.isPositive) {
          existing.positive++;
        } else {
          existing.negative++;
        }
        entitySignals.set(eid, existing);
      }

      for (const [eid, counts] of entitySignals) {
        if (counts.positive > 0 && counts.negative > 0) {
          issues.push({
            type: 'contradictory_signals',
            description: `Session ${sessionId} sent ${counts.positive} positive and ${counts.negative} negative signals for entity ${eid}`,
            entityId: createCanonicalEntityId(eid),
            sessionId,
            signalCount: counts.positive + counts.negative,
          });
        }
      }
    }

    return issues;
  }

  /**
   * Computes aggregations from raw signals.
   */
  private computeAggregations(
    signals: readonly FeedbackSignal[],
  ): readonly QueryEntityAggregation[] {
    const map = new Map<
      string,
      {
        query: string;
        entityId: CanonicalEntityId;
        positiveCount: number;
        negativeCount: number;
        sessions: Set<string>;
        clicks: number;
        purchases: number;
        sessionSuccesses: number;
        firstSeen: Date;
        lastSeen: Date;
      }
    >();

    for (const signal of signals) {
      const key = `${signal.query}\0${signal.entityId}`;
      const existing = map.get(key);

      if (existing) {
        if (signal.isPositive) existing.positiveCount++;
        else existing.negativeCount++;
        existing.sessions.add(signal.sessionId);
        if (signal.type === 'click') existing.clicks++;
        if (signal.type === 'purchase') existing.purchases++;
        if (signal.type === 'session_success') existing.sessionSuccesses++;
        if (signal.timestamp < existing.firstSeen) existing.firstSeen = signal.timestamp;
        if (signal.timestamp > existing.lastSeen) existing.lastSeen = signal.timestamp;
      } else {
        map.set(key, {
          query: signal.query,
          entityId: signal.entityId,
          positiveCount: signal.isPositive ? 1 : 0,
          negativeCount: signal.isPositive ? 0 : 1,
          sessions: new Set([signal.sessionId]),
          clicks: signal.type === 'click' ? 1 : 0,
          purchases: signal.type === 'purchase' ? 1 : 0,
          sessionSuccesses: signal.type === 'session_success' ? 1 : 0,
          firstSeen: signal.timestamp,
          lastSeen: signal.timestamp,
        });
      }
    }

    return Array.from(map.values()).map((entry) => ({
      query: entry.query,
      entityId: entry.entityId,
      positiveCount: entry.positiveCount,
      negativeCount: entry.negativeCount,
      sessionCount: entry.sessions.size,
      clicks: entry.clicks,
      purchases: entry.purchases,
      sessionSuccesses: entry.sessionSuccesses,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
    }));
  }
}
