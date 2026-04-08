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
    // multilingualScore: 0.5 neutral when absent — a wine with no Korean alias data
    // should not be penalised for missing indexing, only wines with confirmed
    // non-Korean alias should score 0. Match the prestige default for consistency.
    multilingualScore: scores.multilingualScore ?? 0.5,

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
 * additional prestige and critic signals not yet in the 8-feature
 * LambdaMART model. Used by ltr-training-service.ts for next-generation
 * model training without affecting the live inference path.
 *
 * When the next LambdaMART model version adds these features, promote
 * them to extractLTRFeatures() and update RankingFeatures accordingly.
 */
export interface ExtendedLTRFeatures extends RankingFeatures {
  readonly criticScoreFeature: number;
  readonly producerPrestigeFeature: number;
}

/** Neutral producer prestige feature when component missing. */
const LTR_PRODUCER_PRESTIGE_FEATURE_DEFAULT = 0.5;

export function extractExtendedLTRFeatures(scores: LTRScoreComponents): ExtendedLTRFeatures {
  return {
    ...extractLTRFeatures(scores),
    criticScoreFeature: scores.criticScore ?? 0.0,
    producerPrestigeFeature: scores.producerPrestige ?? LTR_PRODUCER_PRESTIGE_FEATURE_DEFAULT,
  };
}
