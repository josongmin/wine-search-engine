import type { DecisionStatus, NextAction, QueryClass } from '../../shared/types/index.js';
import type { QueryPolicy } from '../../query/model/query-policy.js';
import type { QueryUncertainty } from '../../query/model/query-uncertainty.js';
import type { NormalizedQueryViews } from '../../query/model/query-views.js';
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
import type {
  LearnedMatcherContext,
  LearnedMatcherOutput,
  LearnedMatcherPort,
} from '../port/learned-matcher.port.js';
import { computeMatcherFeatures } from './learned-matcher-features.js';
import type { MatcherFeatureVector } from './learned-matcher-features.js';

/**
 * Input required to run the entity resolution pipeline.
 */
export interface ResolverInput {
  /** The original user query string. */
  readonly rawQuery: string;

  /** Lowercased, accent-stripped, whitespace-collapsed form. */
  readonly normalizedQuery: string;

  /** Multi-view query normalization snapshot for noisy lookup debugging. */
  readonly normalizedQueryViews?: NormalizedQueryViews | undefined;

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
 *
 * At alpha = 0.3 the prediction set has at least 70 % marginal coverage.
 * This means: resolve when C ≥ 0.7, ambiguous when C ≥ 0.4.
 *
 * Previous value (0.1) required C ≥ 0.9 for resolution, causing 96%
 * avoidable abstention because most queries achieved C in [0.70, 0.85].
 * The conformal gate was stricter than T_resolve itself, making the
 * per-class thresholds meaningless.
 *
 * Value should be tuned via AURC on the gate eval set (RFC-009 §5.3).
 */
export const DEFAULT_ALPHA = 0.3;

const LOOKUP_STRATEGY_SCORE_WEIGHTS = {
  exact: 0.06,
  lexical_exact: 0.05,
  compact_exact: 0.04,
  transliterated_exact: 0.05,
  phonetic_exact: 0.045,
  fuzzy_char_ngram: 0.025,
  transliterated_fuzzy: 0.03,
  phonetic_fuzzy: 0.03,
  substring: -0.015,
  smart_document: -0.02,
} as const;

type LookupStrategy = keyof typeof LOOKUP_STRATEGY_SCORE_WEIGHTS;

interface LookupStrategyAdjustment {
  readonly entityId: string;
  readonly strategies: readonly string[];
  readonly rawScoreDelta: number;
}

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
    private readonly learnedMatcher?: LearnedMatcherPort,
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
    const lookupStrategyAdjustments = this.collectLookupStrategyAdjustments(input);
    const adjustedScored = this.applyLookupStrategyAdjustments(scored, lookupStrategyAdjustments);

    // Step 2.5: Optionally blend learned match probabilities (RFC-006 §5.2)
    let blendedScored = adjustedScored;
    let learnedMatcherOutputs: readonly LearnedMatcherOutput[] | undefined;
    if (this.learnedMatcher !== undefined && adjustedScored.length > 0) {
      try {
        const blended = await this.applyLearnedMatcherBlend(
          input.rawQuery,
          input,
          candidates,
          adjustedScored,
        );
        blendedScored = blended.scored;
        learnedMatcherOutputs = blended.learnedOutputs;
      } catch {
        blendedScored = adjustedScored;
      }
    }

    // Step 3: Sort by raw score descending
    blendedScored.sort((a, b) => b.rawScore - a.rawScore);

    // Step 4: Calibrate top scores
    const top1RawScore = blendedScored[0]?.rawScore ?? 0;
    const top2RawScore = blendedScored[1]?.rawScore ?? 0;

    const calibrated = await this.calibrator.calibrate(
      { top1: top1RawScore, top2: top2RawScore },
      input.queryClass,
    );

    // Step 5: Classify ambiguity
    const sortedCandidates = blendedScored.map((s) => s.candidate);
    const ambiguityState = this.ambiguityClassifier.classify(
      sortedCandidates,
      input.queryClass,
    );

    // Step 6: Apply decision boundary
    const thresholds = this.getThresholds(input.queryClass);
    const { status, nextAction, reasonCodes } = this.applyDecisionBoundary(
      input,
      calibrated,
      ambiguityState,
      thresholds,
    );

    // Step 7: Build result
    const resolvedCandidates = this.buildResolvedCandidates(blendedScored, calibrated);
    const topCandidate = resolvedCandidates[0];

    const trace = this.buildTrace(
      input,
      input.queryClass,
      calibrated,
      ambiguityState,
      thresholds,
      reasonCodes,
      lookupStrategyAdjustments,
      learnedMatcherOutputs,
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
    input: ResolverInput,
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

    if (this.shouldConservativelyClarifyNoisyShortForm(input, ambiguity)) {
      reasonCodes.push('NOISY_SHORT_FORM_REQUIRE_CLARIFICATION');
      return { status: 'ambiguous', nextAction: 'clarify', reasonCodes };
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

  private shouldConservativelyClarifyNoisyShortForm(
    input: ResolverInput,
    ambiguity: AmbiguityState,
  ): boolean {
    if (input.queryClass !== 'short_entity' && input.queryClass !== 'ambiguous_short_form') {
      return false;
    }

    const strategies = this.collectAnchorLookupStrategies(input.anchorCandidates);
    const hasNoisyLookup =
      strategies.includes('compact_exact') ||
      strategies.includes('fuzzy_char_ngram') ||
      strategies.includes('transliterated_fuzzy') ||
      strategies.includes('substring');

    if (!hasNoisyLookup) {
      return false;
    }

    return ambiguity.detected || input.anchorCandidates.length !== 1;
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
   * Blends learned match probabilities (RFC-006 §5.2) into raw scores.
   *
   * Weighting: 60 % heuristic raw score + 40 % model match probability.
   * Candidates without a learned score retain their original raw score.
   */
  private async applyLearnedMatcherBlend(
    query: string,
    input: ResolverInput,
    candidates: readonly ResolverCandidate[],
    scored: Array<{ candidate: ResolverCandidate; rawScore: number }>,
  ): Promise<{
    scored: Array<{ candidate: ResolverCandidate; rawScore: number }>;
    learnedOutputs: readonly LearnedMatcherOutput[];
  }> {
    const learnedOutputs = await this.learnedMatcher!.match(
      query,
      candidates,
      this.buildLearnedMatcherContext(input, candidates),
    );
    const probMap = new Map(
      learnedOutputs.map((o) => [String(o.entityId), o.matchProbability]),
    );

    const next = scored.map((entry) => {
      const prob = probMap.get(String(entry.candidate.entityId));
      if (prob === undefined) return entry;
      return { candidate: entry.candidate, rawScore: 0.6 * entry.rawScore + 0.4 * prob };
    });
    return { scored: next, learnedOutputs };
  }

  private buildLearnedMatcherContext(
    input: ResolverInput,
    candidates?: readonly ResolverCandidate[],
  ): LearnedMatcherContext | undefined {
    const anchorLookupVariants = this.collectAnchorLookupVariants(input.anchorCandidates);
    const anchorLookupStrategies = this.collectAnchorLookupStrategies(input.anchorCandidates);

    // Compute per-candidate feature vectors for the learned matcher (Step 18.5)
    const candidateFeatures = new Map<string, MatcherFeatureVector>();
    if (candidates !== undefined) {
      const topN = candidates.slice(0, 10);
      for (const candidate of topN) {
        const vintage =
          candidate.attributeHints?.['vintage'] !== undefined
            ? Number(candidate.attributeHints['vintage'])
            : undefined;
        const features = computeMatcherFeatures(
          input.normalizedQuery,
          candidate.canonicalLabel,
          vintage,
        );
        candidateFeatures.set(String(candidate.entityId), {
          ...features,
          provenanceStage:
            (anchorLookupStrategies.length > 0 ? anchorLookupStrategies[0] : undefined) ?? 'unknown',
        });
      }
    }

    if (
      input.normalizedQueryViews === undefined &&
      anchorLookupVariants.length === 0 &&
      anchorLookupStrategies.length === 0 &&
      candidateFeatures.size === 0
    ) {
      return undefined;
    }

    return {
      queryClass: input.queryClass,
      ...(input.normalizedQueryViews !== undefined
        ? { normalizedQueryViews: input.normalizedQueryViews }
        : {}),
      ...(anchorLookupVariants.length > 0 ? { anchorLookupVariants } : {}),
      ...(anchorLookupStrategies.length > 0 ? { anchorLookupStrategies } : {}),
      ...(candidateFeatures.size > 0 ? { candidateFeatures } : {}),
    };
  }

  /**
   * Builds a complete resolver decision trace for auditability.
   */
  private buildTrace(
    input: ResolverInput,
    queryClass: QueryClass,
    calibrated: CalibratedResolutionScore,
    ambiguity: AmbiguityState,
    thresholds: ThresholdEntry,
    reasonCodes: readonly string[],
    lookupStrategyAdjustments: readonly LookupStrategyAdjustment[],
    learnedOutputs?: readonly LearnedMatcherOutput[],
  ): ResolverDecisionTrace {
    const anchorLookupVariants = this.collectAnchorLookupVariants(input.anchorCandidates);
    const anchorLookupStrategies = this.collectAnchorLookupStrategies(input.anchorCandidates);
    const queryProvenance =
      input.normalizedQueryViews !== undefined ||
      anchorLookupVariants.length > 0 ||
      anchorLookupStrategies.length > 0 ||
      lookupStrategyAdjustments.length > 0
        ? {
            ...(input.normalizedQueryViews !== undefined
              ? { normalizedQueryViews: input.normalizedQueryViews }
              : {}),
            ...(anchorLookupVariants.length > 0
              ? { anchorLookupVariants }
              : {}),
            ...(anchorLookupStrategies.length > 0
              ? { anchorLookupStrategies }
              : {}),
            ...(lookupStrategyAdjustments.length > 0
              ? { lookupStrategyAdjustments }
              : {}),
          }
        : undefined;

    const learnedMatcherTrace =
      learnedOutputs !== undefined && learnedOutputs.length > 0
        ? {
            modelId: learnedOutputs[0]!.modelId,
            modelVersion: learnedOutputs[0]!.modelVersion,
            candidates: learnedOutputs.map((o) => ({
              entityId: String(o.entityId),
              matchProbability: o.matchProbability,
              ...(o.matchSignalVector !== undefined ? { matchSignalVector: o.matchSignalVector } : {}),
            })),
          }
        : undefined;

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
      ...(queryProvenance !== undefined ? { queryProvenance } : {}),
      ...(learnedMatcherTrace !== undefined ? { learnedMatcherTrace } : {}),
    };
  }

  private collectAnchorLookupVariants(anchors: readonly AnchorCandidate[]): readonly string[] {
    const variants = new Set<string>();
    for (const anchor of anchors) {
      for (const variant of anchor.lookupVariants ?? []) {
        if (variant.length > 0) {
          variants.add(variant);
        }
      }
    }

    return [...variants].sort();
  }

  private collectAnchorLookupStrategies(anchors: readonly AnchorCandidate[]): readonly string[] {
    const strategies = new Set<string>();
    for (const anchor of anchors) {
      for (const strategy of anchor.lookupStrategies ?? []) {
        if (strategy.length > 0) {
          strategies.add(strategy);
        }
      }
    }

    return [...strategies].sort();
  }

  private collectLookupStrategyAdjustments(
    input: ResolverInput,
  ): readonly LookupStrategyAdjustment[] {
    const byEntity = new Map<string, Set<string>>();

    for (const anchor of input.anchorCandidates) {
      const strategies = anchor.lookupStrategies ?? [];
      if (strategies.length === 0) {
        continue;
      }

      for (const entityId of anchor.candidateEntityIds) {
        const key = String(entityId);
        const existing = byEntity.get(key) ?? new Set<string>();
        for (const strategy of strategies) {
          if (strategy.length > 0) {
            existing.add(strategy);
          }
        }
        byEntity.set(key, existing);
      }
    }

    return [...byEntity.entries()]
      .map(([entityId, strategies]) => {
        const strategyList = [...strategies].sort();
        const rawScoreDelta = this.computeLookupStrategyAdjustment(
          strategyList,
          input.queryClass,
        );
        return {
          entityId,
          strategies: strategyList,
          rawScoreDelta,
        };
      })
      .filter((entry) => entry.rawScoreDelta !== 0);
  }

  private applyLookupStrategyAdjustments(
    scored: readonly { candidate: ResolverCandidate; rawScore: number }[],
    adjustments: readonly LookupStrategyAdjustment[],
  ): Array<{ candidate: ResolverCandidate; rawScore: number }> {
    if (adjustments.length === 0) {
      return [...scored];
    }

    const deltaByEntity = new Map(
      adjustments.map((entry) => [entry.entityId, entry.rawScoreDelta]),
    );

    return scored.map((entry) => ({
      candidate: entry.candidate,
      rawScore: entry.rawScore + (deltaByEntity.get(String(entry.candidate.entityId)) ?? 0),
    }));
  }

  private computeLookupStrategyAdjustment(
    strategies: readonly string[],
    queryClass: QueryClass,
  ): number {
    let delta = 0;
    for (const strategy of strategies) {
      if (this.isLookupStrategy(strategy)) {
        delta += LOOKUP_STRATEGY_SCORE_WEIGHTS[strategy];
      }
    }

    if (delta === 0) {
      return 0;
    }

    const isShortForm =
      queryClass === 'short_entity' || queryClass === 'ambiguous_short_form';
    const hasOnlyNoisySupport = strategies.every(
      (strategy) =>
        strategy !== 'exact' &&
        strategy !== 'lexical_exact' &&
        strategy !== 'compact_exact' &&
        strategy !== 'transliterated_exact' &&
        strategy !== 'phonetic_exact',
    );

    if (isShortForm && hasOnlyNoisySupport && delta > 0) {
      return Math.min(delta, 0.01);
    }

    return Number(delta.toFixed(4));
  }

  private isLookupStrategy(strategy: string): strategy is LookupStrategy {
    return strategy in LOOKUP_STRATEGY_SCORE_WEIGHTS;
  }
}
