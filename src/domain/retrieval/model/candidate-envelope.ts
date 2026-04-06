/**
 * Channel sources for candidate provenance tracking.
 * Each value identifies which retrieval channel contributed the candidate.
 */
export type CandidateChannel =
  | 'sparse_bm25'
  | 'dense_semantic'
  | 'dense_anchor'
  | 'learned_sparse'    // future: Epic 4
  | 'anchor_similarity' // future: Epic 4
  | 'relative_filter'   // future: Epic 4
  | 'browse_producer'
  | 'browse_region'
  | 'compare_anchor';

/**
 * Reason a candidate is "protected" — must survive assembly even if
 * RRF score is low.
 */
export type ProtectedInclusionReason =
  | 'exact_alias_match'
  | 'known_item_lookup'
  | 'anchor_conditioned'
  | 'hard_constraint_compatible'
  | 'diversity_slot';   // preserved for source/producer diversity

/**
 * Per-channel score evidence attached to a candidate.
 */
export interface ChannelScoreEvidence {
  readonly channel: CandidateChannel;
  readonly rawScore: number;       // raw score from this channel (BM25 score, cosine similarity, etc.)
  readonly rank: number;           // rank within this channel's result set (1-indexed)
  readonly rrfContribution: number; // this channel's contribution to final RRF score
}

/**
 * The matched query view that produced this candidate from this channel.
 * Links candidate provenance back to query understanding.
 */
export interface QueryViewMatch {
  readonly viewName: string;  // e.g. 'strict', 'accentless', 'transliterated'
  readonly matchedText: string;
  readonly channel: CandidateChannel;
}

/**
 * Rich provenance envelope attached to every candidate.
 * Extends the existing RetrievalTrace concept into a structured per-candidate contract.
 */
export interface CandidateProvenance {
  /** All channels that contributed to this candidate (via fusion). */
  readonly channels: readonly CandidateChannel[];

  /** Score evidence per contributing channel. */
  readonly channelScores: readonly ChannelScoreEvidence[];

  /** Which query views produced this candidate from which channels. */
  readonly queryViewMatches: readonly QueryViewMatch[];

  /** Whether this candidate was anchor-conditioned (similarity or relative). */
  readonly anchorConditioned: boolean;

  /** Filter constraints that were successfully matched. */
  readonly matchedFilterConstraints: readonly string[];

  /** Hard constraints that this candidate fails (for debugging; should be empty after hard filter). */
  readonly failedHardConstraints?: readonly string[];

  /** If protected, why. */
  readonly protectedInclusionReason?: ProtectedInclusionReason;

  /** The fusion profile that produced the final RRF score. */
  readonly fusionProfile: string;

  /** Final RRF score (sum of channel contributions). */
  readonly fusionScore: number;
}

/**
 * V2 candidate envelope.
 *
 * Wraps the existing HybridCandidate with rich provenance.
 * During Epic 3 migration, CandidateEnvelope is produced alongside HybridCandidate.
 * In Epic 4+, HybridCandidate will be replaced by CandidateEnvelope as the
 * canonical retrieval output.
 */
export interface CandidateEnvelope {
  /** Entity ID — same as HybridCandidate.entityId */
  readonly entityId: string;

  /** Rich provenance envelope. */
  readonly provenance: CandidateProvenance;

  /**
   * Snapshot of the existing HybridCandidate for backward compatibility
   * during Epic 3 migration. Will be removed in Epic 4.
   */
  readonly legacyCandidate: import('./hybrid-candidate.js').HybridCandidate;
}
