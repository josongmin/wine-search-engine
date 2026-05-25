/**
 * Canonical provenance vocabulary used across:
 * - runtime retrieval traces
 * - offline eval slices
 * - ranking feature labels
 *
 * Channel names delegate to {@link ./retrieval-channel.js} (SSoT) — do not
 * duplicate the channel list here.
 */

import {
  RETRIEVAL_CHANNELS,
  isRetrievalChannel,
  type RetrievalChannel,
} from './retrieval-channel.js';

/** Alias of {@link RETRIEVAL_CHANNELS} for provenance / eval slice vocabulary. */
export const PROVENANCE_CHANNELS = RETRIEVAL_CHANNELS;

export type ProvenanceChannel = RetrievalChannel;

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
  return isRetrievalChannel(value);
}

/**
 * Type guard: check if a string is a valid ProvenanceQueryView.
 */
export function isProvenanceQueryView(value: string): value is ProvenanceQueryView {
  return (PROVENANCE_QUERY_VIEWS as readonly string[]).includes(value);
}
