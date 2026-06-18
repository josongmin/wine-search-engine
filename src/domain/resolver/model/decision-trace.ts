import type { QueryLookupProvenance } from '../../query/model/query-lookup-provenance.js';
import type { EntityCandidateSource } from './entity-candidate-generator-input.js';

/**
 * Per-candidate structured trace capturing the resolver's internal
 * score/calibration/boundary state at the moment each candidate was ranked.
 *
 * Attached to {@link ResolvedCandidate.trace} so that exact-route failures
 * can be fully reproduced from a single request trace without access to logs.
 */
export interface ResolverCandidateTrace {
  /** Raw score assigned by the candidate scorer (post-adjustment, post-blend). */
  readonly score: number;

  /** Calibrated confidence for this candidate in [0, 1]. */
  readonly calibratedConfidence: number;

  /** Boundary outcome: how the resolver classified this candidate. */
  readonly boundaryDecision: 'singleton' | 'admitted' | 'rejected';

  /** Human-readable reason for the admission gate outcome (present on rejected candidates). */
  readonly admissionGateReason?: string | undefined;

  /** Source provenance that produced this candidate. */
  readonly matchSource: EntityCandidateSource;
}

/**
 * Query-side provenance attached to resolver traces for noisy lookup debugging.
 *
 * Extends {@link QueryLookupProvenance} with resolver-only score-adjustment detail.
 */
export interface ResolverQueryProvenance extends QueryLookupProvenance {
  /** Per-entity raw score adjustments derived from lookup strategies. */
  readonly lookupStrategyAdjustments?: readonly {
    readonly entityId: string;
    readonly strategies: readonly string[];
    readonly rawScoreDelta: number;
  }[] | undefined;

  /**
   * Candidate entity IDs that entered resolver scoring via blocker-seed
   * hydration rather than anchor lookup.
   */
  readonly blockerSeedEntityIds?: readonly string[] | undefined;

  /** Number of blocker-seeded candidates that survived into scoring. */
  readonly blockerSeedCount?: number | undefined;

  /**
   * Generalized source breakdown for all candidates that survived into scoring.
   *
   * Preferred audit surface for exact-recovery provenance. The blocker-specific
   * fields above are retained as derived compatibility fields.
   */
  readonly candidateSourceBreakdown?: readonly {
    readonly source: EntityCandidateSource;
    readonly entityIds: readonly string[];
    readonly count: number;
  }[] | undefined;
}

/**
 * A diagnostic trace capturing every input and threshold that shaped
 * the resolver's outcome, per RFC-006 §8.
 *
 * This trace is attached to every {@link EntityResolveResult} for
 * auditability and regression analysis.
 */
export interface ResolverDecisionTrace {
  /** The query class used to look up thresholds. */
  readonly queryClass: string;

  /** Calibrated probability for the top-1 candidate. */
  readonly top1CalibratedScore: number;

  /**
   * Calibrated probability for the top-2 candidate, or undefined when
   * no runner-up exists. C2: never 0-as-absence.
   */
  readonly top2CalibratedScore: number | undefined;

  /**
   * Gap between top-1 and top-2 calibrated scores, or undefined when
   * no runner-up exists (the gap is not meaningful for a singleton).
   */
  readonly calibratedGap: number | undefined;

  /** THE calibrated decision confidence C. */
  readonly decisionConfidenceC: number;

  /**
   * Raw (pre-calibration) top-1 resolver score — the value fed to
   * {@link Calibrator.calibrate} as `rawScores.top1`. Carried through the
   * decision/response layers so the eval harness can persist it as
   * `eval_results.top1_raw_score`; the nightly calibration trainer consumes
   * (top1RawScore, isCorrectResolve) pairs. Undefined when no candidate was
   * scored (empty/failed trace). MUST NOT be treated as a probability.
   */
  readonly top1RawScore?: number | undefined;

  /**
   * Whether `decisionConfidenceC` was produced from trained calibration
   * parameters that were fresh enough to trust (P0.1 nightly auto-pipeline
   * TTL gate), or from the identity-fallback / stale-params path. Decision-layer
   * thresholds that semantically depend on probability (Epic 17.3
   * ConfidenceRefusalPolicy) MUST skip enforcement when this is `false` —
   * otherwise a raw score is treated as a probability and the refusal floor
   * becomes a quasi-random gate on uncalibrated state. Propagated from
   * {@link CalibratedResolutionScore}.
   */
  readonly calibrationTrusted: boolean;

  /** Whether any ambiguity was detected among candidates. */
  readonly ambiguityDetected: boolean;

  /** Specific ambiguity types detected (may be empty). */
  readonly ambiguityTypes: readonly string[];

  /** The threshold values that were applied to reach the decision. */
  readonly appliedThresholds: {
    readonly resolveThreshold: number;
    readonly gapThreshold: number;
  };

  /** Machine-readable codes explaining why the resolver reached its outcome. */
  readonly outcomeReasonCodes: readonly string[];

  /** Query-side provenance useful for noisy lookup debugging. */
  readonly queryProvenance?: ResolverQueryProvenance | undefined;

  /**
   * When a learned matcher blended scores (RFC-006 §5.2), mirrors model outputs
   * for debugging and regression tests.
   */
  readonly learnedMatcherTrace?: {
    readonly modelId: string;
    readonly modelVersion: string;
    readonly candidates: readonly {
      readonly entityId: string;
      readonly matchProbability: number;
      readonly matchSignalVector?: readonly number[] | undefined;
    }[];
  } | undefined;
}
