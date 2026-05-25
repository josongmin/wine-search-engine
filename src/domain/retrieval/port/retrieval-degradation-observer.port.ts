/**
 * Port: retrieval degradation observer.
 *
 * Domain contract for tracking silent fallbacks across the hybrid retrieval
 * pipeline (sparse, dense, anchor, learned sparse channels).  Infrastructure
 * implementations collect metrics; the domain only depends on this interface.
 */

import type { RetrievalChannel } from '../model/retrieval-channel.js';

export interface RetrievalDegradationSignal {
  readonly component: RetrievalChannel | 'embedding_combiner';
  readonly severity: 'warning' | 'error';
  readonly reason: string;
  readonly fallbackApplied: string;
}

/**
 * Structured degradation categories that the retrieval critic is allowed to
 * consume directly. These are intentionally narrower than the free-form
 * human-readable `reason` strings surfaced to metrics / logs.
 */
export type RetrievalDegradationCode = 'sparse_pool' | 'no_matches';

export interface RetrievalDegradationMetrics {
  readonly totalRetrievals: number;
  readonly degradations: Readonly<Record<string, number>>; // component → count
  readonly degradationRate: number; // total degradation events / totalRetrievals
  readonly alerts: readonly string[];
}

export interface RetrievalDegradationObserver {
  onRetrievalStarted(): void;
  onDegradation(signal: RetrievalDegradationSignal): void;
  getMetrics(): RetrievalDegradationMetrics;
}
