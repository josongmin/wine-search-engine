import type { CanonicalEntityId, QueryClass } from '../../shared/types/index.js';
import { liftBundleToAtoms } from '../../shared/types/index.js';
import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';
import type { CandidateProvenance } from '../../retrieval/model/candidate-envelope.js';
import { PROVENANCE_QUERY_VIEWS, type ProvenanceQueryView } from '../../retrieval/model/provenance.js';
import type { RankingInput } from '../model/ranking-input.js';
import type { RankedResult, ComponentScores, CoarsePruneStageSummary } from '../model/ranked-result.js';
import type { RankerRuntimeSignal, RerankerFailureReason } from '../model/ranking-runtime-signal.js';
import type {
  RankingMetadata,
  RankingOutput,
  RerankDecision,
  RerankDecisionCode,
} from '../port/ranker.port.js';
import type { RerankerPort, RerankCandidate } from '../port/reranker.port.js';
import type { WineAttributeEncoderPort } from '../port/wine-attribute-encoder.port.js';
import type { QueryClassWeights } from '../index.js';
import {
  resolveWeights,
  resolveChannelAwareWeights,
  applySituationIntentWeightOverlay,
} from '../model/scoring-weights.js';
import type { ScoringWeights } from '../model/scoring-weights.js';
import { getModeWeights, applyModeWeightOverlay, scaleOverlaidWeights } from '../model/mode-weights.js';
import { effectiveRerankBlendWeight } from './rerank-blend.js';
import { type SignalComputer } from './signal-computer.js';
import { type ScoreAggregator, RankComputationError } from './score-aggregator.js';
import { type EvidenceMapper } from './evidence-mapper.js';
import { WineAttributeEncoders } from './wine-attribute-encoder.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { evaluateRerankGate } from './rerank-gate.js';
import { LTRRanker } from './ltr-ranker.js';
import { extractLTRFeatures } from './ltr-feature-extractor.js';
import { MS_PER_DAY } from '../../shared/utils/time-units.js';
import {
  projectHybridCandidateToRankedResultAttributes,
  projectRankedResultSourceAttributes,
} from './ranked-result-attribute-projection.js';
import {
  evaluateRerankSafety,
  buildRerankSafetyListContext,
} from './rerank-safety.js';
import type { SafetyCandidateDescriptor } from './rerank-safety.js';
import type { ScoreDecomposition, ScoreDriftRecord } from '../model/score-decomposition.js';
import type { LTRScoreComponents } from './ltr-feature-extractor.js';
import { incrementLtrInferenceComponentScoreAbsent } from '../../../observability/silent-skip-counters.js';

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
 * Exported for regression tests (E1-P03 tie-break suite).
 */
export interface ScoredEntry {
  readonly entityId: CanonicalEntityId;
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
  /**
   * ADR-014 Phase 1b.3b: graph slot-node IDs the candidate matched.
   * Absent when the compiled query carried no graph — the flat
   * `matchedConstraints` above is the legacy surface in that case.
   */
  readonly matchedAtomRefs?: readonly string[] | undefined;
  /**
   * ADR-014 Phase 1b.3b: graph slot-node IDs required-but-unmet under
   * graph semantics. Absent when no graph is present.
   */
  readonly unmetAtomRefs?: readonly string[] | undefined;
  readonly retrievalProvenance?: CandidateProvenance | undefined;
  /**
   * E1-T3: sparse (BM25) rank from retrieval — used as tie-break stage after
   * finalScore and channelMatchType, before entityId. Lower rank = better lexical match.
   * Present only for candidates retrieved via sparse_bm25 channel.
   */
  readonly sparseRank?: number | undefined;
  /**
   * E1-T3: dense (ANN embedding) rank from retrieval.
   * Present only for candidates retrieved via dense_semantic channel.
   */
  readonly denseRank?: number | undefined;
  /**
   * E1-T3: anchor-neighbourhood rank from retrieval.
   * Present only for candidates retrieved via anchor_similarity channel.
   */
  readonly anchorRank?: number | undefined;
  /**
   * E1-T3: evidence quality tier for deterministic stage-2 tie-break.
   *
   * Values (lower = stronger exact/known-item evidence):
   *   0 — exact_alias_match / known_item_lookup protected candidate
   *   1 — anchor-conditioned candidate
   *   2 — ordinary lexical/dense candidate with some provenance
   *   3 — weak candidate with no lexical/protected evidence
   */
  readonly evidenceQualityTier?: number | undefined;
  /**
   * E1-T3: Lexical exactness tier for stage-3 tie-break.
   *
   * Captures how closely the candidate's surface form matched the query
   * text via BM25 / alias lookup strategies, independently of which
   * retrieval channels the candidate appeared in.
   *
   * Values (lower = better lexical match, consistent with sparseRank):
   *   0 — strict / accentless / compact query views
   *   1 — transliterated / phonetic_compact query views
   *   2 — vintage_canonicalized / vintage_stripped query views
   *   3 — no recognized query-view evidence
   */
  readonly lexicalExactnessTier?: number | undefined;
  readonly drinkingWindowStart?: number | undefined;
  readonly drinkingWindowEnd?: number | undefined;
  readonly drinkingWindowModelVersion?: string | undefined;

  // Wine attributes for Epic 15 dynamic prediction
  readonly vintageYear?: number | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly avgCriticProxyScore?: number | undefined;
  readonly criticScoreNormalized?: number | undefined;
  readonly grapePrimaryEnc?: number | undefined;
  readonly regionEnc?: number | undefined;
  readonly countryEnc?: number | undefined;

  // Display metadata for new entity summary fields
  readonly style?: string | undefined;
  readonly wineType?: string | undefined;
  readonly classification?: string | undefined;
  readonly alcoholPct?: number | undefined;
  readonly certifications?: readonly string[] | undefined;
  readonly pairingTags?: readonly string[] | undefined;
  readonly occasion?: readonly string[] | undefined;

  // Price data for agent/response surface
  readonly priceBand?: string | undefined;
  readonly priceUsd?: number | undefined;

  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;
}

const MODEL_STALENESS_THRESHOLD_DAYS = 30;

// MS_PER_DAY imported from SSoT: @domain/shared/utils/time-units
const MILLISECONDS_PER_DAY = MS_PER_DAY;

/** LambdaMART weight vector length (must match {@link extractLTRFeatures} output). */
const LTR_MODEL_FEATURE_DIMENSION = 8;

/** Entity IDs captured after primary sort for funnel rerank telemetry. */
const PRE_RERANK_TOP_ENTITY_SNAPSHOT_COUNT = 5;

/**
 * Treat reranker batch as degenerate when max-min below this and keep the
 * heuristic score instead of fabricating a midpoint blend.
 * Logit-scale scores can differ by ~1e-7 from floating-point noise; 1e-8 was
 * overly tight and collapsed distinct candidates into the degraded path.
 */
const RERANK_SCORE_MIN_MAX_RANGE_EPSILON = 1e-6;
/** Degradation reason emitted when rerank scores cannot be normalized safely. */
const RERANK_SCORE_NORMALIZATION_FAILED_REASON = 'reranker_score_normalization_failed';
/** Degradation reason emitted when the blend weight is not finite. */
const RERANK_BLEND_WEIGHT_INVALID_REASON = 'reranker_blend_weight_invalid';

/**
 * Final-score comparisons treat values within this epsilon as tied so ordering
 * falls through to entityId (deterministic tie-break, RFC-009/015).
 */
const FINAL_SCORE_SORT_TIE_EPSILON = 1e-12;
/** Replay-grade ranking policy version for determinism fingerprinting. */
export const RANKING_POLICY_VERSION = 'ranker-policy-v2.0';
const EVIDENCE_QUALITY_TIER_UNKNOWN = 3;
const LEXICAL_EXACTNESS_TIER_EXACT = 0;
const LEXICAL_EXACTNESS_TIER_TRANSLITERATED = 1;
const LEXICAL_EXACTNESS_TIER_VINTAGE = 2;
const EXACT_QUERY_VIEWS = new Set<ProvenanceQueryView>(['strict', 'accentless', 'compact']);
const TRANSLITERATED_QUERY_VIEWS = new Set<ProvenanceQueryView>(['transliterated', 'phonetic_compact']);
const VINTAGE_QUERY_VIEWS = new Set<ProvenanceQueryView>(['vintage_canonicalized', 'vintage_stripped']);

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
  'giftSuitability', 'beginnerSuitability',
] as const;

function buildObservedLtrInferenceScoreComponents(
  componentScores: ComponentScores,
): LTRScoreComponents {
  const semantic =
    componentScores.semantic !== undefined
      ? { semantic: componentScores.semantic }
      : (incrementLtrInferenceComponentScoreAbsent('semantic'), {});
  const popularity =
    componentScores.popularity !== undefined
      ? { popularity: componentScores.popularity }
      : (incrementLtrInferenceComponentScoreAbsent('popularity'), {});
  const attributeAlignment =
    componentScores.attributeAlignment !== undefined
      ? { attributeAlignment: componentScores.attributeAlignment }
      : (incrementLtrInferenceComponentScoreAbsent('attributeAlignment'), {});
  const preferenceAlignment =
    componentScores.preferenceAlignment !== undefined
      ? { preferenceAlignment: componentScores.preferenceAlignment }
      : (incrementLtrInferenceComponentScoreAbsent('preferenceAlignment'), {});
  const multilingualScore =
    componentScores.multilingualScore !== undefined
      ? { multilingualScore: componentScores.multilingualScore }
      : (incrementLtrInferenceComponentScoreAbsent('multilingualScore'), {});

  return {
    ...semantic,
    ...popularity,
    ...attributeAlignment,
    ...preferenceAlignment,
    ...multilingualScore,
  };
}

function sumNonPenaltyWeights(weights: ScoringWeights): number {
  let total = 0;
  for (const key of NON_PENALTY_WEIGHT_FIELDS) {
    total += weights[key];
  }
  return total;
}

/**
 * E1-T3: Compute evidence/lexical tiers for a scored entry.
 *
 * Evidence quality is the stage-2 axis: it measures how strong the
 * exact-known-item evidence is before we look at lexical fidelity.
 *
 * Lexical exactness is the stage-3 axis: it measures how well the candidate
 * matched the query as a surface-form text string, independent of which
 * retrieval channels it appeared in.
 *
 * Tiers are pre-computed at scoring time from retrieval provenance metadata.
 */
function getEvidenceQualityTier(entry: ScoredEntry): number {
  return entry.evidenceQualityTier ?? EVIDENCE_QUALITY_TIER_UNKNOWN;
}

function getLexicalExactnessTier(entry: ScoredEntry): number {
  return entry.lexicalExactnessTier ?? LEXICAL_EXACTNESS_TIER_UNKNOWN;
}

/** Sentinel tier value for entries whose lexical exactness could not be determined. */
const LEXICAL_EXACTNESS_TIER_UNKNOWN = 3;

/**
 * E1-T3: Build the lexical exactness tier from retrieval provenance metadata.
 *
 * Reads canonical provenance query-view vocabulary only.
 */
function buildLexicalExactnessTier(candidate: HybridCandidate): number {
  const matchedViews = candidate.retrievalProvenance?.queryViewMatches
    .map((match) => match.viewName)
    .filter((view): view is ProvenanceQueryView => (
      PROVENANCE_QUERY_VIEWS as readonly string[]
    ).includes(view)) ?? [];

  if (matchedViews.some((view) => EXACT_QUERY_VIEWS.has(view))) {
    return LEXICAL_EXACTNESS_TIER_EXACT;
  }
  if (matchedViews.some((view) => TRANSLITERATED_QUERY_VIEWS.has(view))) {
    return LEXICAL_EXACTNESS_TIER_TRANSLITERATED;
  }
  if (matchedViews.some((view) => VINTAGE_QUERY_VIEWS.has(view))) {
    return LEXICAL_EXACTNESS_TIER_VINTAGE;
  }

  return LEXICAL_EXACTNESS_TIER_UNKNOWN;
}

function buildEvidenceQualityTier(candidate: HybridCandidate): number {
  const protectedReason = candidate.retrievalProvenance?.protectedInclusionReason;
  if (protectedReason === 'exact_alias_match' || protectedReason === 'known_item_lookup') {
    return 0;
  }
  if (candidate.anchorRank !== undefined) {
    return 1;
  }
  if (
    candidate.retrievalProvenance !== undefined
    || candidate.sparseRank !== undefined
    || candidate.denseRank !== undefined
  ) {
    return 2;
  }
  return EVIDENCE_QUALITY_TIER_UNKNOWN;
}

/**
 * Descending sort by finalScore; NaN-safe; 5-stage deterministic tie-break.
 *
 * Stage 1: finalScore descending (NaN → last)
 * Stage 2: evidenceQualityTier ascending (lower = stronger exact/known-item evidence)
 * Stage 3: lexicalExactnessTier ascending (lower = better surface-form match)
 * Stage 4: sparseRank ascending (lower BM25 rank = better lexical match; absent → last)
 * Stage 5: entityId ascending (stable lexicographic tie-break, RFC-009/015)
 *
 * E1-T3: exact-known-item evidence beats generic lexical evidence; lexical
 * fidelity then breaks remaining ties before sparse rank and entityId.
 */
export function compareScoredEntriesByFinalScoreDesc(a: ScoredEntry, b: ScoredEntry): number {
  const aFinite = Number.isFinite(a.finalScore);
  const bFinite = Number.isFinite(b.finalScore);
  if (!aFinite && !bFinite) {
    // Stages 2-5 for NaN-NaN ties
    const aEvidence = getEvidenceQualityTier(a);
    const bEvidence = getEvidenceQualityTier(b);
    if (aEvidence !== bEvidence) return aEvidence - bEvidence;
    const aTier = getLexicalExactnessTier(a);
    const bTier = getLexicalExactnessTier(b);
    if (aTier !== bTier) return aTier - bTier;
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
  // Stage 2: evidence quality tier ascending (lower = stronger exact/known-item evidence)
  const aEvidence = getEvidenceQualityTier(a);
  const bEvidence = getEvidenceQualityTier(b);
  if (aEvidence !== bEvidence) return aEvidence - bEvidence;
  // Stage 3: lexical exactness tier ascending (lower = better surface-form match)
  const aTier = getLexicalExactnessTier(a);
  const bTier = getLexicalExactnessTier(b);
  if (aTier !== bTier) return aTier - bTier;
  // Stage 4: sparseRank ascending (absent = Infinity → loses)
  const aSparse = a.sparseRank ?? Infinity;
  const bSparse = b.sparseRank ?? Infinity;
  if (aSparse !== bSparse) return aSparse - bSparse;
  // Stage 5: entityId ascending
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
type LtrRerankSkipReason =
  | 'not_skipped'
  | 'no_model_for_query_class'
  | 'empty_candidates'
  | 'feature_dimension_mismatch';

function applyLearnedLtrRerank(
  rankedResults: readonly RankedResult[],
  queryClass: QueryClass,
  ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined,
): { results: RankedResult[]; skipReason: LtrRerankSkipReason; modelId?: string; ltrSaturated?: boolean } {
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
    const features = extractLTRFeatures(
      buildObservedLtrInferenceScoreComponents(doc.componentScores),
    );
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

  const ltrResult = LTRRanker.rerank(rankableDocuments, queryClass, ltrModel);
  const rerankedDocs = ltrResult.documents;
  const ltrSaturated = ltrResult.saturated;

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
          semanticContribution: original.componentScores.semantic ?? 0,
          anchorContribution: original.componentScores.anchorSimilarity ?? 0,
          attributeSatisfaction: original.componentScores.attributeAlignment ?? 0,
          popularityContribution: original.componentScores.popularity ?? 0,
          preferenceAlignmentContribution: original.componentScores.preferenceAlignment ?? 0,
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
        semanticContribution: original.componentScores.semantic ?? 0,
        anchorContribution: original.componentScores.anchorSimilarity ?? 0,
        attributeSatisfaction: original.componentScores.attributeAlignment ?? 0,
        popularityContribution: original.componentScores.popularity ?? 0,
        preferenceAlignmentContribution: original.componentScores.preferenceAlignment ?? 0,
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
  // P0-5: queryClass is the model identifier (key into ltrModels Map).
  // Returned so rank() can populate rerankDecision.modelId.
  return { results, skipReason: 'not_skipped', modelId: ltrModel.queryClass, ltrSaturated };
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
  graph?: ConstraintGraph  ,
): {
  readonly matchedConstraints: readonly string[];
  readonly unmetConstraints: readonly string[];
  readonly inferredConstraints: readonly string[];
  readonly matchedAtomRefs?: readonly string[] | undefined;
  readonly unmetAtomRefs?: readonly string[] | undefined;
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

  // ADR-014 Phase 1b.3b: prefer annotator-provided `matchedAtomRefs` /
  // `unmetAtomRefs` when the candidate already carries them (batch
  // annotator path); otherwise reconstruct from the graph nodes here so
  // unit tests and non-annotated inputs still see the graph-derived slot
  // IDs. Absent graph → keep the flat legacy shape unchanged.
  if (graph !== undefined) {
    if (
      candidate.matchedAtomRefs !== undefined &&
      candidate.unmetAtomRefs !== undefined
    ) {
      return {
        matchedConstraints,
        unmetConstraints,
        inferredConstraints: queryCtx.inferredConstraints,
        matchedAtomRefs: candidate.matchedAtomRefs,
        unmetAtomRefs: candidate.unmetAtomRefs,
      };
    }
    const matchedAtomRefs: string[] = [];
    const unmetAtomRefs: string[] = [];
    for (const node of graph.nodes) {
      if (node.kind !== 'slot') continue;
      if (matchedSet.has(node.attribute)) {
        matchedAtomRefs.push(node.nodeId);
      } else {
        unmetAtomRefs.push(node.nodeId);
      }
    }
    return {
      matchedConstraints,
      unmetConstraints,
      inferredConstraints: queryCtx.inferredConstraints,
      matchedAtomRefs,
      unmetAtomRefs,
    };
  }

  return {
    matchedConstraints,
    unmetConstraints,
    inferredConstraints: queryCtx.inferredConstraints,
  };
}

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
    const overlaid: ScoringWeights = applyModeWeightOverlay(baseWeights, modeProfile);
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
    const queryContainsHangul = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(
      queryPlan.rawQuery,
    );

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
              localRerankModelId = this.reranker?.modelId;
              remoteRerankApplied = true;
            }
          } catch (err) {
            stageTimer?.end('ranking.cross_encoder');
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
      const ltrOutcome = applyLearnedLtrRerank(results, queryPlan.queryClass, this.ltrModels);
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
    stageTimer?: NonNullable<RankingInput['requestContext']>['stageTimer'],
  ): Promise<{
    readonly results: readonly ScoredEntry[];
    readonly runtimeSignal?: RankerRuntimeSignal | undefined;
    /** True when normalization failed for ALL top-K candidates (collapsed/NaN batch). */
    readonly normalizationFailed?: boolean | undefined;
  }> {
    const topK = viable.slice(0, topKLimit);
    const rest = viable.slice(topKLimit);
    const degradationReasons: string[] = [];

    // Build wine-aware passage text for the cross-encoder (RFC-017 §5.2).
    const rerankCandidates: RerankCandidate[] = topK.map((entry) => ({
      entityId: entry.entityId,
      text: buildWineText(entry),
    }));

    const reranker = this.reranker;
    if (reranker === undefined) {
      throw new Error('applyReranking requires reranker');
    }
    stageTimer?.start('ranking.cross_encoder.remote');
    const rerankResults = await reranker.rerank(
      query,
      rerankCandidates,
      topKLimit,
    );
    stageTimer?.end('ranking.cross_encoder.remote');

    stageTimer?.start('ranking.cross_encoder.postprocess');
    try {
      // Build lookups
      const rerankScoreMap = new Map(
        rerankResults.map((r) => [String(r.entityId), r.score]),
      );
      const entryMap = new Map(
        topK.map((entry) => [String(entry.entityId), entry]),
      );

    // Normalise reranker scores to [0, 1] before blending.
    // Cross-encoder logits (e.g. BGE-reranker) are typically in [-10, +15];
    // min-max within the batch preserves relative ordering while keeping the
    // scale compatible with the original aggregated score (also [0, 1]).
    // Non-finite or collapsed score batches are treated as a degraded rerank:
    // we keep the heuristic score instead of fabricating a midpoint.
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

    function normalizeRerankScore(raw: number, originalScore: number): number {
      if (
        !Number.isFinite(raw)
        || !Number.isFinite(rawRange)
        || rawRange < RERANK_SCORE_MIN_MAX_RANGE_EPSILON
      ) {
        if (!degradationReasons.includes(RERANK_SCORE_NORMALIZATION_FAILED_REASON)) {
          degradationReasons.push(RERANK_SCORE_NORMALIZATION_FAILED_REASON);
        }
        return originalScore;
      }
      // Min-max within batch: maps to [0, 1] preserving relative order.
      // Sigmoid compression is unnecessary when min-max already bounds the range.
      return (raw - minRaw) / rawRange;
    }

    // T-E6-02: Detect batch-level normalization failure BEFORE per-candidate loop.
    // When rawRange is NaN or below epsilon, normalizeRerankScore returns
    // originalScore for every candidate — the rerank has zero effect but
    // previously reported applied=true. Surface this as normalizationFailed
    // so the caller can set the correct RerankDecision.
    const batchNormalizationFailed =
      !Number.isFinite(rawRange) || rawRange < RERANK_SCORE_MIN_MAX_RANGE_EPSILON;

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
      // A non-finite blend weight is a configuration failure, so fall back to
      // the heuristic score path instead of fabricating a midpoint blend.
      const w = Number.isFinite(rawW) ? rawW : 0;
      if (!Number.isFinite(rawW) && !degradationReasons.includes(RERANK_BLEND_WEIGHT_INVALID_REASON)) {
        degradationReasons.push(RERANK_BLEND_WEIGHT_INVALID_REASON);
      }
      const normScore = normalizeRerankScore(r.score, original.finalScore);
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
      return {
        results: combined,
        ...(batchNormalizationFailed ? { normalizationFailed: true } : {}),
        ...(degradationReasons.length > 0
          ? {
              runtimeSignal: {
                rerankerStatus: 'executed',
                degradation: {
                  executionMode: 'degraded',
                  degradationReasons,
                },
              } as RankerRuntimeSignal,
            }
          : {}),
      };
    } finally {
      stageTimer?.end('ranking.cross_encoder.postprocess');
    }
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
