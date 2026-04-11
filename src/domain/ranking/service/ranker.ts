import type { EntityId, QueryClass } from '../../shared/types/index.js';
import { liftBundleToAtoms } from '../../shared/types/index.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { CandidateProvenance } from '../../retrieval/model/candidate-envelope.js';
import type { RankingInput } from '../model/ranking-input.js';
import type { RankedResult, ComponentScores, CoarsePruneStageSummary } from '../model/ranked-result.js';
import type { RankerRuntimeSignal, RerankerFailureReason } from '../model/ranking-runtime-signal.js';
import type { RankingMetadata, RankingOutput } from '../port/ranker.port.js';
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
import { MS_PER_DAY } from '../../shared/utils/time-units.js';
import { clamp01 } from '../../shared/utils/clamp.js';
import {
  evaluateRerankSafety,
  buildRerankSafetyListContext,
} from './rerank-safety.js';
import type { SafetyCandidateDescriptor } from './rerank-safety.js';
import type { ScoreDecomposition, ScoreDriftRecord } from '../model/score-decomposition.js';

/**
 * Default number of top candidates to submit for cross-encoder reranking.
 */
const DEFAULT_RERANK_TOP_K = 20;

/**
 * E5-T6: Top-K window for ScoreDriftRecord heuristic/LTR top-N comparison.
 * Must match ScoreDriftRecord.heuristicTop3EntityIds field semantics (top-3).
 */
const DRIFT_MONITOR_TOP_K = 3;

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
  /**
   * E1-T3: sparse (BM25) rank from retrieval — used as 3rd tie-break stage after
   * finalScore and before entityId. Lower rank = better lexical match.
   * Present only for candidates retrieved via sparse_bm25 channel.
   */
  readonly sparseRank?: number | undefined;
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

  // Display metadata for new entity summary fields
  readonly style?: string | undefined;
  readonly classification?: string | undefined;
  readonly alcoholPct?: number | undefined;
  readonly certifications?: readonly string[] | undefined;
  readonly pairingTags?: readonly string[] | undefined;
  readonly occasion?: readonly string[] | undefined;

  // Price data for agent/response surface
  readonly priceBand?: string | undefined;
  readonly priceUsd?: number | undefined;
}

const MODEL_STALENESS_THRESHOLD_DAYS = 30;

// MS_PER_DAY imported from SSoT: @domain/shared/utils/time-units
const MILLISECONDS_PER_DAY = MS_PER_DAY;

/** LambdaMART weight vector length (must match {@link extractLTRFeatures} output). */
const LTR_MODEL_FEATURE_DIMENSION = 8;

/** Entity IDs captured after primary sort for funnel rerank telemetry. */
const PRE_RERANK_TOP_ENTITY_SNAPSHOT_COUNT = 5;

/** Maps normalized critic score to 80–100 “proxy points” display scale. */
const CRITIC_PROXY_SCORE_DISPLAY_BASE = 80;
const CRITIC_PROXY_SCORE_DISPLAY_SPAN = 20;

/**
 * Treat reranker batch as degenerate when max-min below this (use neutral norm).
 * Logit-scale scores can differ by ~1e-7 from floating-point noise; 1e-8 was
 * overly tight and collapsed distinct candidates to the neutral blend.
 */
const RERANK_SCORE_MIN_MAX_RANGE_EPSILON = 1e-6;
/** Neutral normalized rerank score when range is unusable (midpoint of [0,1]). */
const RERANK_SCORE_NORMALIZED_NEUTRAL = 0.5;
/**
 * Fallback rerank blend weight when effectiveRerankBlendWeight returns NaN/Infinity
 * (e.g. misconfigured rerankBlendScale env var). Midpoint = equal weight between
 * cross-encoder and heuristic score, preventing either from dominating.
 */
const RERANK_BLEND_WEIGHT_FALLBACK = 0.5;

/**
 * Final-score comparisons treat values within this epsilon as tied so ordering
 * falls through to entityId (deterministic tie-break, RFC-009/015).
 */
const FINAL_SCORE_SORT_TIE_EPSILON = 1e-12;

/**
 * Non-penalty scoring weight fields — used to compute the mode-overlay
 * normalisation factor. Hoisted to module scope so rank() does not
 * re-allocate the 12-element tuple (and the two .reduce() closures that
 * walk it) on every request. Rule 16: deterministic constants belong
 * outside hot-path functions.
 */
const NON_PENALTY_WEIGHT_FIELDS = [
  'entityIntegrity', 'anchorSimilarity', 'semantic', 'softConstraint',
  'attributeAlignment', 'preferenceAlignment', 'popularity', 'availability',
  'producerPrestige', 'recency', 'criticScore', 'multilingualScore',
] as const;

function sumNonPenaltyWeights(weights: ScoringWeights): number {
  let total = 0;
  for (const key of NON_PENALTY_WEIGHT_FIELDS) {
    total += weights[key];
  }
  return total;
}

/**
 * Descending sort by finalScore; NaN-safe; 3-stage deterministic tie-break.
 *
 * Stage 1: finalScore descending (NaN → last)
 * Stage 2: sparseRank ascending (lower BM25 rank = better lexical match; absent → last)
 * Stage 3: entityId ascending (stable lexicographic tie-break, RFC-009/015)
 *
 * E1-T3: adding sparseRank as stage-2 tie-break eliminates insertion-order
 * non-determinism for candidates with identical heuristic scores. Candidates
 * that appear higher in the BM25 ranking have a stronger lexical signal and
 * should win ties over candidates absent from BM25 results.
 */
function compareScoredEntriesByFinalScoreDesc(a: ScoredEntry, b: ScoredEntry): number {
  const aFinite = Number.isFinite(a.finalScore);
  const bFinite = Number.isFinite(b.finalScore);
  if (!aFinite && !bFinite) {
    // Stage 2 + 3 for NaN-NaN ties
    const aSparse = a.sparseRank ?? Infinity;
    const bSparse = b.sparseRank ?? Infinity;
    if (aSparse !== bSparse) return aSparse - bSparse;
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  }
  if (!aFinite) return 1;
  if (!bFinite) return -1;
  const scoreDiff = b.finalScore - a.finalScore;
  if (Math.abs(scoreDiff) > FINAL_SCORE_SORT_TIE_EPSILON) {
    return scoreDiff > 0 ? 1 : -1;
  }
  // Stage 2: sparseRank ascending (absent = Infinity → loses)
  const aSparse = a.sparseRank ?? Infinity;
  const bSparse = b.sparseRank ?? Infinity;
  if (aSparse !== bSparse) return aSparse - bSparse;
  // Stage 3: entityId ascending
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

/**
 * E1-T4: Typed reason why learned LTR rerank was skipped.
 *
 * - `not_skipped`: rerank was applied normally
 * - `no_model_for_query_class`: no LTR model registered for this query class
 * - `empty_candidates`: result list was empty before rerank
 * - `feature_dimension_mismatch`: model weight vector length ≠ LTR_MODEL_FEATURE_DIMENSION
 * - `model_stale`: model age exceeded MODEL_STALENESS_THRESHOLD_DAYS (warning only, does not skip)
 */
export type LtrRerankSkipReason =
  | 'not_skipped'
  | 'no_model_for_query_class'
  | 'empty_candidates'
  | 'feature_dimension_mismatch';

function applyLearnedLtrRerank(
  rankedResults: readonly RankedResult[],
  queryClass: QueryClass,
  ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined,
): { results: RankedResult[]; skipReason: LtrRerankSkipReason } {
  const ltrModel = ltrModels?.get(queryClass);
  if (!ltrModel) {
    return { results: [...rankedResults], skipReason: 'no_model_for_query_class' };
  }
  if (rankedResults.length === 0) {
    return { results: [], skipReason: 'empty_candidates' };
  }

  // Guard against an Invalid Date `trainedAt` (e.g. JSONB corruption or a
  // training record written with `new Date(undefined)`). Without this guard,
  // `getTime()` returns NaN, `NaN > threshold` is false, and a stale model
  // would silently bypass the freshness warning. Treat NaN as "unknown age"
  // and log it so operators notice.
  const trainedAtMs = ltrModel.trainedAt.getTime();
  const modelAgeMs = Number.isFinite(trainedAtMs) ? Date.now() - trainedAtMs : Number.NaN;
  const modelAgeDays = modelAgeMs / MILLISECONDS_PER_DAY;
  if (!Number.isFinite(modelAgeDays)) {
    bootstrapLogger.warn(
      { queryClass },
      '[Ranker] LTR model has invalid trainedAt timestamp — treating as stale',
    );
  } else if (modelAgeDays > MODEL_STALENESS_THRESHOLD_DAYS) {
    bootstrapLogger.warn(
      {
        queryClass,
        modelAgeDays: Math.floor(modelAgeDays),
        threshold: MODEL_STALENESS_THRESHOLD_DAYS,
      },
      '[Ranker] LTR model is stale — consider retraining',
    );
  }

  if (ltrModel.weights.length !== LTR_MODEL_FEATURE_DIMENSION) {
    bootstrapLogger.warn({ queryClass, modelWeightDim: ltrModel.weights.length, expectedDim: LTR_MODEL_FEATURE_DIMENSION }, '[Ranker] LTR model dimension mismatch — skipping LTR rerank');
    return { results: [...rankedResults], skipReason: 'feature_dimension_mismatch' };
  }

  // E5-T3: Build safety evaluation descriptors — one per candidate,
  // using heuristic scores and ranks from the pre-LTR ordering.
  // We first run LTR to get proposed ranks, then apply safety checks.
  //
  // ltrFeatureVectorMap: entity → ordered feature vector (8 values, same order
  // as scoreFeaturesRaw in lambdamart-ranker.ts) so ScoreDecomposition can
  // carry the raw input for debugging / drift analysis.
  const ltrFeatureVectorMap = new Map<string, readonly number[]>();
  const rankableDocuments = rankedResults.map((doc, idx) => {
    const features = extractLTRFeatures({
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
    });
    // Store as ordered vector matching lambdamart-ranker scoreFeaturesRaw order
    ltrFeatureVectorMap.set(String(doc.entityId), [
      features.bm25Score,
      features.semanticScore,
      features.popularityScore,
      features.recencyScore,
      features.classMatchScore,
      features.attributeMatchScore,
      features.diversityScore,
      features.multilingualScore,
    ]);
    return {
      entityId: doc.entityId,
      retrievalScore: doc.finalScore,
      features,
      originalRank: idx + 1,
    };
  });

  const rerankedDocs = LTRRanker.rerank(rankableDocuments, queryClass, ltrModel);

  // Build proposed LTR rank map for safety evaluation
  const proposedLtrRankMap = new Map<string, number>(
    rerankedDocs.map((r) => [r.entityId, r.finalRank]),
  );

  // E5-T3: Build safety candidate descriptors + list context.
  // Safety is evaluated HERE (single pass) with the actual proposed LTR ranks.
  // H2 fix: hardConstraintViolations carries only the violations that caused
  // hardConstraintPass=false. When the candidate passes all hard constraints,
  // unmetConstraints may still have soft mismatches — exclude those here so the
  // safety envelope does not conflate soft-constraint mismatches with hard ones.
  const safetyDescriptors: SafetyCandidateDescriptor[] = rankedResults.map((doc, idx) => ({
    entityId: String(doc.entityId),
    heuristicRank: idx + 1,
    hardConstraintPass: doc.componentScores.hardConstraintPass,
    // When hardConstraintPass is true, there are no hard violations to report.
    hardConstraintViolations: doc.componentScores.hardConstraintPass ? [] : [...doc.unmetConstraints],
    anchorSimilarity: doc.componentScores.anchorSimilarity ?? 0,
    // E5-T3: sparseRank is now propagated from ScoredEntry to RankedResult (Wave 2 fix).
    // sparseRank === 1 enables protected-candidate Rule 3 for exact-known-item BM25 hits.
    sparseRank: doc.sparseRank ?? Infinity,
    heuristicScoreNormalized: Number.isFinite(doc.finalScore) ? doc.finalScore : 0,
    proposedLtrRank: proposedLtrRankMap.get(doc.entityId) ?? Infinity,
  }));
  const safetyListCtx = buildRerankSafetyListContext(safetyDescriptors);

  // Single-pass safety evaluation with actual proposed LTR ranks (H1 fix:
  // applyLearnedLtrRerank no longer runs a separate safety pass internally).
  const blockedByEnvelopeIds = new Set<string>();
  for (const desc of safetyDescriptors) {
    const safetyResult = evaluateRerankSafety(desc, safetyListCtx, []);
    if (!safetyResult.allowed) {
      blockedByEnvelopeIds.add(desc.entityId);
    }
  }

  const originalByEntity = new Map<string, RankedResult>(
    rankedResults.map((result) => [String(result.entityId), result]),
  );

  const results = rerankedDocs
    .map((reranked) => {
      const entityKey = reranked.entityId;
      const original = originalByEntity.get(entityKey);
      if (original === undefined) {
        return undefined;
      }

      // E5-T3: Safety envelope — blocked candidates keep heuristic score
      if (blockedByEnvelopeIds.has(entityKey)) {
        // Keep heuristic score + rank; only attach decomposition with no delta
        const decomp: ScoreDecomposition = {
          lexicalContribution: 0,
          semanticContribution: original.componentScores.semantic,
          anchorContribution: original.componentScores.anchorSimilarity ?? 0,
          attributeSatisfaction: original.componentScores.attributeAlignment,
          popularityContribution: original.componentScores.popularity,
          preferenceAlignmentContribution: original.componentScores.preferenceAlignment,
          heuristicScoreRaw: original.finalScore,
          heuristicScoreNormalized: Number.isFinite(original.finalScore) ? original.finalScore : 0,
          finalScore: original.finalScore,
        };
        return {
          ...original,
          scoreDecomposition: decomp,
        };
      }

      // Allowed — apply LTR score + build full decomposition
      const heuristicNorm = Number.isFinite(original.finalScore) ? original.finalScore : 0;
      const ltrNorm = Number.isFinite(reranked.ltrScore) ? reranked.ltrScore : heuristicNorm;
      const rerankDelta = ltrNorm - heuristicNorm;

      const decomp: ScoreDecomposition = {
        lexicalContribution: 0,
        semanticContribution: original.componentScores.semantic,
        anchorContribution: original.componentScores.anchorSimilarity ?? 0,
        attributeSatisfaction: original.componentScores.attributeAlignment,
        popularityContribution: original.componentScores.popularity,
        preferenceAlignmentContribution: original.componentScores.preferenceAlignment,
        heuristicScoreRaw: heuristicNorm,
        heuristicScoreNormalized: heuristicNorm,
        ltrScoreNormalized: ltrNorm,
        rerankDeltaNormalized: rerankDelta,
        // C4: attach the feature vector used for LTR inference so ScoreDecomposition
        // is self-contained for drift analysis and debugging.
        ...(ltrFeatureVectorMap.has(entityKey)
          ? { ltrFeatureVector: ltrFeatureVectorMap.get(entityKey) }
          : {}),
        finalScore: reranked.ltrScore,
      };

      return {
        ...original,
        finalScore: reranked.ltrScore,
        rank: reranked.finalRank,
        scoreDecomposition: decomp,
      };
    })
    .filter((result) => result !== undefined) as RankedResult[];
  return { results, skipReason: 'not_skipped' };
}

/**
 * Query-level constraint context. Computed ONCE per rank() call and reused
 * for every candidate, rather than rebuilding the inferred-attribute list,
 * tracked-attribute Set, and soft-unmet derivation per-candidate.
 *
 * Allocation math (200-candidate query): previously ~7 intermediate arrays
 * + 2 Sets per candidate = ~1800 allocations; now 1 Set + 1 array for the
 * full request, plus only candidate-specific work in `buildConstraintState`.
 */
interface QueryConstraintContext {
  readonly inferredConstraints: readonly string[];
  readonly trackedAttributes: ReadonlySet<string>;
  readonly softAttributes: readonly string[];
}

function buildQueryConstraintContext(input: RankingInput): QueryConstraintContext {
  const inferredSeen = new Set<string>();
  const inferredConstraints: string[] = [];
  for (const constraint of input.constraints.inferred) {
    if (!inferredSeen.has(constraint.attribute)) {
      inferredSeen.add(constraint.attribute);
      inferredConstraints.push(constraint.attribute);
    }
  }

  const trackedAttributes = new Set<string>();
  for (const c of input.constraints.hard) trackedAttributes.add(c.attribute);
  for (const c of input.constraints.soft) trackedAttributes.add(c.attribute);
  for (const a of inferredConstraints) trackedAttributes.add(a);

  const softAttributes: string[] = new Array<string>(input.constraints.soft.length);
  for (let i = 0; i < input.constraints.soft.length; i++) {
    softAttributes[i] = input.constraints.soft[i]!.attribute;
  }

  return { inferredConstraints, trackedAttributes, softAttributes };
}

function buildConstraintState(
  candidate: HybridCandidate,
  queryCtx: QueryConstraintContext,
): {
  readonly matchedConstraints: readonly string[];
  readonly unmetConstraints: readonly string[];
  readonly inferredConstraints: readonly string[];
} {
  const matchedSet = new Set(candidate.matchedConstraints);

  // Collect unmet constraints into a single dedup set to avoid building
  // 3 intermediate arrays (softUnmet, inferredUnmet, spread concat) then
  // a 4th `[...new Set(...)]` over the concatenation.
  const unmetSet = new Set<string>();
  const unmetHard = candidate.unmetHardConstraints;
  if (unmetHard !== undefined) {
    for (const attr of unmetHard) unmetSet.add(attr);
  }
  for (const attr of queryCtx.softAttributes) {
    if (!matchedSet.has(attr)) unmetSet.add(attr);
  }
  for (const attr of queryCtx.inferredConstraints) {
    if (!matchedSet.has(attr)) unmetSet.add(attr);
  }
  const unmetConstraints: string[] = [];
  for (const attr of unmetSet) unmetConstraints.push(attr);

  // Filter matched constraints against the query-level tracked-attributes
  // Set (built once per request in buildQueryConstraintContext).
  const tracked = queryCtx.trackedAttributes;
  const matchedConstraints: string[] = [];
  for (const attribute of candidate.matchedConstraints) {
    if (tracked.has(attribute)) matchedConstraints.push(attribute);
  }

  return {
    matchedConstraints,
    unmetConstraints,
    inferredConstraints: queryCtx.inferredConstraints,
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

    // Collect metadata in local variables; returned alongside results
    // in RankingOutput (no mutable instance fields).
    let localRerankExecuted = false;
    let localRerankGateReason: string | undefined;
    let localRuntimeSignal: RankerRuntimeSignal | undefined;
    let localPreRerankTop5: readonly string[] = [];
    let localScoreDriftRecord: ScoreDriftRecord | undefined;

    // Step 1: Compute all signals for each candidate
    const scored: ScoredEntry[] = [];

    // Step 2: Select weights based on query class, then overlay retrieval-mode
    // specific boosts from mode-weights.ts (producer prestige, recency, geo).
    // E3-U5: compiled-first — use ExecutionCompiler's resolved mode when available.
    const effectiveRetrievalMode = input.compiled?.execution.effectiveRetrievalMode ?? queryPlan.retrievalMode;
    const baseWeights = resolveWeights(queryPlan.queryClass);
    const modeProfile = getModeWeights(effectiveRetrievalMode);
    // Mode overlay: max(queryClass base, mode boost).
    // DEFAULT_WEIGHTS are all 0.0 (no-op) so neutral/undefined modes preserve base.
    // Explicit modes (producer_browse etc.) can only raise a signal, never suppress.
    // After overlay, re-normalise so the non-penalty sum is preserved — otherwise
    // Math.max can inflate the total (e.g. popularity 0.02→0.15 adds +0.13).
    // RCA5-04 fix: apply Math.max overlay across ALL 12 non-penalty ScoringWeights
    // fields, not just the 6 that were previously wired. Previously entityIntegrity,
    // anchorSimilarity, softConstraint, availability, criticScore, multilingualScore
    // were silently left at their query-class base values even when a mode profile
    // defined a higher floor (e.g. compare_candidates sets anchorSimilarityWeight=0.20
    // but the base anchored_similarity class already has 0.30, so max is a no-op there;
    // but for short_entity base=0.0 the overlay correctly raises it).
    const overlaid: ScoringWeights = {
      ...baseWeights,
      entityIntegrity: Math.max(baseWeights.entityIntegrity, modeProfile.entityIntegrityWeight),
      anchorSimilarity: Math.max(baseWeights.anchorSimilarity, modeProfile.anchorSimilarityWeight),
      semantic: Math.max(baseWeights.semantic, modeProfile.semanticWeight),
      softConstraint: Math.max(baseWeights.softConstraint, modeProfile.softConstraintWeight),
      attributeAlignment: Math.max(baseWeights.attributeAlignment, modeProfile.attributeAlignmentWeight),
      preferenceAlignment: Math.max(baseWeights.preferenceAlignment, modeProfile.preferenceAlignmentWeight),
      popularity: Math.max(baseWeights.popularity, modeProfile.popularityWeight),
      availability: Math.max(baseWeights.availability, modeProfile.availabilityWeight),
      producerPrestige: Math.max(baseWeights.producerPrestige, modeProfile.producerPrestigeWeight),
      recency: Math.max(baseWeights.recency, modeProfile.recencyWeight),
      criticScore: Math.max(baseWeights.criticScore, modeProfile.criticScoreWeight),
      multilingualScore: Math.max(baseWeights.multilingualScore, modeProfile.multilingualScoreWeight),
    };
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

    // Build query-level constraint context ONCE before the per-candidate loop.
    // Previously buildConstraintState() rebuilt the tracked-attribute Set and
    // inferred-attribute list for every candidate (O(n_candidates × n_constraints)
    // Sets allocated); now O(1) Set per request.
    const queryConstraintCtx = buildQueryConstraintContext(input);

    for (const candidate of candidates) {
      const componentScores = this.signalComputer.computeAll(
        candidate,
        queryPlan,
        constraints,
        anchorProfile,
        input.retrievalPlan,
        referenceYear,
        queryContainsHangul,
      );
      const constraintState = buildConstraintState(candidate, queryConstraintCtx);

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
        ...(candidate.style !== undefined ? { style: candidate.style } : {}),
        ...(candidate.classification !== undefined ? { classification: candidate.classification } : {}),
        ...(candidate.alcoholPct !== undefined ? { alcoholPct: candidate.alcoholPct } : {}),
        ...(candidate.certifications !== undefined ? { certifications: candidate.certifications } : {}),
        ...(candidate.pairing !== undefined ? { pairingTags: candidate.pairing } : {}),
        ...(candidate.occasion !== undefined ? { occasion: candidate.occasion } : {}),
        ...(candidate.priceBand !== undefined ? { priceBand: candidate.priceBand } : {}),
        ...(candidate.priceUsd !== undefined ? { priceUsd: candidate.priceUsd } : {}),
        // E1-T3: propagate sparseRank for 3rd-stage tie-break determinism
        ...(candidate.sparseRank !== undefined ? { sparseRank: candidate.sparseRank } : {}),
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

    // Step 6: Optionally rerank top-K via cross-encoder (T5.4: gate-controlled)
    let finalOrder: readonly ScoredEntry[] = viable;
    const hasLearnedRerank = this.ltrModels?.has(queryPlan.queryClass) ?? false;
    // Tracks whether the gate cleared the learned LTR rerank for this request.
    // Must only be set inside the `gateDecision.shouldRerank` block so the gate
    // is honoured — setting it outside would bypass short_entity / too_few_candidates
    // rules and run LTR on every query regardless of quality signals.
    let shouldApplyLearnedRerank = false;
    if (this.reranker !== undefined || hasLearnedRerank) {
      // E3-U5: compiled-first route for gate — falls back to V1 plan.route
      const gateEffectiveRoute = input.compiled?.execution.effectiveRoute ?? queryPlan.route;
      const gateDecision = evaluateRerankGate({
        candidateCount: viable.length,
        queryClass: queryPlan.queryClass,
        effectiveRoute: gateEffectiveRoute,
        hasAnchor: anchorProfile !== undefined,
        ...(input.rerankForced !== undefined ? { rerankForced: input.rerankForced } : {}),
      });

      localRerankGateReason = gateDecision.reason;

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
            localRerankExecuted = true;
            localRuntimeSignal = { rerankerStatus: 'executed' };
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
        if (hasLearnedRerank) {
          localRerankExecuted = true;
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
        ...(entry.vintageYear !== undefined ? { vintageYear: entry.vintageYear } : {}),
        ...(entry.body !== undefined ? { body: entry.body } : {}),
        ...(entry.tannin !== undefined ? { tannin: entry.tannin } : {}),
        ...(entry.acidity !== undefined ? { acidity: entry.acidity } : {}),
        ...(entry.sweetness !== undefined ? { sweetness: entry.sweetness } : {}),
        ...(entry.criticScoreNormalized !== undefined
          ? {
              // Clamp locally: upstream signal-computer normalizes to [0,1] via clamp01(),
              // but a mutation or NaN upstream could leak >1.0, producing scores >100.
              avgCriticProxyScore: Math.round(
                CRITIC_PROXY_SCORE_DISPLAY_BASE + clamp01(entry.criticScoreNormalized) * CRITIC_PROXY_SCORE_DISPLAY_SPAN,
              ),
              criticScoreNormalized: entry.criticScoreNormalized,
            }
          : {}),
        ...(entry.grapePrimaryEnc !== undefined ? { grapePrimaryEnc: entry.grapePrimaryEnc } : {}),
        ...(entry.regionEnc !== undefined ? { regionEnc: entry.regionEnc } : {}),
        ...(entry.countryEnc !== undefined ? { countryEnc: entry.countryEnc } : {}),
        ...(entry.style !== undefined ? { style: entry.style } : {}),
        ...(entry.classification !== undefined ? { classification: entry.classification } : {}),
        ...(entry.alcoholPct !== undefined ? { alcoholPct: entry.alcoholPct } : {}),
        ...(entry.certifications !== undefined ? { certifications: entry.certifications } : {}),
        ...(entry.pairingTags !== undefined ? { pairingTags: entry.pairingTags } : {}),
        ...(entry.occasion !== undefined ? { occasion: entry.occasion } : {}),
        ...(entry.priceBand !== undefined ? { priceBand: entry.priceBand } : {}),
        ...(entry.priceUsd !== undefined ? { priceUsd: entry.priceUsd } : {}),
        // E5-T3: propagate sparse BM25 rank for rerank-safety protected-candidate Rule 3
        ...(entry.sparseRank !== undefined ? { sparseRank: entry.sparseRank } : {}),
      };
    });

    if (shouldApplyLearnedRerank) {
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
      const ltrOutcome = applyLearnedLtrRerank(results, queryPlan.queryClass, this.ltrModels);

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
    }

    const metadata: RankingMetadata = {
      coarsePruneSummary: localCoarsePruneSummary,
      rerankExecuted: localRerankExecuted,
      rerankGateReason: localRerankGateReason,
      runtimeSignal: localRuntimeSignal,
      preRerankTop5: localPreRerankTop5,
      ...(localScoreDriftRecord !== undefined ? { scoreDriftRecord: localScoreDriftRecord } : {}),
    };

    return { results, metadata };
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
    // Filter non-finite scores BEFORE computing min/max — a single +/-Infinity
    // would make rawRange Infinity, all scores fall to the 0.5 fallback, and a
    // -Infinity min would propagate NaN through the entire normalization (NaN
    // then poisons every blendedScore via 0.5*NaN + 0.5*orig = NaN).
    let minRaw = Infinity;
    let maxRaw = -Infinity;
    for (const r of rerankResults) {
      if (!Number.isFinite(r.score)) continue;
      if (r.score < minRaw) minRaw = r.score;
      if (r.score > maxRaw) maxRaw = r.score;
    }
    const rawRange = Number.isFinite(minRaw) && Number.isFinite(maxRaw)
      ? maxRaw - minRaw
      : NaN;

    function normalizeRerankScore(raw: number): number {
      if (
        !Number.isFinite(raw)
        || !Number.isFinite(rawRange)
        || rawRange < RERANK_SCORE_MIN_MAX_RANGE_EPSILON
      ) return RERANK_SCORE_NORMALIZED_NEUTRAL;
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
      const rawW = effectiveRerankBlendWeight(queryClass, this.rerankBlendScale);
      // Guard against NaN/Infinity from a misconfigured rerankBlendScale (e.g. NaN env var).
      // NaN * normScore = NaN which would propagate into finalScore and leak into API responses.
      const w = Number.isFinite(rawW) ? rawW : RERANK_BLEND_WEIGHT_FALLBACK;
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

    // Sort the entire combined set (top-K reranked + rest) by finalScore.
    // Previous code concatenated `[...rerankedTopK, ...rest]` which preserved
    // top-K position even when a rest candidate's original score now exceeded
    // a blended top-K score — producing rank inversions across the boundary.
    // Re-sorting fixes this and applies the same NaN-safe tie-break as the
    // primary sort.
    // Use .concat() instead of spread — rest can be thousands of entries and
    // spread pushes all elements onto the call stack (crashes at ~65K; Rule 9).
    const combined = rerankedTopK.concat(rest);
    combined.sort(compareScoredEntriesByFinalScoreDesc);
    return combined;
  }
}

// ─── E5-T6: ScoreDriftRecord helpers ─────────────────────────────────────────

/**
 * Compute normalized Kendall tau distance between two entity-ID orderings.
 *
 * Returns a value in [0, 1]:
 *   0 = identical order
 *   1 = completely reversed
 *
 * Only entities present in BOTH lists are compared; entities unique to one
 * list are ignored (avoids penalizing safety-evicted candidates).
 *
 * Time: O(n²) where n = common list length (typically ≤ 3).
 */
function computeKendallTauDistance(
  listA: readonly string[],
  listB: readonly string[],
): number {
  // Build intersection in listA order
  const setB = new Set(listB);
  const common = listA.filter((id) => setB.has(id));
  const n = common.length;
  if (n < 2) return 0;

  // For each id in common, record its position in listB
  const posB = new Map<string, number>(listB.map((id, i) => [id, i]));

  let discordant = 0;
  const totalPairs = (n * (n - 1)) / 2;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const rankBi = posB.get(common[i]!) ?? Infinity;
      const rankBj = posB.get(common[j]!) ?? Infinity;
      // In listA: i < j (i ranks higher). In listB: discordant if j ranks higher than i.
      if (rankBj < rankBi) {
        discordant++;
      }
    }
  }

  return totalPairs > 0 ? discordant / totalPairs : 0;
}

/**
 * Compute mean absolute normalized score delta across reranked candidates.
 *
 * Compares each candidate's heuristic score (from safetyDescriptors) to
 * the LTR finalScore (from ltrResults). Candidates missing from either
 * side are skipped.
 */
function computeAverageRerankDelta(
  safetyDescriptors: readonly SafetyCandidateDescriptor[],
  ltrResults: readonly RankedResult[],
): number {
  const heuristicScoreMap = new Map<string, number>(
    safetyDescriptors.map((d) => [d.entityId, d.heuristicScoreNormalized]),
  );

  let totalDelta = 0;
  let count = 0;
  for (const r of ltrResults) {
    const id = String(r.entityId);
    const heuristicScore = heuristicScoreMap.get(id);
    if (heuristicScore === undefined) continue;
    const ltrScore = Number.isFinite(r.finalScore) ? r.finalScore : 0;
    totalDelta += Math.abs(ltrScore - heuristicScore);
    count++;
  }

  return count > 0 ? totalDelta / count : 0;
}
