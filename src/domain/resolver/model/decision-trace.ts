import type { QueryLookupProvenance } from '../../query/model/query-lookup-provenance.js';
import type { EntityCandidateSource } from './entity-candidate-generator-input.js';

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

  /** Calibrated probability for the top-2 candidate. */
  readonly top2CalibratedScore: number;

  /** Gap between top-1 and top-2 calibrated scores. */
  readonly calibratedGap: number;

  /** THE calibrated decision confidence C. */
  readonly decisionConfidenceC: number;

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
