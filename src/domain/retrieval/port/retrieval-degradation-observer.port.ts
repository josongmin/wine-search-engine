/**
 * Port: retrieval degradation observer.
 *
 * Domain contract for tracking silent fallbacks across the hybrid retrieval
 * pipeline (sparse, dense, anchor, learned sparse channels).  Infrastructure
 * implementations collect metrics; the domain only depends on this interface.
 */

export interface RetrievalDegradationSignal {
  readonly component:
    | 'sparse_bm25'
    | 'learned_sparse'
    | 'dense_semantic'
    | 'anchor_similarity'
    | 'embedding_combiner'
    | 'relative_filter';
  readonly severity: 'warning' | 'error';
  readonly reason: string;
  readonly fallbackApplied: string;
}

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
