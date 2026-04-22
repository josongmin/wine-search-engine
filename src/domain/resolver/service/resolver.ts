import type { DecisionStatus, NextAction, QueryClass } from '../../shared/types/index.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import type { QueryPolicy } from '../../query/model/query-policy.js';
import type { QueryUncertainty } from '../../query/model/query-uncertainty.js';
import type { NormalizedQueryViews } from '../../query/model/query-views.js';
import type { AnchorCandidate } from '../../query/model/anchor-candidate.js';
import type { ThresholdEntry } from '../../query/model/threshold-profile.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../query/model/threshold-profile.js';
import { hasExactLikeLookupStrategy } from '../../query/service/lookup-strategy-taxonomy.js';
import type { EntityResolveResult } from '../model/resolve-result.js';
import type { ResolvedCandidate, ResolverCandidate } from '../model/resolved-candidate.js';
import type { ResolverDecisionTrace, ResolverCandidateTrace } from '../model/decision-trace.js';
import type { EntityCandidateSource } from '../model/entity-candidate-generator-input.js';
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
import { CONFORMAL_ALPHA } from '../../shared/config/conformal-config.js';
import { CORRECTIVE_RETRY_CONFIDENCE_THRESHOLD as RESOLVER_CORRECTIVE_RETRY_CONFIDENCE_THRESHOLD } from '../model/corrective-retry-thresholds.js';

/** Valid conformal alpha interval is (0, this upper bound]. */
const CONFORMAL_ALPHA_MAX_EXCLUSIVE = 0.5;
/** Blend resolver raw score with learned match probability. */
const LEARNED_MATCH_RAW_SCORE_BLEND = 0.6;
const LEARNED_MATCH_PROBABILITY_BLEND = 0.4;
/** Cap confidence gap for short-form queries with only noisy lookup support. */
const SHORT_FORM_NOISY_SUPPORT_GAP_CAP = 0.01;
/** Decimal places when serializing gap for traces. */
const RESOLVER_GAP_TRACE_DECIMAL_PLACES = 4;

function classifyLearnedMatcherFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('timed out')
    ? 'learned_matcher_timeout'
    : 'learned_matcher_failed';
}

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

  /**
   * TA2-4: Blocker-seeded candidates — entities returned by `Blocker.block()`
   * that were NOT already covered by any anchor's `candidateEntityIds`.
   *
   * These carry zero-filled signal sets (`ZERO_SIGNALS`) and `source:
   * 'blocker_seed'`. They enter the scorer's attribute-hint pathway.
   *
   * Produced upstream by `buildResolverCandidatesFromGenerator()` when
   * the caller supplies `blockerOnlyIds`.  If undefined (not yet wired),
   * the pipeline falls back to the current anchors-only behaviour.
   */
  readonly blockerSeedCandidates?: readonly ResolverCandidate[] | undefined;
}

/**
 * Default significance level (alpha) for conformal prediction.
 *
 * Imported from SSoT: src/domain/shared/config/conformal-config.ts (W2-BUG-09).
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
export const DEFAULT_ALPHA = CONFORMAL_ALPHA;

const LOOKUP_STRATEGY_SCORE_WEIGHTS = {
  exact: 0.06,
  lexical_exact: 0.05,
  compact_exact: 0.04,
  transliterated_exact: 0.05,
  prefix_exact: 0.05,
  transliterated_prefix: 0.05,
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
  if (alpha <= 0 || alpha > CONFORMAL_ALPHA_MAX_EXCLUSIVE) {
    throw new RangeError(`computeConformalSetSize: alpha must be in (0, 0.5], got ${alpha}`);
  }
  if (k < 0) {
    throw new RangeError(`computeConformalSetSize: k must be >= 0, got ${k}`);
  }
  if (!Number.isFinite(calibratedScore) || calibratedScore < 0 || calibratedScore > 1) {
    throw new RangeError(
      `computeConformalSetSize: calibratedScore must be finite and in [0, 1], got ${calibratedScore}`,
    );
  }

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

    // TA2-4: Merge pre-loaded candidates with blocker-seeded candidates.
    // Both pools are filtered to IDs that survived blocking (recall gate).
    //
    // Blocker-seeded candidates (source: 'blocker_seed') carry zero-filled
    // signal sets. They enter the scorer's attribute-hint pathway and
    // receive proportional calibrated scores in buildResolvedCandidates().
    // This promotes the blocker's high-recall recall output from a filter
    // to a hydrate-able seed — fixing the "invisible entity" failure mode
    // where the blocker found the correct wine but alias lookup missed it.
    const blockedIdSet = new Set(blockedIds.map(String));
    const allInputCandidates = [
      ...input.candidateEntities,
      ...(input.blockerSeedCandidates ?? []),
    ];
    // Deduplicate: if a candidate ID appears in both pools, prefer the one
    // from candidateEntities (full signals) over the blocker seed (zero signals).
    const seenInMerge = new Set<string>();
    const mergedCandidates: typeof allInputCandidates = [];
    for (const c of allInputCandidates) {
      const key = String(c.entityId);
      if (!seenInMerge.has(key)) {
        seenInMerge.add(key);
        mergedCandidates.push(c);
      }
    }
    const candidates = mergedCandidates.filter(
      (c) => blockedIdSet.has(String(c.entityId)),
    );

    // Step 2: Score each candidate
    const scored = candidates.map((candidate) => ({
      candidate,
      rawScore: this.candidateScorer.score(candidate),
    }));
    const lookupStrategyAdjustments = this.collectLookupStrategyAdjustments(input);
    const adjustedScored = this.applyLookupStrategyAdjustments(scored, lookupStrategyAdjustments);

    // Step 2.5: Optionally blend learned match probabilities (RFC-006 §5.2).
    //
    // C3 (fail-loud): a learned-matcher failure is NOT equivalent to the
    // matcher being absent. When the matcher is configured but fails, we
    // flag `learnedMatcherDegraded` so the boundary logic can downgrade
    // "resolved" to "ambiguous" instead of silently proceeding with
    // adjusted-only scores. This is a structural signal, not a log line.
    let blendedScored = adjustedScored;
    let learnedMatcherOutputs: readonly LearnedMatcherOutput[] | undefined;
    let learnedMatcherDegraded = false;
    const degradationReasons = new Set<string>();
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
      } catch (error) {
        blendedScored = adjustedScored;
        learnedMatcherDegraded = true;
        degradationReasons.add(classifyLearnedMatcherFailureReason(error));
      }
    }

    // Step 3: Sort by raw score descending.
    // Tiebreak on entityId string to guarantee a stable, deterministic order
    // when two candidates share identical raw scores (e.g. vintage siblings
    // "Opus One 2018" vs "Opus One 2019" matched by the same alias signals).
    blendedScored.sort((a, b) => {
      const scoreDiff = b.rawScore - a.rawScore;
      if (scoreDiff !== 0) return scoreDiff;
      return String(a.candidate.entityId).localeCompare(String(b.candidate.entityId));
    });

    // Step 4: Calibrate top scores.
    //
    // C2 (fail-loud): runner-up absence is structurally distinct from
    // "runner-up scored 0". A singleton → top2 undefined → calibratedGap
    // undefined. Downstream boundary logic MUST branch on hasRunnerUp
    // rather than reading a synthetic 0 gap.
    //
    // Zero-candidate early return: the blocker legitimately returns an
    // empty set for many production queries (e.g. gibberish, out-of-domain
    // searches). Calling calibrate() with zero candidates is a contract
    // violation — but it is NOT an invariant violation at the resolver
    // boundary. Surface a 'failed' suggestion with empty candidates and let
    // the decision engine decide how to respond (typically NOT_FOUND).
    const top1Entry = blendedScored[0];
    if (top1Entry === undefined) {
      const emptyThresholds = this.getThresholds(input.queryClass);
      const emptyTrace: ResolverDecisionTrace = {
        queryClass: input.queryClass,
        top1CalibratedScore: 0,
        top2CalibratedScore: undefined,
        calibratedGap: undefined,
        decisionConfidenceC: 0,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: {
          resolveThreshold: emptyThresholds.resolveTau,
          gapThreshold: emptyThresholds.gapTau,
        },
        // C2 diagnostic gap fix: distinguish "learned matcher broke us" from
        // "blocking naturally returned zero" so ops can root-cause the empty
        // result without reading degradation.reasons separately.
        outcomeReasonCodes: learnedMatcherDegraded
          ? ['NO_CANDIDATES_AFTER_BLOCKING', 'LEARNED_MATCHER_DEGRADED']
          : ['NO_CANDIDATES_AFTER_BLOCKING'],
      };
      const emptyResult: EntityResolveResult = {
        status: 'failed',
        recommendedNextAction: 'fail',
        decisionConfidenceC: 0,
        candidates: [],
        ...(learnedMatcherDegraded
          ? { degradation: { reasons: [...degradationReasons] } }
          : {}),
        decisionTrace: emptyTrace,
        conformalSetSize: 0,
      };
      return emptyResult;
    }
    const top2Entry = blendedScored[1];
    const calibrated = await this.calibrator.calibrate(
      {
        top1: top1Entry.rawScore,
        top2: top2Entry?.rawScore,
        candidateCount: blendedScored.length,
      },
      input.queryClass,
    );

    // Step 5: Classify ambiguity
    const sortedCandidates = blendedScored.map((s) => s.candidate);
    const ambiguityState = this.ambiguityClassifier.classify(
      sortedCandidates,
      input.queryClass,
    );

    // Step 5.5: Singleton candidate fast-path.
    // Only bypass multi-candidate ambiguity/gap logic when the singleton
    // already clears the calibrated resolve threshold AND the learned
    // matcher did not degrade. C3: a degraded learned matcher must never
    // short-circuit to "resolved" via the singleton path.
    const thresholds = this.getThresholds(input.queryClass);
    const singletonBypass = !learnedMatcherDegraded
      && blendedScored.length === 1
      && calibrated.decisionConfidenceC >= thresholds.resolveTau;

    // Step 6: Apply decision boundary
    const { status, nextAction, reasonCodes } = singletonBypass
      ? {
          status: 'resolved' as const,
          nextAction: 'return_result' as const,
          reasonCodes: ['SINGLETON_BYPASS_RESOLVED'],
        }
      : this.applyDecisionBoundary(
          input,
          calibrated,
          ambiguityState,
          thresholds,
          learnedMatcherDegraded,
        );

    // Step 7: Build result
    const resolvedCandidates = this.buildResolvedCandidates(
      blendedScored,
      calibrated,
      status,
      singletonBypass,
    );
    const topCandidate = resolvedCandidates[0];

    const trace = this.buildTrace(
      input,
      candidates,
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
      ...(degradationReasons.size > 0
        ? { degradation: { reasons: [...degradationReasons] } }
        : {}),
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

    // Invariant R1: singleton candidate must never be dropped.
    // Invariant R3: ranked_count === 0 only if candidate_count === 0.
    if (blendedScored.length > 0 && resolvedCandidates.length === 0) {
      bootstrapLogger.error(
        {
          candidateCount: blendedScored.length,
          rankedCount: resolvedCandidates.length,
          status,
          reasonCodes,
          queryClass: input.queryClass,
          topRawScore: blendedScored[0]?.rawScore,
          calibratedC: calibrated.decisionConfidenceC,
        },
        '[Resolver] INVARIANT VIOLATION: candidates scored but none ranked — potential drop bug',
      );
    }

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
    learnedMatcherDegraded = false,
  ): { status: DecisionStatus; nextAction: NextAction; reasonCodes: string[] } {
    const reasonCodes: string[] = [];

    const cMeetsThreshold = calibrated.decisionConfidenceC >= thresholds.resolveTau;
    // C2 (fail-loud): when there is no runner-up, the gap is meaningless.
    // Treat gap-threshold as "not applicable" rather than silently reading
    // a synthetic 0 gap. Singletons below the confidence threshold still
    // flow to corrective retry / failed paths below.
    const gapMeetsThreshold = calibrated.hasRunnerUp
      ? (calibrated.calibratedGap ?? 0) >= thresholds.gapTau
      : true;
    const isAmbiguous = ambiguity.detected;

    if (cMeetsThreshold) {
      reasonCodes.push('CONFIDENCE_ABOVE_THRESHOLD');
    } else {
      reasonCodes.push('CONFIDENCE_BELOW_THRESHOLD');
    }

    if (!calibrated.hasRunnerUp) {
      reasonCodes.push('NO_RUNNER_UP_GAP_NOT_APPLICABLE');
    } else if (gapMeetsThreshold) {
      reasonCodes.push('GAP_ABOVE_THRESHOLD');
    } else {
      reasonCodes.push('GAP_BELOW_THRESHOLD');
    }

    // C3 (fail-loud): a configured-but-failed learned matcher cannot produce
    // "resolved". Downgrade to ambiguous/clarify so operators see the
    // degradation instead of serving a decision made on unblended scores.
    if (learnedMatcherDegraded) {
      reasonCodes.push('LEARNED_MATCHER_DEGRADED_NO_RESOLVE');
      return { status: 'ambiguous', nextAction: 'clarify', reasonCodes };
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

    // Low confidence, no ambiguity detected — check whether corrective retry
    // is warranted (TA3-1): zero anchors OR confidence below retry threshold.
    //
    // corrective_retry takes precedence over hybrid_search: it is a targeted
    // exact-recovery retry, not a broad fallback. The application layer
    // (executeEntityRoute) honours this recommendation to run Pass 2.
    const zeroAnchors = input.anchorCandidates.length === 0;
    const rawConfidence = calibrated.decisionConfidenceC;
    const confidenceFinite = Number.isFinite(rawConfidence) ? rawConfidence : 0;
    const belowRetryThreshold = confidenceFinite < RESOLVER_CORRECTIVE_RETRY_CONFIDENCE_THRESHOLD;

    if (zeroAnchors || belowRetryThreshold) {
      reasonCodes.push('CORRECTIVE_RETRY_WARRANTED');
      return { status: 'failed', nextAction: 'corrective_retry', reasonCodes };
    }

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
    if (
      input.queryClass !== 'exact_entity' &&
      input.queryClass !== 'short_entity' &&
      input.queryClass !== 'ambiguous_short_form'
    ) {
      return false;
    }

    const strategies = this.collectAnchorLookupStrategies(input.anchorCandidates);
    const hasNoisyLookup =
      strategies.includes('compact_exact') ||
      strategies.includes('fuzzy_char_ngram') ||
      strategies.includes('transliterated_fuzzy') ||
      strategies.includes('substring');

    if (!hasNoisyLookup || hasExactLikeLookupStrategy(strategies)) {
      return false;
    }

    // Use unique entity count, not anchor count. Multiple aliases for the
    // same entity (e.g. "Kalaris" + "Kalaris Merlot" → same wine-ce-...)
    // should NOT trigger conservative clarification.
    const uniqueAnchorEntityCount = new Set(
      input.anchorCandidates.flatMap((a) => a.candidateEntityIds),
    ).size;
    return ambiguity.detected || uniqueAnchorEntityCount !== 1;
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
    status: DecisionStatus,
    singletonBypass: boolean,
  ): readonly ResolvedCandidate[] {
    return scored.map((entry, index) => {
      // The top-1 and top-2 get their calibrated scores; others get
      // linearly interpolated estimates relative to their raw scores.
      let calibratedScore: number;
      if (index === 0) {
        calibratedScore = calibrated.top1CalibratedScore;
      } else if (index === 1) {
        // C2: structural invariant — if we are at index 1 we DO have a
        // runner-up, so top2CalibratedScore must be defined. A missing value
        // here is a contract violation (calibrator lost track of runnerup).
        if (calibrated.top2CalibratedScore === undefined) {
          throw new Error(
            'Resolver invariant: calibrated.top2CalibratedScore is undefined but scored array has index 1 — calibrator/resolver contract violated.',
          );
        }
        calibratedScore = calibrated.top2CalibratedScore;
      } else {
        // For candidates beyond top-2, estimate by proportional scaling
        const top1Raw = scored[0]?.rawScore ?? 1;
        const ratio = top1Raw > 0 ? entry.rawScore / top1Raw : 0;
        calibratedScore = Math.max(0, calibrated.top1CalibratedScore * ratio);
      }

      const candidateSources = this.collectCandidateSources(entry.candidate);
      const primarySource = candidateSources[0] ?? 'alias';

      // T-E4-02: Per-candidate structured trace
      const candidateTrace = this.buildCandidateTrace(
        entry.rawScore,
        calibratedScore,
        index,
        scored.length,
        status,
        singletonBypass,
        primarySource,
      );

      return {
        entityId: entry.candidate.entityId,
        canonicalLabel: entry.candidate.canonicalLabel,
        calibratedScore,
        rank: index + 1,
        evidenceRefs: entry.candidate.aliasMatches.map((m) => m.aliasValue),
        ...(candidateSources.length === 1 ? { source: candidateSources[0] } : {}),
        ...(candidateSources.length > 0 ? { sources: candidateSources } : {}),
        // TA2-4: Propagate blocker seed provenance so callers can tag traces.
        ...(candidateSources.includes('blocker_seed')
          ? { blockerSeed: true as const }
          : {}),
        trace: candidateTrace,
      };
    });
  }

  /**
   * T-E4-02: Builds per-candidate trace with score/calibration/boundary state.
   *
   * The boundary decision is derived from the candidate's rank and the overall
   * resolver status:
   * - `singleton`: only one candidate existed and it passed the singleton bypass
   * - `admitted`: rank-1 candidate that was resolved (or all candidates when ambiguous)
   * - `rejected`: non-top candidate in a resolved outcome (resolver chose a different entity)
   */
  private buildCandidateTrace(
    rawScore: number,
    calibratedConfidence: number,
    index: number,
    totalCandidates: number,
    status: DecisionStatus,
    singletonBypass: boolean,
    matchSource: EntityCandidateSource,
  ): ResolverCandidateTrace {
    const boundaryDecision = this.classifyBoundaryDecision(
      index,
      totalCandidates,
      status,
      singletonBypass,
    );

    const admissionGateReason = boundaryDecision === 'rejected'
      ? (status === 'resolved'
        ? 'outranked_by_top_candidate'
        : 'below_decision_boundary')
      : undefined;

    return {
      score: rawScore,
      calibratedConfidence,
      boundaryDecision,
      ...(admissionGateReason !== undefined ? { admissionGateReason } : {}),
      matchSource,
    };
  }

  /**
   * Classifies the boundary decision for a single candidate.
   */
  private classifyBoundaryDecision(
    index: number,
    totalCandidates: number,
    status: DecisionStatus,
    singletonBypass: boolean,
  ): ResolverCandidateTrace['boundaryDecision'] {
    // Single candidate that passed the singleton bypass gate
    if (totalCandidates === 1 && singletonBypass) {
      return 'singleton';
    }

    // Top candidate in a resolved outcome
    if (index === 0 && status === 'resolved') {
      return 'admitted';
    }

    // Non-resolved outcomes: all candidates are admitted (ambiguous / failed
    // status means the resolver did not select a single winner)
    if (status !== 'resolved') {
      return 'admitted';
    }

    // Non-top candidate in a resolved outcome — resolver chose someone else
    return 'rejected';
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
      return {
        candidate: entry.candidate,
        rawScore: LEARNED_MATCH_RAW_SCORE_BLEND * entry.rawScore + LEARNED_MATCH_PROBABILITY_BLEND * prob,
      };
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
        const vintageRaw =
          candidate.attributeHints?.['vintage'] !== undefined
            ? Number(candidate.attributeHints['vintage'])
            : undefined;
        const vintage = vintageRaw !== undefined && Number.isFinite(vintageRaw) ? vintageRaw : undefined;
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
    candidates: readonly ResolverCandidate[],
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
    const blockerSeedEntityIds = this.collectBlockerSeedEntityIds(candidates);
    const candidateSourceBreakdown = this.collectCandidateSourceBreakdown(candidates);
    const queryProvenance =
      input.normalizedQueryViews !== undefined ||
      anchorLookupVariants.length > 0 ||
      anchorLookupStrategies.length > 0 ||
      lookupStrategyAdjustments.length > 0 ||
      blockerSeedEntityIds.length > 0 ||
      candidateSourceBreakdown.length > 0
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
            ...(blockerSeedEntityIds.length > 0
              ? {
                  blockerSeedEntityIds,
                  blockerSeedCount: blockerSeedEntityIds.length,
                }
              : {}),
            ...(candidateSourceBreakdown.length > 0
              ? { candidateSourceBreakdown }
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

  private collectBlockerSeedEntityIds(
    candidates: readonly ResolverCandidate[],
  ): readonly string[] {
    const blockerSeedEntityIds = new Set<string>();
    for (const candidate of candidates) {
      if (this.collectCandidateSources(candidate).includes('blocker_seed')) {
        blockerSeedEntityIds.add(String(candidate.entityId));
      }
    }

    return [...blockerSeedEntityIds].sort();
  }

  private collectCandidateSourceBreakdown(
    candidates: readonly ResolverCandidate[],
  ): readonly {
    readonly source: EntityCandidateSource;
    readonly entityIds: readonly string[];
    readonly count: number;
  }[] {
    const bySource = new Map<EntityCandidateSource, Set<string>>();
    for (const candidate of candidates) {
      for (const source of this.collectCandidateSources(candidate)) {
        const entityIds = bySource.get(source) ?? new Set<string>();
        entityIds.add(String(candidate.entityId));
        bySource.set(source, entityIds);
      }
    }

    const sourceOrder: readonly EntityCandidateSource[] = [
      'alias',
      'planner_heuristic',
      'entity_lookup',
      'blocker_seed',
    ];

    return sourceOrder
      .filter((source) => bySource.has(source))
      .map((source) => {
        const entityIds = [...(bySource.get(source) ?? new Set<string>())].sort();
        return {
          source,
          entityIds,
          count: entityIds.length,
        };
      });
  }

  private collectCandidateSources(
    candidate: Pick<ResolverCandidate, 'source' | 'sources'>,
  ): readonly EntityCandidateSource[] {
    const combined = new Set<EntityCandidateSource>();
    for (const source of candidate.sources ?? []) {
      combined.add(source);
    }
    if (candidate.source !== undefined) {
      combined.add(candidate.source);
    }
    return [...combined].sort();
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
      queryClass === 'exact_entity' ||
      queryClass === 'short_entity' ||
      queryClass === 'ambiguous_short_form';
    const hasOnlyNoisySupport = !hasExactLikeLookupStrategy(strategies);

    if (isShortForm && hasOnlyNoisySupport && delta > 0) {
      return Math.min(delta, SHORT_FORM_NOISY_SUPPORT_GAP_CAP);
    }

    return Number(delta.toFixed(RESOLVER_GAP_TRACE_DECIMAL_PLACES));
  }

  private isLookupStrategy(strategy: string): strategy is LookupStrategy {
    return strategy in LOOKUP_STRATEGY_SCORE_WEIGHTS;
  }
}
