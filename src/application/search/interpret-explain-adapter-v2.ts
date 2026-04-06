/**
 * T6.4: Interpret/Explain V2 contract adapter.
 *
 * Transforms planner observability data into an explicit explain contract
 * (InterpretResponseV2). This is NOT a planner internals dump — it surfaces
 * what was detected and which signals/channels were activated, in a form
 * suitable for both human and machine consumers.
 */

import type { QueryObservabilitySlice } from '../../domain/query/model/query-observability-vocab.js';
import type { QueryDecompositionHint, DecompositionStrategy } from '../../domain/query/model/query-decomposition.js';
import type { InterpretResponseV2 } from '../../domain/response/model/result-item-v2.js';

export interface ExplainAdapterV2Input {
  readonly queryId: string;
  readonly queryText: string;
  readonly observabilitySlice: QueryObservabilitySlice;
  readonly decompositionHint?: QueryDecompositionHint | undefined;
  readonly activeChannels: readonly string[];
}

/**
 * Channel name suffixes/substrings that indicate an anchor-conditioned retrieval
 * channel is active. Used to gate inclusion of "anchor_similarity" ranking signal.
 */
const ANCHOR_CHANNEL_MARKERS = ['anchor', 'anchor_similarity', 'dense_anchor', 'compare_anchor'];

function isAnchorChannel(channel: string): boolean {
  return ANCHOR_CHANNEL_MARKERS.some((marker) => channel.includes(marker));
}

/**
 * Derive applied constraint labels from the observability slice.
 *
 * The slice carries raw constraint counts but not the individual constraint
 * labels (those live inside the full query plan). We surface generic labels
 * only when counts > 0 so consumers know constraints were active.
 */
function deriveAppliedConstraints(slice: QueryObservabilitySlice): string[] {
  const labels: string[] = [];

  if (slice.hardConstraintCount > 0) {
    labels.push(`hard_constraints: ${slice.hardConstraintCount}`);
  }
  if (slice.softConstraintCount > 0) {
    labels.push(`soft_constraints: ${slice.softConstraintCount}`);
  }

  return labels;
}

/**
 * Derive the confidence value from the observability slice.
 *
 * The slice carries `overallUncertainty` in [0, 1] where higher means more
 * uncertain. We map this to a confidence value: confidence = 1 − uncertainty,
 * falling back to 0.5 if the value is not finite.
 */
function deriveConfidence(slice: QueryObservabilitySlice): number {
  const raw = 1 - slice.overallUncertainty;
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
}

/**
 * Build an InterpretResponseV2 from planner observability data.
 *
 * This is the canonical V2 explain contract adapter. It does NOT expose
 * planner internals; instead it surfaces intent, decomposition, channel
 * activation, constraint application, and ranking signals in a stable
 * explain-family shape.
 */
export function buildInterpretResponseV2(input: ExplainAdapterV2Input): InterpretResponseV2 {
  const { queryId, queryText, observabilitySlice, decompositionHint, activeChannels } = input;

  // Decomposition strategy — omit when absent or 'none'
  const strategyValue: DecompositionStrategy | undefined = decompositionHint?.strategy;
  const includeStrategy =
    strategyValue !== undefined && strategyValue !== 'none';

  // Ranking signals — fixed baseline, extended with anchor signal when active
  const hasAnchorChannel = activeChannels.some(isAnchorChannel);
  const rankingSignals: string[] = [
    'semantic_similarity',
    'attribute_alignment',
    'popularity',
    ...(hasAnchorChannel ? ['anchor_similarity'] : []),
  ];

  const response: InterpretResponseV2 = {
    queryId,
    queryText,
    detectedIntent: observabilitySlice.queryFamily,
    ...(includeStrategy ? { decompositionStrategy: strategyValue } : {}),
    activeChannels: [...activeChannels],
    appliedConstraints: deriveAppliedConstraints(observabilitySlice),
    rankingSignals,
    confidence: deriveConfidence(observabilitySlice),
    version: '2',
    responseType: 'interpret',
  };

  return response;
}
