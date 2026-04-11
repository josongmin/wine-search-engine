/**
 * Shared LTR Feature Extractor — the SINGLE source of truth for mapping
 * score components to RankingFeatures.
 *
 * CRITICAL INVARIANT: Both inference (search.usecase.ts) and training
 * (ltr-training-service.ts) MUST call extractLTRFeatures() to produce
 * RankingFeatures. This makes train-serve skew structurally impossible.
 *
 * If you need to add a new feature or change how a feature is computed,
 * change it HERE — both pipelines will pick up the change automatically.
 */

import type { RankingFeatures } from './lambdamart-ranker.js';
import type { QueryTargetType } from '../../query/model/query-target-type.js';


/**
 * The minimal score components needed for LTR feature extraction.
 * This is the shared contract between the ranking pipeline (ComponentScores)
 * and the evaluation pipeline (stored in EvalResult).
 *
 * Fields correspond 1:1 to the non-zero RankingFeatures:
 *   semantic           → semanticScore
 *   popularity         → popularityScore
 *   attributeAlignment → attributeMatchScore
 *   preferenceAlignment→ classMatchScore
 *   criticScore        → criticScore (Track-C / Vivino rating proxy)
 *   recency            → recencyScore (vintage age decay)
 *   producerPrestige   → producerPrestigeScore (winery_rating)
 *   multilingualScore  → multilingualScore (Korean query × Korean alias match)
 */
export interface LTRScoreComponents {
  readonly semantic: number;
  readonly popularity: number;
  readonly attributeAlignment: number;
  readonly preferenceAlignment: number;
  /** Critic score [0,1]: Track-C criticProxy or Vivino ratingAvg/5. Undefined = absent. */
  readonly criticScore?: number | undefined;
  /** Vintage recency signal [0,1]. Undefined when vintageYear is absent. */
  readonly recency?: number | undefined;
  /** Producer prestige [0,1] from winery_rating. Undefined = absent from index. */
  readonly producerPrestige?: number | undefined;
  /** Multilingual (Korean) match signal {0,1}. */
  readonly multilingualScore?: number | undefined;
}

/**
 * Extracts LTR ranking features from score components.
 *
 * This is the SINGLE function that both inference and training use.
 * Changing this function changes both pipelines simultaneously,
 * eliminating train-serve skew by construction.
 *
 * Feature mapping:
 *   - 4 core signals from score components (unchanged)
 *   - 4 SOTA++ signals now populated from real data
 *     (previously zero sentinels: bm25Score, recencyScore, diversityScore, multilingualScore)
 *
 * Notes:
 * - bm25Score remains 0.0: Vespa does not expose per-candidate BM25 scores in
 *   query responses without a custom summary expression. When Vespa custom
 *   rank features are wired, replace 0.0 with the candidate's bm25 rank signal.
 * - diversityScore remains 0.0: diversity is computed at the set level in
 *   SignalComputer.computeSetDiversity() but is not yet carried per-candidate.
 *   When per-candidate diversity is added to ComponentScores, map it here.
 *
 * @param scores - Score components from ranking (inference) or stored eval data (training)
 * @returns RankingFeatures for LambdaMART scoring
 */
export function extractLTRFeatures(scores: LTRScoreComponents): RankingFeatures {
  return {
    // Core signals — directly from score components
    semanticScore: scores.semantic,
    popularityScore: scores.popularity,
    attributeMatchScore: scores.attributeAlignment,
    classMatchScore: scores.preferenceAlignment,

    // SOTA++ signals — now real values (previously zero sentinels)
    // recencyScore: 0.0 = "no recency data" which is intentionally neutral-to-negative
    // (a wine with unknown vintage is not rewarded for recency).
    recencyScore: scores.recency ?? 0.0,
    // multilingualScore: 0.0 when absent — absent multilingual data is treated as
    // no signal (not rewarded). Previously defaulted to 0.5 (MULTILINGUAL_SCORE_NEUTRAL)
    // which caused train-serve skew by rewarding missing-data wines at inference time.
    multilingualScore: scores.multilingualScore ?? 0.0,

    // bm25Score: Vespa BM25 not yet exposed per-candidate in query responses.
    // This remains 0.0 until Vespa custom rank features are wired to ranking input.
    bm25Score: 0.0,

    // diversityScore: set-level signal, not yet per-candidate.
    // Remains 0.0 until ComponentScores gains a per-candidate diversity field.
    diversityScore: 0.0,
  };
}

/**
 * Extended LTR feature extraction for offline training that includes
 * additional prestige, critic, and query-target-type signals not yet in the
 * 8-feature LambdaMART model. Used by ltr-training-service.ts for
 * next-generation model training without affecting the live inference path.
 *
 * When the next LambdaMART model version adds these features, promote
 * them to extractLTRFeatures() and update RankingFeatures accordingly.
 */
export interface ExtendedLTRFeatures extends RankingFeatures {
  readonly criticScoreFeature: number;
  readonly producerPrestigeFeature: number;
  /**
   * RFC-017 §9: query_target_type as 1-hot encoding (4 binary features).
   * Encoding: isTargetWine | isTargetProducer | isTargetRegion | isTargetStyle
   * 'unknown' → all zeros (no signal).
   *
   * LambdaMART can learn that producer-targeted queries should weight
   * producerPrestige higher, region queries should weight regionMatch higher, etc.
   */
  readonly isTargetWine: 0 | 1;
  readonly isTargetProducer: 0 | 1;
  readonly isTargetRegion: 0 | 1;
  readonly isTargetStyle: 0 | 1;
}

/** Neutral producer prestige feature when component missing. */
const LTR_PRODUCER_PRESTIGE_FEATURE_DEFAULT = 0.5;

/**
 * Encodes QueryTargetType as 4 binary 1-hot features.
 * 'unknown' maps to all-zeros (neutral — no target type signal).
 */
function encodeQueryTargetType(
  targetType: QueryTargetType | undefined,
): Pick<ExtendedLTRFeatures, 'isTargetWine' | 'isTargetProducer' | 'isTargetRegion' | 'isTargetStyle'> {
  return {
    isTargetWine: targetType === 'wine' ? 1 : 0,
    isTargetProducer: targetType === 'producer' ? 1 : 0,
    isTargetRegion: targetType === 'region' ? 1 : 0,
    isTargetStyle: targetType === 'style' ? 1 : 0,
  };
}

export function extractExtendedLTRFeatures(
  scores: LTRScoreComponents,
  targetType?: QueryTargetType | undefined,
): ExtendedLTRFeatures {
  return {
    ...extractLTRFeatures(scores),
    criticScoreFeature: scores.criticScore ?? 0.0,
    producerPrestigeFeature: scores.producerPrestige ?? LTR_PRODUCER_PRESTIGE_FEATURE_DEFAULT,
    ...encodeQueryTargetType(targetType),
  };
}
