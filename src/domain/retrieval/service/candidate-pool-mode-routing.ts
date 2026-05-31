import type { HybridRetrievalInput } from '../model/retrieval-input.js';
import type { ExecutionRetrievalMode } from '../../query/model/engine-execution-contract.js';
import type { CandidateChannel } from '../model/candidate-envelope.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';
import type { RetrievalPhase } from './cascade-router.js';
import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
  RETRIEVAL_CHANNEL_LEARNED_SPARSE,
  RETRIEVAL_CHANNEL_RELATIVE_FILTER,
  RETRIEVAL_CHANNEL_SPARSE_BM25,
} from '../model/retrieval-channel.js';

/** Default anchor confidence when plan omits explicit score (neutral). */
export const HYBRID_ANCHOR_CONFIDENCE_DEFAULT = 0.5;

/**
 * Runtime retrieval mode resolved by `resolveRuntimeRetrievalMode`.
 *
 * It is the compiled `ExecutionRetrievalMode` PLUS the two router-internal
 * modes that never appear on the engine-execution contract but are produced
 * here:
 *  - `'relative'`            → compare_candidates with an explicit anchor entity.
 *  - `'entity_anchor_first'` → TRACK-A A4 anchor-dominant dual path.
 *
 * Typed as a closed union (not bare `string`) so a typo in a future mode
 * literal is caught at compile time. Downstream consumers (`getProfile`,
 * `resolveVespaRankProfile`, `mapDomainQueryClassToFusionQueryClass`) accept
 * `string`, so the narrower type is assignable everywhere.
 */
export type RuntimeRetrievalMode =
  | ExecutionRetrievalMode
  | 'relative'
  | 'entity_anchor_first';

/**
 * Retrieval modes that handle their own routing and must not be overridden by
 * the TRACK-A A4 entity_anchor_first path. Only undefined / entity_lookup /
 * entity_resolution / legacy mode strings are safe to override.
 */
const ANCHOR_FIRST_BLOCKED_MODES: ReadonlySet<string> = new Set([
  'producer_browse', 'region_browse', 'compare_candidates',
  'recommendation', 'similar_items', 'attribute_search',
  'constraint_filter', 'no_match_detection',
]);

/**
 * Heuristic estimate of alias match strength for cascade routing.
 * CandidatePool intentionally stays downstream of planning/anchor extraction,
 * so it uses anchor confidence propagated by the planner rather than reaching
 * back into alias infrastructure a second time.
 */
export function estimateAliasStrength(input: HybridRetrievalInput): number {
  const anchors = input.queryPlan.anchors;
  if (anchors.length === 0) {
    return 0;
  }
  // Use the highest anchor confidence as a proxy for alias match strength.
  // Loop instead of Math.max(...spread) to avoid stack overflow on adversarial
  // inputs that produce tens of thousands of anchors.
  let max = -Infinity;
  for (const a of anchors) {
    if (a.confidence > max) max = a.confidence;
  }
  return max;
}

/**
 * Deterministic exact-anchor lock.
 *
 * When planning has already collapsed the query onto a single anchor entity
 * under `entity_exact` / `mixed_query`, semantic dense expansion is more likely
 * to dilute the exact target than to help. In that case we keep lexical +
 * anchor-ANN and suppress generic semantic ANN.
 */
export function isDeterministicExactAnchorQuery(input: HybridRetrievalInput): boolean {
  const intent = input.queryPlan.intent;
  if (intent !== 'entity_exact' && intent !== 'mixed_query') {
    return false;
  }
  if (input.queryPlan.queryClass === 'ambiguous_short_form') {
    return false;
  }

  const uniqueEntityIds = new Set(
    input.queryPlan.anchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)),
  );
  return uniqueEntityIds.size === 1;
}

export function resolveRuntimeRetrievalMode(input: HybridRetrievalInput): RuntimeRetrievalMode {
  if (input.compiledRetrievalMode === undefined) {
    throw new Error('CandidatePoolService requires compiledRetrievalMode from compiled execution');
  }
  const baseMode = input.compiledRetrievalMode;
  if (baseMode === 'compare_candidates' && input.anchorEntityId !== undefined) {
    return 'relative';
  }
  // TRACK-A A4: exact_entity / short_entity WITH non-empty anchors → anchor-first dual path.
  // The planner has resolved at least one entity with a confidence score — prioritise the
  // entity-anchor channel in fusion so the exact target surfaces at rank 1.
  // Condition: queryClass is exact_entity or short_entity AND anchors array is non-empty.
  // No override when baseMode is already a specialised mode (producer_browse, etc.) —
  // those paths handle their own routing.
  const isEntityQueryClass =
    input.queryPlan.queryClass === 'exact_entity' ||
    input.queryPlan.queryClass === 'short_entity';
  const hasAnchors = input.queryPlan.anchors.length > 0;
  // Allow entity_anchor_first override only when the base mode is absent or a
  // generic entity lookup mode. Specialised modes (producer_browse, region_browse,
  // compare_candidates, etc.) handle their own routing and must not be overridden.
  const noSpecialMode = !ANCHOR_FIRST_BLOCKED_MODES.has(baseMode);
  if (isEntityQueryClass && hasAnchors && noSpecialMode) {
    return 'entity_anchor_first';
  }
  return baseMode;
}

/**
 * Restrict an already-resolved active-channel set to the caller-selected
 * retrieval lane. `'hybrid'` (or absent) is a no-op. The empty-set fallback
 * is lane-aware: a `'semantic_only'` request that filtered every channel
 * falls back to dense (NOT sparse) so the lane invariant holds even on the
 * degenerate path.
 */
export function applyRetrievalLaneFilter(
  channels: ReadonlySet<CandidateChannel>,
  lane: HybridRetrievalInput['retrievalLane'],
): ReadonlySet<CandidateChannel> {
  if (lane === undefined || lane === 'hybrid') {
    return channels;
  }
  const filtered = new Set<CandidateChannel>();
  for (const channel of channels) {
    if (lane === 'semantic_only') {
      if (
        channel === RETRIEVAL_CHANNEL_DENSE_SEMANTIC
        || channel === RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY
        || channel === RETRIEVAL_CHANNEL_RELATIVE_FILTER
      ) {
        filtered.add(channel);
      }
      continue;
    }
    // lane === 'lexical_only'
    if (
      channel === RETRIEVAL_CHANNEL_SPARSE_BM25
      || channel === RETRIEVAL_CHANNEL_LEARNED_SPARSE
    ) {
      filtered.add(channel);
    }
  }
  if (filtered.size === 0) {
    filtered.add(
      lane === 'semantic_only'
        ? RETRIEVAL_CHANNEL_DENSE_SEMANTIC
        : RETRIEVAL_CHANNEL_SPARSE_BM25,
    );
  }
  return filtered;
}

export function shouldExecutePhase(
  phase: RetrievalPhase,
  activeChannels: ReadonlySet<CandidateChannel>,
): boolean {
  switch (phase) {
    case 'sparse':
      return activeChannels.has(RETRIEVAL_CHANNEL_SPARSE_BM25);
    case 'learned_sparse':
      return activeChannels.has(RETRIEVAL_CHANNEL_LEARNED_SPARSE);
    case 'dense':
      return activeChannels.has(RETRIEVAL_CHANNEL_DENSE_SEMANTIC);
    case 'anchor_neighborhood':
      return activeChannels.has(RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY);
    case 'relative':
      return activeChannels.has(RETRIEVAL_CHANNEL_RELATIVE_FILTER);
  }
}

export function resolveAnchorProfile(
  input: HybridRetrievalInput,
  anchorDocument: RetrievalDocument | undefined,
): HybridRetrievalInput['anchorProfile'] {
  if (input.anchorProfile !== undefined) {
    return input.anchorProfile;
  }

  if (anchorDocument === undefined) {
    return undefined;
  }

  return {
    semanticSummary: anchorDocument.semanticSummary,
    ...(anchorDocument.embedding !== undefined
      ? { embedding: anchorDocument.embedding }
      : {}),
    anchorConfidence: input.queryPlan.anchors[0]?.confidence ?? HYBRID_ANCHOR_CONFIDENCE_DEFAULT,
  };
}
