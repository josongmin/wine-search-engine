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
 *   semantic          → semanticScore
 *   popularity        → popularityScore
 *   attributeAlignment→ attributeMatchScore
 *   preferenceAlignment→ classMatchScore
 */
export interface LTRScoreComponents {
  readonly semantic: number;
  readonly popularity: number;
  readonly attributeAlignment: number;
  readonly preferenceAlignment: number;
}

/**
 * Extracts LTR ranking features from score components.
 *
 * This is the SINGLE function that both inference and training use.
 * Changing this function changes both pipelines simultaneously,
 * eliminating train-serve skew by construction.
 *
 * Feature mapping:
 *   - 4 real signals from score components
 *   - 4 zero sentinels (no data available in current pipeline)
 *
 * @param scores - Score components from ranking (inference) or stored eval data (training)
 * @returns RankingFeatures for LambdaMART scoring
 */
export function extractLTRFeatures(scores: LTRScoreComponents): RankingFeatures {
  return {
    // Real signals — directly from score components
    semanticScore: scores.semantic,
    popularityScore: scores.popularity,
    attributeMatchScore: scores.attributeAlignment,
    classMatchScore: scores.preferenceAlignment,

    // No-data sentinels — no corresponding signal exists in current pipeline.
    // When real signals become available (e.g., BM25 from Vespa, recency from
    // vintage data), add them to LTRScoreComponents and map here.
    bm25Score: 0.0,
    recencyScore: 0.0,
    diversityScore: 0.0,
    multilingualScore: 0.0,
  };
}
