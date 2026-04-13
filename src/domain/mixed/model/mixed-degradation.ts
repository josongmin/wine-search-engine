import type { FunnelMetrics } from '../../ranking/model/ranking-stage.js';
import type { RankingDegradationSignal } from '../../ranking/model/ranking-runtime-signal.js';

export const MIXED_FALLBACK_REASONS = [
  'mixed_anchor_resolution_failed',
  'mixed_similar_retrieval_unavailable',
  'mixed_similar_retrieval_fallback',
  'mixed_ranker_unavailable',
  'mixed_constraint_overlay_failed',
] as const;

export type MixedFallbackReason = typeof MIXED_FALLBACK_REASONS[number];

export class MixedRouteDegradationError extends Error {
  constructor(
    readonly reason: MixedFallbackReason,
    message: string,
  ) {
    super(message);
    this.name = 'MixedRouteDegradationError';
  }
}

export interface MixedDegradationState {
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly fallbackReason?: MixedFallbackReason | undefined;
  readonly funnelMetrics?: FunnelMetrics | undefined;
}
