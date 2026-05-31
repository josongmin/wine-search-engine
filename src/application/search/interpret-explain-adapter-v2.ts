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
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import type { InterpretResponseV2 } from './interpret-response.dto.js';
import { preferCanonicalRetrievalChannelLabels } from '../../domain/retrieval/model/retrieval-channel.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';
import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_COMPARE_ANCHOR
} from '../../domain/retrieval/model/retrieval-channel.js';

export interface ExplainAdapterV2Input {
  readonly queryId: string;
  readonly queryText: string;
  readonly observabilitySlice: QueryObservabilitySlice;
  readonly decompositionHint?: QueryDecompositionHint | undefined;
  readonly activeChannels: readonly string[];
  /**
   * Actual hard constraint descriptors from the query plan.
   * When provided, constraint attribute names are used in appliedConstraints
   * instead of count-based generic labels.
   */
  readonly hardConstraints?: readonly NormalizedConstraint[] | undefined;
  /**
   * Actual soft constraint descriptors from the query plan.
   * When provided, constraint attribute names are used in appliedConstraints
   * instead of count-based generic labels.
   */
  readonly softConstraints?: readonly NormalizedConstraint[] | undefined;
}

/**
 * Channel name suffixes/substrings that indicate an anchor-conditioned retrieval
 * channel is active. Used to gate inclusion of "anchor_similarity" ranking signal.
 */
const ANCHOR_CHANNELS: ReadonlySet<string> = new Set([
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_COMPARE_ANCHOR,
]);

function isAnchorChannel(channel: string): boolean {
  return ANCHOR_CHANNELS.has(channel);
}

/**
 * Derive applied constraint labels from actual constraint arrays when
 * available, falling back to count-based labels from the observability slice.
 *
 * When `hardConstraints` / `softConstraints` are supplied (from the full
 * query plan), each constraint is represented as
 * `"hard:<attribute>"` / `"soft:<attribute>"` so machine consumers can
 * identify which attributes were constrained. Duplicates within each group
 * are deduplicated (e.g. two `region` hard constraints → one label).
 *
 * Falls back to count-based generic labels when the arrays are absent,
 * e.g. when called from a context that only has the observability slice.
 */
function deriveAppliedConstraints(
  slice: QueryObservabilitySlice,
  hardConstraints?: readonly NormalizedConstraint[],
  softConstraints?: readonly NormalizedConstraint[],
): string[] {
  // Prefer actual attribute names when arrays are provided.
  if (hardConstraints !== undefined || softConstraints !== undefined) {
    const labels: string[] = [];

    const hardSeen = new Set<string>();
    for (const c of hardConstraints ?? []) {
      const label = `hard:${c.attribute}`;
      if (!hardSeen.has(label)) {
        hardSeen.add(label);
        labels.push(label);
      }
    }

    const softSeen = new Set<string>();
    for (const c of softConstraints ?? []) {
      const label = `soft:${c.attribute}`;
      if (!softSeen.has(label)) {
        softSeen.add(label);
        labels.push(label);
      }
    }

    return labels;
  }

  // Fallback: count-based generic labels from the observability slice.
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
 * uncertain. We map this to a confidence value: confidence = 1 − uncertainty.
 * Invalid/non-finite inputs are omitted rather than masked with a midpoint.
 */
function deriveConfidence(slice: QueryObservabilitySlice): number | undefined {
  const raw = 1 - slice.overallUncertainty;
  return Number.isFinite(raw)
    ? clamp01(raw)
    : undefined;
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
  const {
    queryId,
    queryText,
    observabilitySlice,
    decompositionHint,
    activeChannels,
    hardConstraints,
    softConstraints,
  } = input;

  // Decomposition strategy — omit when absent or 'none'
  const strategyValue: DecompositionStrategy | undefined = decompositionHint?.strategy;
  const includeStrategy =
    strategyValue !== undefined && strategyValue !== 'none';

  const canonicalActiveChannels = preferCanonicalRetrievalChannelLabels(activeChannels);
  const confidence = deriveConfidence(observabilitySlice);

  // Ranking signals — fixed baseline, extended with anchor signal when active
  const hasAnchorChannel = canonicalActiveChannels.some(isAnchorChannel);
  const rankingSignals: string[] = [
    'semantic_similarity',
    'attribute_alignment',
    'popularity',
    ...(hasAnchorChannel ? [RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY] : []),
  ];

  const response: InterpretResponseV2 = {
    queryId,
    queryText,
    detectedIntent: observabilitySlice.queryFamily,
    ...(includeStrategy ? { decompositionStrategy: strategyValue } : {}),
    activeChannels: canonicalActiveChannels,
    appliedConstraints: deriveAppliedConstraints(observabilitySlice, hardConstraints, softConstraints),
    rankingSignals,
    ...(confidence !== undefined
      ? { confidence }
      : {}),
    version: '2',
    responseType: 'interpret',
  };

  return response;
}
