import type { HybridCandidate } from './hybrid-candidate.js';
import type { ProvenanceProtectedReason } from './provenance.js';
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
 *
 * SSoT: the 5-value vocabulary lives in {@link ./provenance.js} as
 * `PROVENANCE_PROTECTED_REASONS` / `ProvenanceProtectedReason`. This is an
 * alias so existing consumers keep the `ProtectedInclusionReason` name while
 * the literal set is defined in exactly one place (Rule 30/SSoT). Previously
 * the same 5 literals were re-typed here, in provenance.ts, and as a Zod enum
 * in retrieval-contract-v2.ts — three copies that could drift independently.
 */
export type ProtectedInclusionReason = ProvenanceProtectedReason;

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
 * Wave 2 — per-channel firing state for retrieval telemetry.
 *
 *  - `active`              — channel ran successfully and produced (possibly zero) hits.
 *  - `dormant`             — channel was not selected for this query
 *                            (e.g. learned_sparse with no production wiring, or
 *                            anchor channel when no anchor is present). No call attempted.
 *  - `circuit_breaker_open`— the downstream breaker was open at call time,
 *                            so the channel skipped the request fast-fail.
 *  - `timeout`             — channel call exceeded the per-channel timeout
 *                            budget and was aborted.
 *  - `error`               — channel call surfaced an infra error other than
 *                            timeout / circuit-breaker-open.
 *
 * Operator semantics:
 *  - `active`   ⇒ counts as a healthy fan-out lane.
 *  - `dormant`  ⇒ EXPECTED off; do NOT alert.
 *  - any other ⇒ degraded; alert candidate.
 */
export type RetrievalChannelFiringState =
  | 'active'
  | 'dormant'
  | 'circuit_breaker_open'
  | 'timeout'
  | 'error';

/**
 * Wave 2 — per-channel telemetry row inside `RrfFusionTrace.perChannel`.
 *
 * One row per retrieval channel touched (or considered) for the request.
 * Operators read this to answer the question:
 *   "For request X, which channels fired, how many hits did each return,
 *    and how much of the final fused ordering came from each?"
 *
 * Fields:
 *  - `channel`            — canonical retrieval channel name (matches `CandidateChannel`).
 *  - `firingState`        — see `RetrievalChannelFiringState` above.
 *  - `hitCount`           — number of raw hits the channel returned (0 when dormant / failed).
 *  - `topKInput`          — top-K cap the channel was invoked with (0 when not invoked).
 *  - `fusionContribution` — sum of this channel's `rrfContribution`s across the
 *                           top-K assembled candidates. Higher = this channel
 *                           pulled more weight into the final ordering.
 */
export interface RetrievalChannelTrace {
  readonly channel: CandidateChannel;
  readonly firingState: RetrievalChannelFiringState;
  readonly hitCount: number;
  readonly topKInput: number;
  readonly fusionContribution: number;
}

/**
 * E4: Request-level RRF fusion trace — one per query execution.
 * Attached to CandidateEnvelope at the list level.
 *
 * Wave 2: `perChannel` adds per-channel hit counts, firing-state and
 * post-fusion contribution so operators can see WHICH channels fired
 * vs. went dormant in a single request snapshot (the previous
 * `candidateCount.beforeFusion` shape only carried raw hit counts and
 * omitted both `learned_sparse` and firing-state).
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
  /**
   * Wave 2 — per-channel telemetry rows. Present on every fusion trace
   * built by `CandidatePoolService.execute` so operators have a stable
   * shape to read from. One row per channel considered for the request
   * (typically: sparse_bm25, learned_sparse, dense_semantic,
   * anchor_similarity).
   */
  readonly perChannel: readonly RetrievalChannelTrace[];
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
