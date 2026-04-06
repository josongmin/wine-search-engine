import type { NormalizedQueryViews } from '../../query/model/query-views.js';

/**
 * Query-side provenance attached to resolver traces for noisy lookup debugging.
 */
export interface ResolverQueryProvenance {
  /** Multi-view normalization snapshot used during lookup. */
  readonly normalizedQueryViews?: NormalizedQueryViews | undefined;

  /** Lookup variants that contributed to anchor extraction. */
  readonly anchorLookupVariants?: readonly string[] | undefined;

  /** Lookup strategies that contributed to anchor extraction. */
  readonly anchorLookupStrategies?: readonly string[] | undefined;

  /** Per-entity raw score adjustments derived from lookup strategies. */
  readonly lookupStrategyAdjustments?: readonly {
    readonly entityId: string;
    readonly strategies: readonly string[];
    readonly rawScoreDelta: number;
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
