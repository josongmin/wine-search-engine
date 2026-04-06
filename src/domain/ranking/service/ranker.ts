import type { EntityId, QueryClass } from '../../shared/types/index.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { CandidateProvenance } from '../../retrieval/model/candidate-envelope.js';
import type { RankingInput } from '../model/ranking-input.js';
import type { RankedResult, ComponentScores, CoarsePruneStageSummary } from '../model/ranked-result.js';
import type { RankerRuntimeSignal, RerankerFailureReason } from '../model/ranking-runtime-signal.js';
import type { RerankerPort, RerankCandidate } from '../port/reranker.port.js';
import type { WineAttributeEncoderPort } from '../port/wine-attribute-encoder.port.js';
import type { QueryClassWeights } from '../index.js';
import { resolveWeights, resolveChannelAwareWeights } from '../model/scoring-weights.js';
import type { ScoringWeights } from '../model/scoring-weights.js';
import { getModeWeights } from '../model/mode-weights.js';
import { effectiveRerankBlendWeight } from './rerank-blend.js';
import { type SignalComputer } from './signal-computer.js';
import { type ScoreAggregator } from './score-aggregator.js';
import { type EvidenceMapper } from './evidence-mapper.js';
import { WineAttributeEncoders } from './wine-attribute-encoder.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { evaluateRerankGate } from './rerank-gate.js';
import { LTRRanker } from './ltr-ranker.js';
import { extractLTRFeatures } from './ltr-feature-extractor.js';

/**
 * Default number of top candidates to submit for cross-encoder reranking.
 */
const DEFAULT_RERANK_TOP_K = 20;

/** Max characters sent to the cross-encoder (latency + model context). */
const RERANK_PASSAGE_MAX_CHARS = 1200;

function classifyRerankerFailureReason(error: unknown): RerankerFailureReason {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('timed out')) return 'timeout';
  if (message.includes('http')) return 'http_error';
  if (message.includes('unexpected response shape')) return 'parse_error';
  return 'unknown';
}

/**
 * Builds a wine-aware passage text for cross-encoder reranking (RFC-017 §5.2).
 */
function buildWineText(entry: ScoredEntry): string {
  const parts: string[] = [];
  const label = entry.canonicalLabel.trim();
  if (label.length > 0) parts.push(label);
  const prod = entry.producer?.trim();
  if (prod !== undefined && prod.length > 0) parts.push(prod);
  const reg = entry.region?.trim();
  if (reg !== undefined && reg.length > 0) parts.push(reg);
  const en = entry.searchTextEn?.trim();
  if (en !== undefined && en.length > 0) parts.push(en);
  const grape = entry.grapePrimary?.trim();
  if (grape !== undefined && grape.length > 0) parts.push(grape);

  if (parts.length === 0) return String(entry.entityId);

  let passage = parts.join('. ');
  if (passage.length > RERANK_PASSAGE_MAX_CHARS) {
    passage = passage.slice(0, RERANK_PASSAGE_MAX_CHARS);
  }
  return passage;
}

/**
 * Internal intermediate representation during ranking.
 */
interface ScoredEntry {
  readonly entityId: EntityId;
  readonly canonicalLabel: string;
  readonly producer?: string;
  readonly region?: string;
  readonly searchTextEn?: string;
  readonly grapePrimary?: string;
  readonly appellation?: string;
  readonly producerPrestige?: number;
  readonly componentScores: ComponentScores;
  readonly finalScore: number;
  readonly matchedConstraints: readonly string[];
  readonly unmetConstraints: readonly string[];
  readonly inferredConstraints: readonly string[];
  readonly retrievalProvenance?: CandidateProvenance | undefined;
  readonly drinkingWindowStart?: number | undefined;
  readonly drinkingWindowEnd?: number | undefined;
  readonly drinkingWindowModelVersion?: string | undefined;

  // Wine attributes for Epic 15 dynamic prediction
  readonly vintageYear?: number | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly criticScoreNormalized?: number | undefined;
  readonly grapePrimaryEnc?: number | undefined;
  readonly regionEnc?: number | undefined;
  readonly countryEnc?: number | undefined;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function applyLearnedLtrRerank(
  rankedResults: readonly RankedResult[],
  queryClass: QueryClass,
  ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined,
): RankedResult[] {
  const ltrModel = ltrModels?.get(queryClass);
  if (!ltrModel || rankedResults.length === 0) {
    return [...rankedResults];
  }

  const rankableDocuments = rankedResults.map((doc, idx) => ({
    entityId: doc.entityId,
    retrievalScore: doc.finalScore,
    features: extractLTRFeatures({
      semantic: doc.componentScores.semantic,
      popularity: doc.componentScores.popularity,
      attributeAlignment: doc.componentScores.attributeAlignment,
      preferenceAlignment: doc.componentScores.preferenceAlignment,
      // SOTA++ signals — forward all optional fields so LTR model can use them
      ...(doc.componentScores.criticScore !== undefined
        ? { criticScore: doc.componentScores.criticScore }
        : {}),
      ...(doc.componentScores.recency !== undefined
        ? { recency: doc.componentScores.recency }
        : {}),
      ...(doc.componentScores.producerPrestige !== undefined
        ? { producerPrestige: doc.componentScores.producerPrestige }
        : {}),
      ...(doc.componentScores.multilingualScore !== undefined
        ? { multilingualScore: doc.componentScores.multilingualScore }
        : {}),
    }),
    originalRank: idx + 1,
  }));

  const rerankedDocs = LTRRanker.rerank(rankableDocuments, queryClass, ltrModel);
  const originalByEntity = new Map<string, RankedResult>(
    rankedResults.map((result) => [result.entityId, result]),
  );

  return rerankedDocs
    .map((reranked) => {
      const original = originalByEntity.get(reranked.entityId);
      if (original === undefined) {
        return undefined;
      }
      return {
        ...original,
        finalScore: reranked.ltrScore,
        rank: reranked.finalRank,
      };
    })
    .filter((result): result is RankedResult => result !== undefined);
}

function buildConstraintState(
  input: RankingInput,
  candidate: HybridCandidate,
): {
  readonly matchedConstraints: readonly string[];
  readonly unmetConstraints: readonly string[];
  readonly inferredConstraints: readonly string[];
} {
  const matchedSet = new Set(candidate.matchedConstraints);
  const inferredConstraints = unique(
    input.constraints.inferred.map((constraint) => constraint.attribute),
  );
  const softUnmet = input.constraints.soft
    .map((constraint) => constraint.attribute)
    .filter((attribute) => !matchedSet.has(attribute));
  const inferredUnmet = inferredConstraints
    .filter((attribute) => !matchedSet.has(attribute));
  const unmetConstraints = unique([
    ...(candidate.unmetHardConstraints ?? []),
    ...softUnmet,
    ...inferredUnmet,
  ]);
  const trackedAttributes = new Set([
    ...input.constraints.hard.map((constraint) => constraint.attribute),
    ...input.constraints.soft.map((constraint) => constraint.attribute),
    ...inferredConstraints,
  ]);
  const matchedConstraints = candidate.matchedConstraints
    .filter((attribute: string) => trackedAttributes.has(attribute));

  return {
    matchedConstraints,
    unmetConstraints,
    inferredConstraints,
  };
}

export type RankerOptions = {
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
  private _lastCoarsePruneSummary: CoarsePruneStageSummary | undefined;
  private _lastRerankExecuted = false;
  private _lastRerankGateReason: string | undefined;
  private _lastRuntimeSignal: RankerRuntimeSignal | undefined;
  /** T5.6: Top-5 entityIds captured immediately after primary sort, before rerank. */
  private _lastPreRerankTop5: readonly string[] = [];
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
   * T5.2: Returns the coarse prune summary from the most recent rank() call.
   * Consumed by RankingStagePipeline to populate the coarse_prune stage trace.
   */
  getLastCoarsePruneSummary(): CoarsePruneStageSummary | undefined {
    return this._lastCoarsePruneSummary;
  }

  /**
   * T5.1: Returns whether precision reranking was executed in the most recent rank() call.
   * Authoritative flag — reliable even when blended scores remain in descending order.
   */
  getLastRerankExecuted(): boolean {
    return this._lastRerankExecuted;
  }

  /**
   * T5.4: Returns the gate decision reason from the most recent rank() call.
   * Populated by evaluateRerankGate() — useful for pipeline trace notes.
   */
  getLastRerankGateReason(): string | undefined {
    return this._lastRerankGateReason;
  }

  getLastRuntimeSignal(): RankerRuntimeSignal | undefined {
    return this._lastRuntimeSignal;
  }

  /**
   * T5.6: Returns the top-5 entityIds captured immediately after primary_rank
   * sort but before precision rerank ran. Used by RankingStagePipeline to
   * compute the `rerankChangedTopK` funnel metric.
   */
  getLastPreRerankTop5(): readonly string[] {
    return this._lastPreRerankTop5;
  }

  /**
   * Ranks candidates according to the scoring formula and returns
   * ordered results with evidence trails.
   *
   * @param input - The ranking input containing query plan, candidates, constraints.
   * @returns Ranked results sorted by final score descending.
   */
  async rank(input: RankingInput): Promise<readonly RankedResult[]> {
    const { queryPlan, candidates, anchorProfile, constraints } = input;

    this._lastRerankExecuted = false;
    this._lastRerankGateReason = undefined;
    this._lastRuntimeSignal = undefined;
    this._lastPreRerankTop5 = [];

    // Step 1: Compute all signals for each candidate
    const scored: ScoredEntry[] = [];

    // Step 2: Select weights based on query class, then overlay retrieval-mode
    // specific boosts from mode-weights.ts (producer prestige, recency, geo).
    const baseWeights = resolveWeights(queryPlan.queryClass);
    const modeProfile = getModeWeights(queryPlan.retrievalMode);
    // Mode overlay: max(queryClass base, mode boost).
    // DEFAULT_WEIGHTS are all 0.0 (no-op) so neutral/undefined modes preserve base.
    // Explicit modes (producer_browse etc.) can only raise a signal, never suppress.
    // After overlay, re-normalise so the non-penalty sum is preserved — otherwise
    // Math.max can inflate the total (e.g. popularity 0.02→0.15 adds +0.13).
    const overlaid: ScoringWeights = {
      ...baseWeights,
      semantic: Math.max(baseWeights.semantic, modeProfile.semanticWeight),
      popularity: Math.max(baseWeights.popularity, modeProfile.popularityWeight),
      attributeAlignment: Math.max(baseWeights.attributeAlignment, modeProfile.attributeAlignmentWeight),
      preferenceAlignment: Math.max(baseWeights.preferenceAlignment, modeProfile.preferenceAlignmentWeight),
      producerPrestige: Math.max(baseWeights.producerPrestige, modeProfile.producerPrestigeWeight),
      recency: Math.max(baseWeights.recency, modeProfile.recencyWeight),
    };
    const nonPenaltyFields = [
      'entityIntegrity', 'anchorSimilarity', 'semantic', 'softConstraint',
      'attributeAlignment', 'preferenceAlignment', 'popularity', 'availability',
      'producerPrestige', 'recency', 'criticScore', 'multilingualScore',
    ] as const;
    const baseSum = nonPenaltyFields.reduce((s, k) => s + baseWeights[k], 0);
    const overlaidSum = nonPenaltyFields.reduce((s, k) => s + overlaid[k], 0);
    const modeNormFactor = overlaidSum > 0 && overlaidSum !== baseSum ? baseSum / overlaidSum : 1;
    const weights: ScoringWeights = modeNormFactor === 1 ? overlaid : {
      ...overlaid,
      entityIntegrity: overlaid.entityIntegrity * modeNormFactor,
      anchorSimilarity: overlaid.anchorSimilarity * modeNormFactor,
      semantic: overlaid.semantic * modeNormFactor,
      softConstraint: overlaid.softConstraint * modeNormFactor,
      attributeAlignment: overlaid.attributeAlignment * modeNormFactor,
      preferenceAlignment: overlaid.preferenceAlignment * modeNormFactor,
      popularity: overlaid.popularity * modeNormFactor,
      availability: overlaid.availability * modeNormFactor,
      producerPrestige: overlaid.producerPrestige * modeNormFactor,
      recency: overlaid.recency * modeNormFactor,
      criticScore: overlaid.criticScore * modeNormFactor,
      multilingualScore: overlaid.multilingualScore * modeNormFactor,
    };

    // Pre-compute query-level signals shared across all candidates.
    const referenceYear = new Date().getFullYear();
    const queryContainsHangul = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(
      queryPlan.rawQuery,
    );

    for (const candidate of candidates) {
      const componentScores = this.signalComputer.computeAll(
        candidate,
        queryPlan,
        constraints,
        anchorProfile,
        referenceYear,
        queryContainsHangul,
      );
      const constraintState = buildConstraintState(input, candidate);

      // Step 3: Aggregate signals into final score.
      // T5.3: Adjust weights based on which retrieval channels contributed
      // to this specific candidate, then normalise proportionally.
      const candidateWeights = resolveChannelAwareWeights(
        candidate.retrievalTrace.candidateSources,
        weights,
      );
      const finalScore = this.scoreAggregator.aggregate(
        componentScores,
        candidateWeights,
      );

      scored.push({
        entityId: candidate.entityId,
        canonicalLabel: candidate.canonicalLabel ?? '',
        ...(candidate.producer !== undefined ? { producer: candidate.producer } : {}),
        ...(candidate.region !== undefined ? { region: candidate.region } : {}),
        ...(candidate.searchTextEn !== undefined
          ? { searchTextEn: candidate.searchTextEn }
          : {}),
        ...(candidate.grapePrimary !== undefined
          ? { grapePrimary: candidate.grapePrimary }
          : {}),
        ...(candidate.drinkingWindowStart !== undefined ? { drinkingWindowStart: candidate.drinkingWindowStart } : {}),
        ...(candidate.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: candidate.drinkingWindowEnd } : {}),
        ...(candidate.drinkingWindowModelVersion !== undefined
          ? { drinkingWindowModelVersion: candidate.drinkingWindowModelVersion }
          : {}),
        // Epic 15: Wine attributes with label encoding
        ...(candidate.vintageYear !== undefined ? { vintageYear: candidate.vintageYear } : {}),
        ...(candidate.body !== undefined ? { body: candidate.body } : {}),
        ...(candidate.tannin !== undefined ? { tannin: candidate.tannin } : {}),
        ...(candidate.acidity !== undefined ? { acidity: candidate.acidity } : {}),
        ...(candidate.sweetness !== undefined ? { sweetness: candidate.sweetness } : {}),
        ...(candidate.criticScoreNormalized !== undefined
          ? { criticScoreNormalized: candidate.criticScoreNormalized }
          : {}),
        // Encode categorical attributes
        ...(candidate.grapePrimary !== undefined
          ? { grapePrimaryEnc: this.attributeEncoder.encodeGrape(candidate.grapePrimary) }
          : {}),
        ...(candidate.appellation !== undefined
          ? { regionEnc: this.attributeEncoder.encodeRegion(candidate.appellation) }
          : {}),
        ...(candidate.country !== undefined
          ? { countryEnc: this.attributeEncoder.encodeCountry(candidate.country) }
          : {}),
        ...(candidate.appellation !== undefined ? { appellation: candidate.appellation } : {}),
        ...(candidate.producerPrestige !== undefined
          ? { producerPrestige: candidate.producerPrestige }
          : {}),
        ...(candidate.retrievalProvenance !== undefined
          ? { retrievalProvenance: candidate.retrievalProvenance }
          : {}),
        matchedConstraints: constraintState.matchedConstraints,
        unmetConstraints: constraintState.unmetConstraints,
        inferredConstraints: constraintState.inferredConstraints,
        componentScores,
        finalScore,
      });
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

    // T5.2: Expose coarse prune summary — RankingStagePipeline reads this via
    // getLastCoarsePruneSummary() to populate the coarse_prune stage trace.
    this._lastCoarsePruneSummary = {
      inputCount: scored.length,
      retainedCount: viable.length,
      prunedCount: scored.length - viable.length,
      hardConstraintFailCount,
      entityIntegrityFailCount,
    };

    // Step 5: Sort by finalScore descending
    viable.sort((a, b) => b.finalScore - a.finalScore);

    // T5.6: Capture top-5 entity IDs after primary sort, before any reranking.
    // RankingStagePipeline reads this snapshot to compute rerankChangedTopK.
    this._lastPreRerankTop5 = viable.slice(0, 5).map((e) => String(e.entityId));

    // Step 6: Optionally rerank top-K via cross-encoder (T5.4: gate-controlled)
    let finalOrder: readonly ScoredEntry[] = viable;
    const hasLearnedRerank = this.ltrModels?.has(queryPlan.queryClass) ?? false;
    // Tracks whether the gate cleared the learned LTR rerank for this request.
    // Must only be set inside the `gateDecision.shouldRerank` block so the gate
    // is honoured — setting it outside would bypass short_entity / too_few_candidates
    // rules and run LTR on every query regardless of quality signals.
    let shouldApplyLearnedRerank = false;
    if (this.reranker !== undefined || hasLearnedRerank) {
      const gateDecision = evaluateRerankGate({
        candidateCount: viable.length,
        queryClass: queryPlan.queryClass,
        effectiveRoute: queryPlan.route,
        hasAnchor: anchorProfile !== undefined,
        ...(input.rerankForced !== undefined ? { rerankForced: input.rerankForced } : {}),
      });

      this._lastRerankGateReason = gateDecision.reason;

      if (gateDecision.shouldRerank) {
        const effectiveTopK = gateDecision.topKOverride ?? this.rerankTopK;
        if (this.reranker !== undefined) {
          try {
            finalOrder = await this.applyReranking(
              queryPlan.normalizedQuery,
              viable,
              queryPlan.queryClass,
              effectiveTopK,
            );
            this._lastRerankExecuted = true;
            this._lastRuntimeSignal = { rerankerStatus: 'executed' };
          } catch (err) {
            const rerankerFailureReason = classifyRerankerFailureReason(err);
            bootstrapLogger.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                queryClass: queryPlan.queryClass,
                viableCount: viable.length,
                rerankTopK: effectiveTopK,
                gateReason: gateDecision.reason,
                rerankerFailureReason,
              },
              '[Ranker] Cross-encoder reranking failed; falling back to aggregated ranking',
            );
            finalOrder = viable;
            this._lastRuntimeSignal = {
              rerankerStatus: 'failed',
              rerankerFailureReason,
              degradation: {
                executionMode: 'degraded',
                degradationReasons: [`reranker_${rerankerFailureReason}`],
              },
            };
          }
        }
        if (hasLearnedRerank) {
          this._lastRerankExecuted = true;
          shouldApplyLearnedRerank = true;
        }
      }
    }

    // Step 7 & 8: Map to RankedResult with evidence items and assign ranks.
    // T5.2: coarsePruneMeta is attached to every retained candidate.
    // Pruned candidates never appear here (they were filtered out in step 4).
    let results: RankedResult[] = finalOrder.map((entry, index) => {
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
        coarsePruneMeta: {
          preGateScore: entry.finalScore,
          hardConstraintPassed: entry.componentScores.hardConstraintPass,
          entityIntegrityPassed: true,
        },
        ...(entry.producer !== undefined ? { producer: entry.producer } : {}),
        ...(entry.region !== undefined ? { region: entry.region } : {}),
        ...(entry.grapePrimary !== undefined ? { grapePrimary: entry.grapePrimary } : {}),
        ...(entry.appellation !== undefined ? { appellation: entry.appellation } : {}),
        ...(entry.producerPrestige !== undefined ? { producerPrestige: entry.producerPrestige } : {}),
        ...(entry.retrievalProvenance !== undefined
          ? { retrievalProvenance: entry.retrievalProvenance }
          : {}),
        ...(entry.drinkingWindowStart !== undefined ? { drinkingWindowStart: entry.drinkingWindowStart } : {}),
        ...(entry.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: entry.drinkingWindowEnd } : {}),
        ...(entry.drinkingWindowModelVersion !== undefined
          ? { drinkingWindowModelVersion: entry.drinkingWindowModelVersion }
          : {}),
        // Epic 15: Wine attributes for dynamic prediction
        // TODO: remove vintage after consumers migrate to vintageYear
        ...(entry.vintageYear !== undefined
          ? { vintage: entry.vintageYear, vintageYear: entry.vintageYear }
          : {}),
        ...(entry.body !== undefined ? { body: entry.body } : {}),
        ...(entry.tannin !== undefined ? { tannin: entry.tannin } : {}),
        ...(entry.acidity !== undefined ? { acidity: entry.acidity } : {}),
        ...(entry.sweetness !== undefined ? { sweetness: entry.sweetness } : {}),
        ...(entry.criticScoreNormalized !== undefined
          ? {
              avgCriticProxyScore: Math.round(80 + entry.criticScoreNormalized * 20),
              criticScoreNormalized: entry.criticScoreNormalized,
            }
          : {}),
        ...(entry.grapePrimaryEnc !== undefined ? { grapePrimaryEnc: entry.grapePrimaryEnc } : {}),
        ...(entry.regionEnc !== undefined ? { regionEnc: entry.regionEnc } : {}),
        ...(entry.countryEnc !== undefined ? { countryEnc: entry.countryEnc } : {}),
      };
    });

    if (shouldApplyLearnedRerank) {
      results = applyLearnedLtrRerank(
        results,
        queryPlan.queryClass,
        this.ltrModels,
      );
    }

    return results;
  }

  /**
   * Applies cross-encoder reranking to the top-K candidates.
   *
   * Candidates beyond top-K retain their original order appended after
   * the reranked set.  The final score blends the cross-encoder score with
   * the original aggregated score using a query-class-aware weight
   * (RFC-017 §5.3) rather than a hardcoded ratio.
   */
  private async applyReranking(
    query: string,
    viable: readonly ScoredEntry[],
    queryClass: QueryClass,
    topKLimit: number = this.rerankTopK,
  ): Promise<readonly ScoredEntry[]> {
    const topK = viable.slice(0, topKLimit);
    const rest = viable.slice(topKLimit);

    // Build wine-aware passage text for the cross-encoder (RFC-017 §5.2).
    const rerankCandidates: RerankCandidate[] = topK.map((entry) => ({
      entityId: entry.entityId,
      text: buildWineText(entry),
    }));

    const reranker = this.reranker;
    if (reranker === undefined) {
      throw new Error('applyReranking requires reranker');
    }
    const rerankResults = await reranker.rerank(
      query,
      rerankCandidates,
      topKLimit,
    );

    // Build lookups
    const rerankScoreMap = new Map(
      rerankResults.map((r) => [String(r.entityId), r.score]),
    );
    const entryMap = new Map(
      topK.map((entry) => [String(entry.entityId), entry]),
    );

    // Normalise reranker scores to [0, 1] before blending.
    // Cross-encoder logits (e.g. BGE-reranker) are typically in [-10, +15];
    // a sigmoid squashes them to a comparable [0, 1] range, and min-max
    // within the batch preserves the relative ordering while ensuring scale
    // compatibility with the original aggregated score (also [0, 1]).
    const rawScores = rerankResults.map((r) => r.score);
    const minRaw = Math.min(...rawScores);
    const maxRaw = Math.max(...rawScores);
    const rawRange = maxRaw - minRaw;

    function normalizeRerankScore(raw: number): number {
      if (rawRange < 1e-8) return 0.5; // all scores equal → neutral
      // Min-max within batch: maps to [0, 1] preserving relative order.
      // Sigmoid compression is unnecessary when min-max already bounds the range.
      return (raw - minRaw) / rawRange;
    }

    // Reorder top-K by rerank score, blending with original score
    const rerankedTopK: ScoredEntry[] = [];

    for (const r of rerankResults) {
      const original = entryMap.get(String(r.entityId));
      if (original === undefined) {
        continue;
      }
      // Blend: query-class weight × optional global scale (RFC-017 §5.3)
      const w = effectiveRerankBlendWeight(queryClass, this.rerankBlendScale);
      const normScore = normalizeRerankScore(r.score);
      const blendedScore = w * normScore + (1 - w) * original.finalScore;
      rerankedTopK.push({
        ...original,
        finalScore: blendedScore,
      });
    }

    // Add any topK entries that the reranker dropped
    for (const entry of topK) {
      if (!rerankScoreMap.has(String(entry.entityId))) {
        rerankedTopK.push(entry);
      }
    }

    // Sort reranked portion by blended score
    rerankedTopK.sort((a, b) => b.finalScore - a.finalScore);

    // Append the rest (unchanged)
    return [...rerankedTopK, ...rest];
  }
}
