import { type QueryClass, liftBundleToAtoms } from '../../shared/types/index.js';
import type { RankingInput } from '../model/ranking-input.js';
import type { RankedResult, CoarsePruneStageSummary } from '../model/ranked-result.js';
import type { RankerRuntimeSignal } from '../model/ranking-runtime-signal.js';
import type {
  RankingMetadata,
  RankingOutput,
  RerankDecision,
  RerankDecisionCode,
} from '../port/ranker.port.js';
import type { RerankerPort } from '../port/reranker.port.js';
import type { WineAttributeEncoderPort } from '../port/wine-attribute-encoder.port.js';
import type { QueryClassWeights } from '../index.js';
import {
  resolveWeights,
  resolveChannelAwareWeights,
  applySituationIntentWeightOverlay,
  sumNonPenaltyWeights,
} from '../model/scoring-weights.js';
import type { ScoringWeights } from '../model/scoring-weights.js';
import { containsHangul } from '../../shared/utils/hangul.js';
import { getModeWeights, applyModeWeightOverlay, scaleOverlaidWeights } from '../model/mode-weights.js';
import { type SignalComputer } from './signal-computer.js';
import { type ScoreAggregator, RankComputationError } from './score-aggregator.js';
import { type EvidenceMapper } from './evidence-mapper.js';
import { WineAttributeEncoders } from './wine-attribute-encoder.js';
import { bootstrapLogger } from '../../../domain/shared/bootstrap-logger.js';
import { evaluateRerankGate } from './rerank-gate.js';
import {
  projectHybridCandidateToRankedResultAttributes,
  projectRankedResultSourceAttributes,
} from './ranked-result-attribute-projection.js';
import {
  evaluateRerankSafety,
  buildRerankSafetyListContext,
} from './rerank-safety.js';
import type { SafetyCandidateDescriptor } from './rerank-safety.js';
import type { ScoreDriftRecord } from '../model/score-decomposition.js';
import {
  type ScoredEntry,
  FINAL_SCORE_SORT_TIE_EPSILON,
  buildEvidenceQualityTier,
  buildLexicalExactnessTier,
  compareScoredEntriesByFinalScoreDesc,
} from './ranker-scored-entry.js';
import { applyCrossEncoderReranking } from './ranker-cross-encoder.js';
import {
  buildQueryConstraintContext,
  buildConstraintState,
} from './ranker-constraint-state.js';
import {
  type LtrRerankSkipReason,
  buildObservedLtrInferenceArtifact,
  applyLearnedLtrRerank,
} from './ranker-ltr-inference.js';
import { classifyRerankerFailureReason } from './ranker-failure-classifier.js';
import {
  DRIFT_MONITOR_TOP_K,
  computeKendallTauDistance,
  computeAverageRerankDelta,
} from './ranker-drift-metrics.js';

// Re-export the scored-entry surface so existing `from '.../ranker.js'` import
// paths keep resolving (ScoredEntry + comparator: regression suites;
// LtrRerankSkipReason: determinism gate type check).
export { type ScoredEntry, compareScoredEntriesByFinalScoreDesc } from './ranker-scored-entry.js';
export { type LtrRerankSkipReason } from './ranker-ltr-inference.js';

/**
 * Default number of top candidates to submit for cross-encoder reranking.
 */
const DEFAULT_RERANK_TOP_K = 20;

/** Entity IDs captured after primary sort for funnel rerank telemetry. */
const PRE_RERANK_TOP_ENTITY_SNAPSHOT_COUNT = 5;

// Degradation reason emitted when rerank scores cannot be normalized safely.
// Mirrors the constant in applyCrossEncoderReranking; used here only to
// synthesize the fallback runtime signal when the cross-encoder module reports
// a batch normalization failure without an explicit runtimeSignal.
const RERANK_SCORE_NORMALIZATION_FAILED_REASON = 'reranker_score_normalization_failed';

/** Replay-grade ranking policy version for determinism fingerprinting. */
export const RANKING_POLICY_VERSION = 'ranker-policy-v2.0';

// NON_PENALTY_WEIGHT_FIELDS / sumNonPenaltyWeights moved to the SSoT owner of
// ScoringWeights: ../model/scoring-weights.ts. Importing keeps the mode-overlay
// normalisation denominator identical to the channel-aware/situation overlays.

type RankerOptions = {
  readonly rerankTopK?: number;
  readonly rerankBlendScale?: number;
  readonly rerankThreshold?: number;
  readonly attributeEncoder?: WineAttributeEncoderPort;
  readonly reranker?: RerankerPort;
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
};

/**
 * Main ranking orchestrator (RFC-013).
 *
 * Pipeline:
 * 1. Compute all signal scores for each candidate via {@link SignalComputer}.
 * 2. Select scoring weights based on query class.
 * 3. Aggregate signals into final scores via {@link ScoreAggregator}.
 * 4. Filter out gated candidates (hard constraint / integrity failures).
 * 5. Sort by final score descending.
 * 6. Optionally rerank top-K via cross-encoder ({@link RerankerPort}).
 * 7. Map component scores to evidence items via {@link EvidenceMapper}.
 * 8. Return ordered {@link RankedResult}[].
 *
 * IMPORTANT: The ranker is a signal producer/aggregator. The final binding
 * decision is made by the Decision Layer (RFC-007). The `finalScore` in
 * ranked results is NOT a calibrated confidence C.
 */
export class Ranker {
  // doc_guard E3-U2: Ranker responsibility map
  //
  // Ranker is the authoritative ranking service for the search pipeline.
  //
  // Owns:
  //   - signal computation (via SignalComputer)
  //   - LTR reranking (via applyLearnedLtrRerank)
  //   - hard constraint filtering (coarse prune, step 4)
  //
  // Does NOT own:
  //   - retrieval          → HybridCandidateService / Vespa adapters
  //   - query planning     → ExecutionCompiler / PlannerV1
  //   - route resolution   → search-usecase-route-resolution.ts
  //   - calibration        → see E3-U6 (search-usecase-ranked-route-resolve.ts)
  //
  // applyLearnedLtrRerank() is the SSOT for LTR reranking.
  // search-usecase-ltr-rerank.ts is dead code and must not be called.
  private readonly signalComputer: SignalComputer;
  private readonly scoreAggregator: ScoreAggregator;
  private readonly evidenceMapper: EvidenceMapper;
  private readonly reranker: RerankerPort | undefined;
  private readonly attributeEncoder: WineAttributeEncoderPort;
  private readonly rerankTopK: number;
  private readonly rerankBlendScale: number;
  private readonly ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined;

  /**
   * @param signalComputer - Computes individual signal scores.
   * @param scoreAggregator - Aggregates signals into final scores.
   * @param evidenceMapper - Maps component scores to evidence items.
   * @param options - Optional ranking capabilities and tuning knobs.
   */
  constructor(
    signalComputer: SignalComputer,
    scoreAggregator: ScoreAggregator,
    evidenceMapper: EvidenceMapper,
    options: RankerOptions = {},
  ) {
    this.signalComputer = signalComputer;
    this.scoreAggregator = scoreAggregator;
    this.evidenceMapper = evidenceMapper;
    this.reranker = options.reranker;
    this.attributeEncoder = options.attributeEncoder ?? WineAttributeEncoders;
    this.rerankTopK = options.rerankTopK ?? DEFAULT_RERANK_TOP_K;
    this.rerankBlendScale = options.rerankBlendScale ?? 1;
    this.ltrModels = options.ltrModels;
  }

  /**
   * Ranks candidates according to the scoring formula and returns
   * ordered results with evidence trails.
   *
   * @param input - The ranking input containing query plan, candidates, constraints.
   * @returns Ranked results sorted by final score descending.
   */
  async rank(input: RankingInput): Promise<RankingOutput> {
    const { queryPlan, candidates, anchorProfile, constraints } = input;
    const stageTimer = input.requestContext?.stageTimer;

    // Collect metadata in local variables; returned alongside results
    // in RankingOutput (no mutable instance fields).
    let localRerankExecuted = false;
    let localRerankGateReason: string | undefined;
    let localRerankModelId: string | undefined;
    let localRerankInputCount: number | undefined;
    let localRerankOutputCount: number | undefined;
    let localRerankBlockedCount = 0;
    let localRuntimeSignal: RankerRuntimeSignal | undefined;
    let localPreRerankTop5: readonly string[] = [];
    let localScoreDriftRecord: ScoreDriftRecord | undefined;
    let localLtrSkipReason: Exclude<LtrRerankSkipReason, 'not_skipped'> | undefined;
    let localRerankDecisionCode: RerankDecisionCode | undefined;
    let localLtrSaturated = false;

    // Step 1: Compute all signals for each candidate
    const scored: ScoredEntry[] = [];

    // Step 2: Select weights based on query class, then overlay retrieval-mode
    // specific boosts and explicit situation-intent boosts from query constraints.
    // E3-U5: compiled-first — use ExecutionCompiler's resolved mode when available.
    const effectiveRetrievalMode = input.compiled.execution.effectiveRetrievalMode;
    const baseWeights = resolveWeights(queryPlan.queryClass);
    const modeProfile = getModeWeights(effectiveRetrievalMode);
    // Mode overlay: max(queryClass base, mode boost). All 12 non-penalty
    // ScoringWeights fields are overlaid via the SSoT MODE_WEIGHT_OVERLAY_MAP
    // so a new field cannot drift between mode-weights.ts and ranker.ts
    // (RCA5-04 history: hand-rolled overlay silently dropped 6 fields).
    // After overlay, re-normalise so the non-penalty sum is preserved —
    // otherwise Math.max can inflate the total (e.g. popularity 0.02→0.15
    // adds +0.13).
    const overlaid: ScoringWeights = applyModeWeightOverlay(
      baseWeights,
      modeProfile,
      effectiveRetrievalMode,
    );
    const baseSum = sumNonPenaltyWeights(baseWeights);
    const overlaidSum = sumNonPenaltyWeights(overlaid);
    // Guard: avoid division by zero when overlaidSum === 0 (all weights zero).
    // Also guard baseSum === 0 — if base weights are all zero, no normalisation is
    // possible; leave the overlaid weights unchanged (factor = 1) so downstream
    // scoring is not zeroed out or inflated to Infinity.
    const modeNormFactor =
      overlaidSum > 0 && baseSum > 0 && overlaidSum !== baseSum
        ? baseSum / overlaidSum
        : 1;
    const modeAdjustedWeights: ScoringWeights = scaleOverlaidWeights(overlaid, modeNormFactor);
    const weights: ScoringWeights = applySituationIntentWeightOverlay(
      modeAdjustedWeights,
      constraints,
      input.compiled.query.retrievalObjective,
    );

    // Pre-compute query-level signals shared across all candidates.
    const referenceYear = new Date().getFullYear();
    // SSoT Hangul detection (@domain/shared/utils/hangul). rawQuery is an
    // NFC-normalized user query, so the precomposed-syllable check
    // (U+AC00..U+D7A3) is sufficient \u2014 the prior inline regex also matched
    // bare conjoining/compatibility Jamo, but those do not occur in a
    // normalized query and the multilingual signal is a Korean-syllable signal.
    const queryContainsHangul = containsHangul(queryPlan.rawQuery);

    // Build query-level constraint context ONCE before the per-candidate loop.
    // Previously buildConstraintState() rebuilt the tracked-attribute Set and
    // inferred-attribute list for every candidate (O(n_candidates × n_constraints)
    // Sets allocated); now O(1) Set per request.
    const queryConstraintCtx = buildQueryConstraintContext(input);

    // C4 (fail-loud): accumulate `ranking_invalid_signal:<name>` reasons for
    // any candidate whose signal set contained a non-finite COMPUTED signal.
    // These flow into the ranking runtime signal's degradation list so ops
    // can identify which feature is corrupt. Candidates with invalid signals
    // are gated out (-Infinity) rather than silently served on zeroed state.
    const rankingInvalidSignalReasons = new Set<string>();

    // ADR-014 Phase 1b.3b: thread the constraint graph (when the compiled
    // query carries one) into the signal-computer so hard/soft gate
    // predicates evaluate under AND / OR / XOR root-satisfied semantics.
    // Absent graph → flat AND-all path byte-identical to pre-PR5.
    const constraintGraph = input.compiled.constraintGraph;

    stageTimer?.start('ranking.primary_scoring');
    try {
      for (const candidate of candidates) {
        const componentScores = this.signalComputer.computeAll(
          candidate,
          queryPlan,
          constraints,
          anchorProfile,
          input.retrievalPlan,
          referenceYear,
          queryContainsHangul,
          constraintGraph,
        );
        const entityPosteriorScore = this.signalComputer.computeEntityPosterior(candidate);
        const identityExactnessTier = this.signalComputer.computeIdentityExactnessTier(candidate);
        const lanePresence = this.signalComputer.computeLanePresence(candidate);
        const constraintState = buildConstraintState(candidate, queryConstraintCtx, constraintGraph);

      // Step 3: Aggregate signals into final score.
      // T5.3: Adjust weights based on which retrieval channels contributed
      // to this specific candidate, then normalise proportionally.
      const candidateWeights = resolveChannelAwareWeights(
        candidate.retrievalTrace.candidateSources,
        weights,
      );
      // C4 (fail-loud): score-aggregator throws RankComputationError when a
      // COMPUTED signal is non-finite (signal-computer bug). Convert to a
      // gated-out result (-Infinity finalScore) and record the corrupt
      // signal name on the runtime signal so ops can trace which input
      // poisoned the candidate — rather than silently zeroing the feature
      // and serving a decision made on corrupted state.
      let finalScore: number;
      try {
        finalScore = this.scoreAggregator.aggregate(
          componentScores,
          candidateWeights,
        );
      } catch (aggErr) {
        if (aggErr instanceof RankComputationError) {
          rankingInvalidSignalReasons.add(
            `ranking_invalid_signal:${aggErr.signalName}`,
          );
          finalScore = -Infinity;
        } else {
          throw aggErr;
        }
      }

        scored.push({
          entityId: candidate.entityId,
          canonicalLabel: candidate.canonicalLabel ?? '',
          ...(candidate.searchTextEn !== undefined
            ? { searchTextEn: candidate.searchTextEn }
            : {}),
          ...(projectHybridCandidateToRankedResultAttributes(
            candidate,
            this.attributeEncoder,
          ) as Partial<ScoredEntry>),
          // E1-T3: propagate deterministic tie-break tiers alongside channel ranks.
          ...(candidate.denseRank !== undefined ? { denseRank: candidate.denseRank } : {}),
          ...(candidate.anchorRank !== undefined ? { anchorRank: candidate.anchorRank } : {}),
          evidenceQualityTier: buildEvidenceQualityTier(candidate),
          lexicalExactnessTier: buildLexicalExactnessTier(candidate),
          matchedConstraints: constraintState.matchedConstraints,
          unmetConstraints: constraintState.unmetConstraints,
          inferredConstraints: constraintState.inferredConstraints,
          ...(constraintState.matchedAtomRefs !== undefined
            ? { matchedAtomRefs: constraintState.matchedAtomRefs }
            : {}),
          ...(constraintState.unmetAtomRefs !== undefined
            ? { unmetAtomRefs: constraintState.unmetAtomRefs }
            : {}),
          ...(entityPosteriorScore !== undefined ? { entityPosteriorScore } : {}),
          identityExactnessTier,
          ...(lanePresence !== undefined ? { lanePresence } : {}),
          componentScores,
          finalScore,
        });
      }
    } finally {
      stageTimer?.end('ranking.primary_scoring');
    }

    // Step 4 (T5.2): Coarse prune — explicit stage boundary.
    // Filter out -Infinity scores (hard constraint / entity integrity failures).
    // Track prune reason counts for CoarsePruneStageSummary.
    let hardConstraintFailCount = 0;
    let entityIntegrityFailCount = 0;

    const viable = scored.filter((entry) => {
      if (Number.isFinite(entry.finalScore)) return true;
      if (!entry.componentScores.hardConstraintPass) {
        hardConstraintFailCount++;
      } else {
        entityIntegrityFailCount++;
      }
      return false;
    });

    // T5.2: Coarse prune summary — returned via RankingMetadata so
    // RankingStagePipeline can populate the coarse_prune stage trace.
    const localCoarsePruneSummary: CoarsePruneStageSummary = {
      inputCount: scored.length,
      retainedCount: viable.length,
      prunedCount: scored.length - viable.length,
      hardConstraintFailCount,
      entityIntegrityFailCount,
    };

    if (scored.length > 0 && viable.length === 0) {
      bootstrapLogger.warn(
        {
          queryClass: queryPlan.queryClass,
          inputCount: scored.length,
          hardConstraintFailCount,
          entityIntegrityFailCount,
        },
        '[Ranker] Coarse prune dropped ALL candidates — returning empty results',
      );
    }

    // Step 5: Sort by finalScore descending, tie-break by entityId ascending
    // for deterministic ordering (RFC-009/015 determinism gate).
    // NaN handling: NaN propagated through any subtraction yields NaN, which
    // Array.sort treats as "equal" in implementation-defined order. Force
    // any NaN candidate to lose to a real number so determinism is preserved
    // even under upstream score corruption.
    viable.sort(compareScoredEntriesByFinalScoreDesc);

    // T5.6: Capture top-5 entity IDs after primary sort, before any reranking.
    // RankingStagePipeline reads this snapshot to compute rerankChangedTopK.
    localPreRerankTop5 = viable.slice(0, PRE_RERANK_TOP_ENTITY_SNAPSHOT_COUNT).map((e) => String(e.entityId));
    const ltrFeatureInputsByEntityId = new Map(
      viable.map((entry) => {
        const artifact = buildObservedLtrInferenceArtifact({
          componentScores: entry.componentScores,
          entityPosteriorScore: entry.entityPosteriorScore,
          identityExactnessTier: entry.identityExactnessTier,
          lanePresence: entry.lanePresence,
        });
        return [
          String(entry.entityId),
          artifact,
        ] as const;
      }),
    );

    // Step 6: Optionally rerank top-K via cross-encoder (T5.4: gate-controlled)
    let finalOrder: readonly ScoredEntry[] = viable;
    const hasConfiguredLearnedRerank = this.ltrModels !== undefined;
    // Tracks whether the gate cleared the learned LTR rerank for this request.
    // Must only be set inside the `gateDecision.shouldRerank` block so the gate
    // is honoured — setting it outside would bypass short_entity / too_few_candidates
    // rules and run LTR on every query regardless of quality signals.
    let shouldApplyLearnedRerank = false;
    if (viable.length === 0 && hasConfiguredLearnedRerank) {
      localLtrSkipReason = 'empty_candidates';
      localRerankDecisionCode = 'empty_candidates';
      localRerankInputCount = 0;
      localRerankOutputCount = 0;
    }
    if (this.reranker !== undefined || hasConfiguredLearnedRerank) {
      // E3-U5: compiled-first route for gate — falls back to V1 plan.route
      const gateEffectiveRoute = input.compiled.execution.effectiveRoute;
      const compiledBudget = input.compiled.execution.budget;
      const gateDecision = evaluateRerankGate({
        candidateCount: viable.length,
        queryClass: queryPlan.queryClass,
        effectiveRoute: gateEffectiveRoute,
        hasAnchor: anchorProfile !== undefined,
        rerankLimit: compiledBudget.enablePrecisionRerank
          ? compiledBudget.rerankLimit
          : 0,
        ...(input.rerankForced !== undefined ? { rerankForced: input.rerankForced } : {}),
      });

      localRerankGateReason = gateDecision.reason;

      if (gateDecision.shouldRerank) {
        const effectiveTopK = gateDecision.topKOverride ?? this.rerankTopK;
        let remoteRerankApplied = false;
        if (this.reranker !== undefined) {
          try {
            const preRerankCount = viable.length;
            stageTimer?.start('ranking.cross_encoder');
            const rerankOutcome = await this.applyReranking(
              queryPlan.normalizedQuery,
              viable,
              queryPlan.queryClass,
              effectiveTopK,
              stageTimer,
            );
            stageTimer?.end('ranking.cross_encoder');
            finalOrder = rerankOutcome.results;
            localRerankInputCount = preRerankCount;
            localRerankOutputCount = finalOrder.length;
            // T-E6-02: When batch normalization failed, the reranker scores
            // could not be normalized and heuristic scores were kept for all
            // candidates. The rerank was NOT meaningfully applied — surface
            // this as applied=false, decision='normalization_failed'.
            if (rerankOutcome.normalizationFailed === true) {
              localRerankExecuted = false;
              localRerankDecisionCode = 'normalization_failed';
              localRuntimeSignal = rerankOutcome.runtimeSignal ?? {
                rerankerStatus: 'executed',
                degradation: {
                  executionMode: 'degraded',
                  degradationReasons: [RERANK_SCORE_NORMALIZATION_FAILED_REASON],
                },
              };
            } else {
              localRerankExecuted = true;
              localRerankDecisionCode = 'applied';
              localRuntimeSignal = rerankOutcome.runtimeSignal ?? { rerankerStatus: 'executed' };
              localRerankModelId = this.reranker.modelId;
              remoteRerankApplied = true;
            }
          } catch (err) {
            stageTimer?.end('ranking.cross_encoder');
            const rerankerFailureReason = classifyRerankerFailureReason(err);
            bootstrapLogger.warn(
              {
                err,
                queryClass: queryPlan.queryClass,
                viableCount: viable.length,
                rerankTopK: effectiveTopK,
                gateReason: gateDecision.reason,
                rerankerFailureReason,
              },
              '[Ranker] Cross-encoder reranking failed; falling back to aggregated ranking',
            );
            finalOrder = viable;
            localRuntimeSignal = {
              rerankerStatus: 'failed',
              rerankerFailureReason,
              degradation: {
                executionMode: 'degraded',
                degradationReasons: [`reranker_${rerankerFailureReason}`],
              },
            };
          }
        }
        if (hasConfiguredLearnedRerank && !remoteRerankApplied) {
          shouldApplyLearnedRerank = true;
        }
      } else if (localLtrSkipReason === undefined) {
        localRerankDecisionCode = 'gate_blocked';
      }
    }

    // Step 7 & 8: Map to RankedResult with evidence items and assign ranks.
    // T5.2: coarsePruneMeta is attached to every retained candidate.
    // Pruned candidates never appear here (they were filtered out in step 4).
    stageTimer?.start('ranking.evidence_mapping');
    let results: RankedResult[];
    try {
      results = finalOrder.map((entry, index) => {
        const evidenceItems = this.evidenceMapper.mapToEvidence(
          entry.componentScores,
        );

        return {
          entityId: entry.entityId,
          canonicalLabel: entry.canonicalLabel,
          finalScore: entry.finalScore,
          rank: index + 1,
          componentScores: entry.componentScores,
          evidenceItems,
          matchedConstraints: entry.matchedConstraints,
          unmetConstraints: entry.unmetConstraints,
          inferredConstraints: entry.inferredConstraints,
          ...(entry.matchedAtomRefs !== undefined
            ? { matchedAtomRefs: entry.matchedAtomRefs }
            : {}),
          ...(entry.unmetAtomRefs !== undefined
            ? { unmetAtomRefs: entry.unmetAtomRefs }
            : {}),
          coarsePruneMeta: {
            preGateScore: entry.finalScore,
            hardConstraintPassed: entry.componentScores.hardConstraintPass,
            entityIntegrityPassed: true,
          },
          ...(projectRankedResultSourceAttributes(entry) as Partial<RankedResult>),
        };
      });
    } finally {
      stageTimer?.end('ranking.evidence_mapping');
    }

    if (shouldApplyLearnedRerank) {
      stageTimer?.start('ranking.ltr');
      try {
      // E5-T3: Build safety envelope descriptors BEFORE LTR runs.
      // Heuristic ranks are the pre-rerank baseline for invariant checks.
      // Lift hard constraints from RankingInput.constraints to ConstraintAtom[]
      // for the safety envelope. liftBundleToAtoms is side-effect free.
      const hardConstraintAtoms = liftBundleToAtoms(input.constraints).filter(
        (a) => a.source_tier === 'hard',
      );

      const safetyDescriptors: SafetyCandidateDescriptor[] = results.map((r, idx) => ({
        entityId: String(r.entityId),
        heuristicRank: idx + 1,
        hardConstraintPass: r.componentScores.hardConstraintPass,
        // H2 fix (second path): only include unmetConstraints as hard violations when
        // hardConstraintPass is false — same guard as the first safety descriptor path
        // at line 337. Soft/inferred unmet constraints must not be conflated with hard ones.
        hardConstraintViolations: r.componentScores.hardConstraintPass ? [] : [...r.unmetConstraints],
        anchorSimilarity: r.componentScores.anchorSimilarity ?? 0,
        // E5-T3: sparseRank is now propagated from ScoredEntry to RankedResult (Wave 2 fix).
        sparseRank: r.sparseRank ?? Infinity,
        heuristicScoreNormalized: Number.isFinite(r.finalScore) ? r.finalScore : 0,
        proposedLtrRank: idx + 1, // overwritten after LTR runs
      }));

      const listCtx = buildRerankSafetyListContext(safetyDescriptors);

      // Run LTR rerank to get proposed ordering
      const ltrOutcome = applyLearnedLtrRerank(
        results,
        queryPlan.queryClass,
        this.ltrModels,
        ltrFeatureInputsByEntityId,
      );
      localRerankInputCount = localRerankInputCount ?? safetyDescriptors.length;
      localRerankOutputCount = localRerankOutputCount ?? ltrOutcome.results.length;
      if (ltrOutcome.ltrSaturated === true) {
        localLtrSaturated = true;
      }
      if (ltrOutcome.skipReason === 'not_skipped') {
        localRerankExecuted = true;
        localRerankDecisionCode = 'applied';
        // P0-5: capture model ID from LTR outcome so rerankDecision.modelId is populated.
        localRerankModelId = ltrOutcome.modelId;
      } else {
        localLtrSkipReason = ltrOutcome.skipReason;
        if (!localRerankExecuted) {
          localRerankDecisionCode = ltrOutcome.skipReason;
        }
      }

      // Map entityId → proposed LTR rank
      const ltrRankMap = new Map<string, number>(
        ltrOutcome.results.map((r, idx) => [String(r.entityId), idx + 1]),
      );

      // Evaluate safety with actual proposed LTR ranks; collect blocked IDs
      let safetyEnvelopeBlocks = 0;
      const blockedIds = new Set<string>();
      for (const desc of safetyDescriptors) {
        const proposedRank = ltrRankMap.get(desc.entityId) ?? desc.heuristicRank;
        const updatedDesc: SafetyCandidateDescriptor = { ...desc, proposedLtrRank: proposedRank };
        const safety = evaluateRerankSafety(updatedDesc, listCtx, hardConstraintAtoms);
        if (!safety.allowed) {
          blockedIds.add(desc.entityId);
          safetyEnvelopeBlocks++;
        }
      }

      if (blockedIds.size === 0) {
        // Fast path: no blocks — use LTR results directly
        results = ltrOutcome.results;
      } else {
        // Restore heuristic finalScore for blocked candidates so they sort
        // to their original positions in the re-merged list.
        const heuristicScoreMap = new Map<string, number>(
          results.map((r) => [String(r.entityId), r.finalScore]),
        );
        results = ltrOutcome.results.map((r) => {
          const id = String(r.entityId);
          if (blockedIds.has(id)) {
            return { ...r, finalScore: heuristicScoreMap.get(id) ?? r.finalScore };
          }
          return r;
        });
        // Re-sort to interleave blocked (heuristic score) and non-blocked (LTR score)
        results.sort((a, b) => {
          const aFinite = Number.isFinite(a.finalScore);
          const bFinite = Number.isFinite(b.finalScore);
          if (!aFinite && !bFinite) return String(a.entityId) < String(b.entityId) ? -1 : 1;
          if (!aFinite) return 1;
          if (!bFinite) return -1;
          const diff = b.finalScore - a.finalScore;
          if (Math.abs(diff) > FINAL_SCORE_SORT_TIE_EPSILON) return diff > 0 ? 1 : -1;
          return String(a.entityId) < String(b.entityId) ? -1 : 1;
        });
        // Re-assign ranks after sort
        results = results.map((r, idx) => ({ ...r, rank: idx + 1 }));
      }

      if (safetyEnvelopeBlocks > 0) {
        bootstrapLogger.warn(
          {
            queryClass: queryPlan.queryClass,
            safetyEnvelopeBlocks,
            blockedIds: [...blockedIds],
          },
          '[Ranker] E5 safety envelope blocked LTR promotion(s)',
        );
      }

      // E1-T4: record LTR safety blocks for RerankDecision audit trail
      localRerankBlockedCount = safetyEnvelopeBlocks;

      // E1-T4: typed skip reason — only feature_dimension_mismatch degrades
      if (ltrOutcome.skipReason === 'feature_dimension_mismatch') {
        localRuntimeSignal = {
          rerankerStatus: 'skipped',
          degradation: {
            executionMode: 'degraded',
            degradationReasons: ['ltr_dimension_mismatch'],
          },
        };
      }

      // E5-T6: Compute ScoreDriftRecord — LTR vs heuristic ordering drift.
      // Only produced when LTR actually ran (skipReason === 'not_skipped').
      if (ltrOutcome.skipReason === 'not_skipped') {
        // heuristicTop3 = first 3 entity IDs before LTR reorder (pre-rerank order)
        const heuristicTop3EntityIds = safetyDescriptors
          .slice(0, DRIFT_MONITOR_TOP_K)
          .map((d) => d.entityId);

        // ltrTop3 = first 3 entity IDs in proposed LTR order
        const ltrTop3EntityIds = ltrOutcome.results
          .slice(0, DRIFT_MONITOR_TOP_K)
          .map((r) => String(r.entityId));

        // Kendall tau distance over top-K candidates (normalized to [0, 1]).
        // We compare the relative orderings of the candidates that appear in BOTH
        // top-K lists. Discordant pairs / total pairs = tau distance.
        localScoreDriftRecord = {
          queryClass: queryPlan.queryClass,
          heuristicTop3EntityIds,
          ltrTop3EntityIds,
          rankOrderChanges: computeKendallTauDistance(heuristicTop3EntityIds, ltrTop3EntityIds),
          averageRerankDeltaNormalized: computeAverageRerankDelta(safetyDescriptors, ltrOutcome.results),
          safetyEnvelopeBlocks,
        };
      }
      } finally {
        stageTimer?.end('ranking.ltr');
      }
    }

    // E1-T4: Build typed RerankDecision for structured audit trail.
    // Maps local rerank tracking variables to the RerankDecision contract.
    const rerankDecisionCode = (() => {
      if (localRerankDecisionCode !== undefined) {
        return localRerankDecisionCode;
      }
      if (localRerankExecuted) {
        return 'applied';
      }
      if (localLtrSkipReason !== undefined) {
        return localLtrSkipReason;
      }
      if (localRerankGateReason !== undefined) {
        return 'gate_blocked';
      }
      return 'no_model_for_query_class';
    })();
    const rerankDecision: RerankDecision = localRerankExecuted
      ? {
          applied: true,
          decision: rerankDecisionCode,
          ...(localRerankGateReason !== undefined ? { reason: localRerankGateReason } : {}),
          ...(localRerankModelId !== undefined ? { modelId: localRerankModelId } : {}),
          ...(localRerankInputCount !== undefined ? { inputCount: localRerankInputCount } : {}),
          ...(localRerankOutputCount !== undefined ? { outputCount: localRerankOutputCount } : {}),
          ...(localRerankBlockedCount > 0 ? { blockedCandidateCount: localRerankBlockedCount } : {}),
          ...(localScoreDriftRecord !== undefined ? { scoreDriftRecord: localScoreDriftRecord } : {}),
        }
      : {
          applied: false,
          decision: rerankDecisionCode,
          ...(localRerankGateReason !== undefined ? { reason: localRerankGateReason } : {}),
          ...(localRerankInputCount !== undefined ? { inputCount: localRerankInputCount } : {}),
          ...(localRerankOutputCount !== undefined ? { outputCount: localRerankOutputCount } : {}),
        };

    // C4 (fail-loud): fold ranking_invalid_signal reasons into the runtime
    // signal so ops see which COMPUTED signals were non-finite. We merge
    // with any existing degradation (e.g. ltr_dimension_mismatch) rather
    // than overwriting.
    let runtimeSignalWithInvalids = localRuntimeSignal;
    if (rankingInvalidSignalReasons.size > 0) {
      const extraReasons = [...rankingInvalidSignalReasons];
      const existingDegradation = localRuntimeSignal?.degradation;
      runtimeSignalWithInvalids = {
        ...(localRuntimeSignal ?? { rerankerStatus: 'skipped' as const }),
        degradation: {
          executionMode: 'degraded' as const,
          degradationReasons: [
            ...(existingDegradation?.degradationReasons ?? []),
            ...extraReasons,
          ],
        },
      };
    }

    const metadata: RankingMetadata = {
      coarsePruneSummary: localCoarsePruneSummary,
      rerankExecuted: localRerankExecuted,
      rerankGateReason: localRerankGateReason,
      rerankDecision,
      runtimeSignal: runtimeSignalWithInvalids,
      preRerankTop5: localPreRerankTop5,
      ...(localScoreDriftRecord !== undefined ? { scoreDriftRecord: localScoreDriftRecord } : {}),
      ...(localLtrSaturated ? { ltrSaturated: true } : {}),
    };

    return { results, metadata };
  }

  /**
   * Applies cross-encoder reranking to the top-K candidates.
   *
   * Thin instance wrapper over {@link applyCrossEncoderReranking} that binds
   * the instance reranker/blend-scale dependencies. Reranking semantics
   * (RFC-017 §5.2/§5.3) live in the free function.
   */
  private async applyReranking(
    query: string,
    viable: readonly ScoredEntry[],
    queryClass: QueryClass,
    topKLimit: number = this.rerankTopK,
    stageTimer?: NonNullable<RankingInput['requestContext']>['stageTimer'],
  ): Promise<{
    readonly results: readonly ScoredEntry[];
    readonly runtimeSignal?: RankerRuntimeSignal | undefined;
    /** True when normalization failed for ALL top-K candidates (collapsed/NaN batch). */
    readonly normalizationFailed?: boolean | undefined;
  }> {
    return applyCrossEncoderReranking(
      { reranker: this.reranker, rerankBlendScale: this.rerankBlendScale },
      query,
      viable,
      queryClass,
      topKLimit,
      stageTimer,
    );
  }
}
