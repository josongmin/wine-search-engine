/**
 * Canonical provenance vocabulary used across:
 * - runtime retrieval traces
 * - offline eval slices
 * - ranking feature labels
 *
 * This is the shared vocabulary that T3.6 (Trace/observability alignment) will wire
 * into runtime logs and eval storage.
 */

export const PROVENANCE_CHANNELS = [
  'sparse_bm25',
  'dense_semantic',
  'learned_sparse',
  'anchor_similarity',
  'relative_filter',
  'browse_producer',
  'browse_region',
  'compare_anchor',
] as const;

export type ProvenanceChannel = (typeof PROVENANCE_CHANNELS)[number];

export const PROVENANCE_QUERY_VIEWS = [
  'raw',
  'strict',
  'accentless',
  'compact',
  'phonetic_compact',
  'vintage_canonicalized',
  'vintage_stripped',
  'transliterated',
] as const;

export type ProvenanceQueryView = (typeof PROVENANCE_QUERY_VIEWS)[number];

export const PROVENANCE_PROTECTED_REASONS = [
  'exact_alias_match',
  'known_item_lookup',
  'anchor_conditioned',
  'hard_constraint_compatible',
  'diversity_slot',
] as const;

export type ProvenanceProtectedReason = (typeof PROVENANCE_PROTECTED_REASONS)[number];

/**
 * Eval slice vocabulary — aligns retrieval provenance with eval scoring.
 * Used by eval-runner, eval scripts, and offline quality analysis.
 */
export interface EvalProvenanceSlice {
  readonly queryId: string;
  readonly candidateEntityId: string;
  readonly channels: readonly ProvenanceChannel[];
  readonly topChannel: ProvenanceChannel;       // highest-contribution channel
  readonly anchorConditioned: boolean;
  readonly protected: boolean;
  readonly protectedReason?: ProvenanceProtectedReason;
  readonly fusionScore: number;
  readonly rank: number;
}

/**
 * Type guard: check if a string is a valid ProvenanceChannel.
 */
export function isProvenanceChannel(value: string): value is ProvenanceChannel {
  return (PROVENANCE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Type guard: check if a string is a valid ProvenanceQueryView.
 */
export function isProvenanceQueryView(value: string): value is ProvenanceQueryView {
  return (PROVENANCE_QUERY_VIEWS as readonly string[]).includes(value);
}
