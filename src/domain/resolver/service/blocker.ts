import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import type { EntityId } from '../../shared/types/index.js';
import type { BlockingPort } from '../port/blocking.port.js';

const blockerLog = bootstrapLogger.child({ component: 'Blocker' });

/** Default maximum number of candidates returned by the blocker. */
const DEFAULT_BLOCKING_LIMIT = 100;

/**
 * Wraps the {@link BlockingPort} with metrics tracking and validation,
 * per RFC-006 §3.3.
 *
 * The blocker is the first stage of the resolution pipeline. Its sole
 * responsibility is high-recall candidate retrieval — the recall target
 * is >= 0.99.
 */
export class Blocker {
  constructor(private readonly blockingPort: BlockingPort) {}

  /**
   * Retrieves candidate entity IDs that pass the blocking filter.
   *
   * @param query - The original user query string.
   * @param normalizedQuery - Lowercased, accent-stripped, whitespace-collapsed form.
   * @param options - Optional configuration.
   * @param options.limit - Maximum number of candidates to return.
   * @returns Candidate entity IDs ordered by blocking score descending.
   */
  async block(
    query: string,
    normalizedQuery: string,
    options?: { readonly limit?: number },
  ): Promise<readonly EntityId[]> {
    const limit = options?.limit ?? DEFAULT_BLOCKING_LIMIT;
    const startTime = Date.now();

    const candidates = await this.blockingPort.block(query, normalizedQuery, limit);

    const elapsedMs = Date.now() - startTime;

    // Track blocking metrics for recall monitoring.
    // In production these would be emitted to a metrics backend;
    // here we capture them as structured data for observability.
    this.recordBlockingMetrics(candidates.length, elapsedMs);

    return candidates;
  }

  /**
   * Records blocking-stage metrics for recall monitoring.
   * In a production deployment this would emit to a metrics system.
   *
   * Logs a warning when blocking returns zero candidates — this is a
   * strong signal of a recall failure or a stub/unimplemented adapter.
   */
  private recordBlockingMetrics(candidateCount: number, elapsedMs: number): void {
    if (candidateCount === 0) {
      // Zero-candidate blocking is almost always a recall problem: either
      // the blocking adapter is a stub, the index is empty, or the query
      // failed to match anything. Downstream resolution will produce no
      // results. Emit a structured warning so operators can triage.
      blockerLog.warn(
        {
          event: 'blocking_zero_candidates',
          elapsedMs,
        },
        'blocking returned 0 candidates; resolver will produce no results (check adapter and index)',
      );
    }
  }
}
