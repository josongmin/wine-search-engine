import type { HybridCandidate } from './hybrid-candidate.js';
import type { RetrievalChannel } from './retrieval-channel.js';

/**
 * Channel sources for candidate provenance tracking.
 * Derived from the single source of truth in retrieval-channel.ts.
 * Previously this was a manually mirrored string union — bugbash A/SSoT fix.
 */
export type CandidateChannel = RetrievalChannel;

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

  /**
   * E4: Per-channel detailed evidence. Present when detail tracing is enabled.
   * Absent in production hot-path (opt-in to avoid allocation overhead).
   */
  readonly detail?: readonly CandidateProvenanceDetail[] | undefined;
}

/**
 * E4: Hard filter pass/reject trace for a single candidate in a channel.
 */
export interface FilterTrace {
  /** Filter attributes that this candidate passed (e.g. 'region=Bordeaux'). */
  readonly applied: readonly string[];
  /** Reason this candidate was rejected by a filter, if any. */
  readonly rejected?: string | undefined;
}

/**
 * E4: Per-channel detailed evidence for a single candidate.
 *
 * Extends the lighter ChannelScoreEvidence with matching detail
 * for audit and calibration use.
 */
export interface CandidateProvenanceDetail {
  readonly channel: CandidateChannel;
  readonly rawScore: number;
  readonly normalizedScore: number;
  readonly rrfContribution: number;
  readonly rank: number;

  /** Sparse channel: BM25 matched tokens. */
  readonly matchedTerms?: readonly string[] | undefined;
  /** Constraint attributes satisfied by this candidate in this channel. */
  readonly matchedConstraints?: readonly string[] | undefined;
  /** Constraint attributes not satisfied. */
  readonly missingConstraints?: readonly string[] | undefined;

  /** Vespa rank profile used. */
  readonly retrievalProfile: string;
  /** Hard filter trace. */
  readonly filterTrace?: FilterTrace | undefined;

  /** Whether this channel's retrieval was degraded. */
  readonly degraded: boolean;
  readonly degradationReason?: string | undefined;
}

/**
 * E4: Record of a candidate that was dropped from the pipeline.
 * Retained for audit; production systems sample top-5 drops.
 */
export interface CandidateDropRecord {
  readonly entityId: string;
  /** Stage at which this candidate was dropped. */
  readonly dropStage: 'hard_filter' | 'coarse_prune' | 'assembly_dedup';
  readonly dropReason: string;
  readonly lastKnownScore: number;
  // NOTE: Pick<> does not preserve readonly on individual fields, so we use an
  // explicit inline type to maintain the codebase's readonly-first invariant.
  readonly channels: ReadonlyArray<{
    readonly channel: CandidateChannel;
    readonly rawScore: number;
    readonly rank: number;
  }>;
}

/**
 * E4: Request-level RRF fusion trace — one per query execution.
 * Attached to CandidateEnvelope at the list level.
 */
export interface RrfFusionTrace {
  readonly queryClass: string;
  readonly fusionClass: string;
  readonly rrfK: number;
  readonly channelWeights: {
    readonly sparse: number;
    readonly dense: number;
    readonly anchor: number;
    readonly learnedSparse: number;
  };
  readonly candidateCount: {
    readonly beforeFusion: { readonly sparse: number; readonly dense: number; readonly anchor: number };
    readonly afterFusion: number;
    readonly afterHardFilter: number;
    readonly afterAssembly: number;
  };
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
  readonly legacyCandidate: HybridCandidate;

  /**
   * E4: Sampled drop log — candidates dropped from the pipeline during assembly.
   * Top-5 in production; full list in debug mode.
   */
  readonly dropLog?: readonly CandidateDropRecord[] | undefined;

  /**
   * E4: RRF fusion trace for this request. Attached once per list, not per candidate.
   * Only the first CandidateEnvelope in a result list carries this; others omit it.
   */
  readonly fusionTrace?: RrfFusionTrace | undefined;
}
