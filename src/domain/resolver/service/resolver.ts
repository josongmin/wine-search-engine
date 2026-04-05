import type { DecisionStatus, NextAction, QueryClass } from '../../shared/types/index.js';
import type { QueryPolicy } from '../../query/model/query-policy.js';
import type { QueryUncertainty } from '../../query/model/query-uncertainty.js';
import type { AnchorCandidate } from '../../query/model/anchor-candidate.js';
import type { ThresholdEntry } from '../../query/model/threshold-profile.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../query/model/threshold-profile.js';
import type { EntityResolveResult } from '../model/resolve-result.js';
import type { ResolvedCandidate, ResolverCandidate } from '../model/resolved-candidate.js';
import type { ResolverDecisionTrace } from '../model/decision-trace.js';
import type { CalibratedResolutionScore } from '../model/calibrated-score.js';
import type { AmbiguityState } from '../model/ambiguity-state.js';
import type { Blocker } from './blocker.js';
import type { CandidateScorer } from './candidate-scorer.js';
import type { AmbiguityClassifier } from './ambiguity-classifier.js';
import type { Calibrator } from './calibrator.js';

/**
 * Input required to run the entity resolution pipeline.
 */
export interface ResolverInput {
  /** The original user query string. */
  readonly rawQuery: string;

  /** Lowercased, accent-stripped, whitespace-collapsed form. */
  readonly normalizedQuery: string;

  /** Query class label used to select thresholds. */
  readonly queryClass: QueryClass;

  /** Compiled policy directives. */
  readonly policy: QueryPolicy;

  /** Anchor entities extracted from the query. */
  readonly anchorCandidates: readonly AnchorCandidate[];

  /** Uncertainty assessment from the query planner. */
  readonly uncertainty: QueryUncertainty;

  /** Pre-loaded candidate entities (may come from external retrieval). */
  readonly candidateEntities: readonly ResolverCandidate[];
}

/**
 * Default significance level (alpha) for conformal prediction.
 * At alpha = 0.1 the prediction set has at least 90 % marginal coverage.
 */
const DEFAULT_ALPHA = 0.1;

/**
 * Computes the conformal prediction set size for a single query.
 *
 * The prediction set contracts or expands based on how confidently C exceeds
 * the significance thresholds derived from alpha:
 *
 * - Returns **1** when C >= (1 - alpha)       — top candidate is sufficient.
 * - Returns **2** when C >= (1 - 2 * alpha)   — two candidates are needed.
 * - Returns **K** otherwise                   — abstain; return all candidates.
 *
 * @param calibratedScore - Calibrated decision confidence C in [0, 1].
 * @param alpha - Significance level (must be in (0, 0.5]).
 * @param k - Total number of candidates (fallback set size on abstain).
 * @returns The conformal prediction set size.
 */
export function computeConformalSetSize(
  calibratedScore: number,
  alpha: number,
  k: number,
): number {
  if (calibratedScore >= 1 - alpha) {
    return 1;
  }
  if (calibratedScore >= 1 - 2 * alpha) {
    return 2;
  }
  return k;
}

/**
 * The core entity resolver — Track A of the Wine Intelligence Engine,
 * per RFC-006.
 *
 * Pipeline:
 * 1. Block: narrow the entity space to plausible candidates (recall >= 0.99).
 * 2. Score: compute raw weighted-sum scores for each candidate.
 * 3. Sort: rank candidates by raw score descending.
 * 4. Calibrate: convert top raw scores to calibrated probabilities.
 * 5. Classify ambiguity: detect structural ambiguity among candidates.
 * 6. Apply decision boundary: compare calibrated C and gap against thresholds.
 * 7. Build result: assemble {@link EntityResolveResult} with full trace.
 *
 * The resolver produces a SUGGESTION (status). The final binding decision
 * is made by the {@link DecisionEngine} in the decision domain.
 */
export class Resolver {
  constructor(
    private readonly blocker: Blocker,
    private readonly candidateScorer: CandidateScorer,
    private readonly ambiguityClassifier: AmbiguityClassifier,
    private readonly calibrator: Calibrator,
  ) {}

  /**
   * Runs the full entity resolution pipeline.
   *
   * @param input - All data needed for resolution.
   * @returns The resolver's result including suggested status, candidates, and trace.
   */
  async resolve(input: ResolverInput): Promise<EntityResolveResult> {
    // Step 1: Block — get candidate IDs from the blocking port
    const blockedIds = await this.blocker.block(
      input.rawQuery,
      input.normalizedQuery,
    );

    // Merge blocked IDs with pre-loaded candidate entities.
    // Pre-loaded candidates that survived blocking are used; others from
    // blocking that are not in candidateEntities are excluded (they lack signals).
    const blockedIdSet = new Set(blockedIds.map(String));
    const candidates = input.candidateEntities.filter(
      (c) => blockedIdSet.has(String(c.entityId)),
    );

    // If blocking returned IDs not present in candidateEntities, we still
    // proceed with what we have — the scorer needs full signal sets.

    // Step 2: Score each candidate
    const scored = candidates.map((candidate) => ({
      candidate,
      rawScore: this.candidateScorer.score(candidate),
    }));

    // Step 3: Sort by raw score descending
    scored.sort((a, b) => b.rawScore - a.rawScore);

    // Step 4: Calibrate top scores
    const top1RawScore = scored[0]?.rawScore ?? 0;
    const top2RawScore = scored[1]?.rawScore ?? 0;

    const calibrated = await this.calibrator.calibrate(
      { top1: top1RawScore, top2: top2RawScore },
      input.queryClass,
    );

    // Step 5: Classify ambiguity
    const sortedCandidates = scored.map((s) => s.candidate);
    const ambiguityState = this.ambiguityClassifier.classify(
      sortedCandidates,
      input.queryClass,
    );

    // Step 6: Apply decision boundary
    const thresholds = this.getThresholds(input.queryClass);
    const { status, nextAction, reasonCodes } = this.applyDecisionBoundary(
      calibrated,
      ambiguityState,
      thresholds,
    );

    // Step 7: Build result
    const resolvedCandidates = this.buildResolvedCandidates(scored, calibrated);
    const topCandidate = resolvedCandidates[0];

    const trace = this.buildTrace(
      input.queryClass,
      calibrated,
      ambiguityState,
      thresholds,
      reasonCodes,
    );

    const conformalSetSize = computeConformalSetSize(
      calibrated.decisionConfidenceC,
      DEFAULT_ALPHA,
      resolvedCandidates.length,
    );

    const result: EntityResolveResult = {
      status,
      recommendedNextAction: nextAction,
      decisionConfidenceC: calibrated.decisionConfidenceC,
      ...(topCandidate !== undefined
        ? {
            topEntity: {
              entityId: topCandidate.entityId,
              canonicalLabel: topCandidate.canonicalLabel,
              calibratedScore: topCandidate.calibratedScore,
            },
          }
        : {}),
      candidates: resolvedCandidates,
      ...(ambiguityState.detected
        ? {
            ambiguity: {
              types: ambiguityState.types,
              severity: ambiguityState.severity,
              explanationCodes: reasonCodes.filter((c) => c.startsWith('AMBIGUITY_')),
            },
          }
        : {}),
      decisionTrace: trace,
      conformalSetSize,
    };

    return result;
  }

  /**
   * Applies the RFC-006 decision boundary:
   * - C >= T_resolve(Q) AND delta >= T_gap(Q) AND NOT ambiguous => resolved
   * - Otherwise => ambiguous or failed
   */
  private applyDecisionBoundary(
    calibrated: CalibratedResolutionScore,
    ambiguity: AmbiguityState,
    thresholds: ThresholdEntry,
  ): { status: DecisionStatus; nextAction: NextAction; reasonCodes: string[] } {
    const reasonCodes: string[] = [];

    const cMeetsThreshold = calibrated.decisionConfidenceC >= thresholds.resolveTau;
    const gapMeetsThreshold = calibrated.calibratedGap >= thresholds.gapTau;
    const isAmbiguous = ambiguity.detected;

    if (cMeetsThreshold) {
      reasonCodes.push('CONFIDENCE_ABOVE_THRESHOLD');
    } else {
      reasonCodes.push('CONFIDENCE_BELOW_THRESHOLD');
    }

    if (gapMeetsThreshold) {
      reasonCodes.push('GAP_ABOVE_THRESHOLD');
    } else {
      reasonCodes.push('GAP_BELOW_THRESHOLD');
    }

    if (isAmbiguous) {
      for (const t of ambiguity.types) {
        reasonCodes.push(`AMBIGUITY_${t.toUpperCase()}`);
      }
    }

    // Decision boundary: all three conditions must hold for resolution
    if (cMeetsThreshold && gapMeetsThreshold && !isAmbiguous) {
      reasonCodes.push('RESOLVED_ALL_GATES_PASSED');
      return { status: 'resolved', nextAction: 'return_result', reasonCodes };
    }

    // Ambiguous case: high enough confidence but ambiguity or gap issue
    if (isAmbiguous || !gapMeetsThreshold) {
      reasonCodes.push('AMBIGUOUS_CLARIFICATION_NEEDED');
      return { status: 'ambiguous', nextAction: 'clarify', reasonCodes };
    }

    // Low confidence, no ambiguity detected — fail or hybrid search
    if (calibrated.decisionConfidenceC > 0) {
      reasonCodes.push('LOW_CONFIDENCE_HYBRID_FALLBACK');
      return { status: 'ambiguous', nextAction: 'hybrid_search', reasonCodes };
    }

    reasonCodes.push('NO_VIABLE_CANDIDATES');
    return { status: 'failed', nextAction: 'fail', reasonCodes };
  }

  /**
   * Retrieves threshold entries for the given query class from the
   * default profile. In production, this would load from a ThresholdStore.
   */
  private getThresholds(queryClass: QueryClass): ThresholdEntry {
    return DEFAULT_THRESHOLD_PROFILE.perQueryClass[queryClass];
  }

  /**
   * Builds the ranked list of resolved candidates with calibrated scores.
   */
  private buildResolvedCandidates(
    scored: readonly { candidate: ResolverCandidate; rawScore: number }[],
    calibrated: CalibratedResolutionScore,
  ): readonly ResolvedCandidate[] {
    return scored.map((entry, index) => {
      // The top-1 and top-2 get their calibrated scores; others get
      // linearly interpolated estimates relative to their raw scores.
      let calibratedScore: number;
      if (index === 0) {
        calibratedScore = calibrated.top1CalibratedScore;
      } else if (index === 1) {
        calibratedScore = calibrated.top2CalibratedScore;
      } else {
        // For candidates beyond top-2, estimate by proportional scaling
        const top1Raw = scored[0]?.rawScore ?? 1;
        const ratio = top1Raw > 0 ? entry.rawScore / top1Raw : 0;
        calibratedScore = calibrated.top1CalibratedScore * ratio;
      }

      return {
        entityId: entry.candidate.entityId,
        canonicalLabel: entry.candidate.canonicalLabel,
        calibratedScore,
        rank: index + 1,
        evidenceRefs: entry.candidate.aliasMatches.map((m) => m.aliasValue),
      };
    });
  }

  /**
   * Builds a complete resolver decision trace for auditability.
   */
  private buildTrace(
    queryClass: QueryClass,
    calibrated: CalibratedResolutionScore,
    ambiguity: AmbiguityState,
    thresholds: ThresholdEntry,
    reasonCodes: readonly string[],
  ): ResolverDecisionTrace {
    return {
      queryClass,
      top1CalibratedScore: calibrated.top1CalibratedScore,
      top2CalibratedScore: calibrated.top2CalibratedScore,
      calibratedGap: calibrated.calibratedGap,
      decisionConfidenceC: calibrated.decisionConfidenceC,
      ambiguityDetected: ambiguity.detected,
      ambiguityTypes: ambiguity.types,
      appliedThresholds: {
        resolveThreshold: thresholds.resolveTau,
        gapThreshold: thresholds.gapTau,
      },
      outcomeReasonCodes: reasonCodes,
    };
  }
}
