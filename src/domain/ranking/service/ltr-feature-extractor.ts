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

import { createHash } from 'node:crypto';
import type { QueryTargetType } from '../../query/model/query-target-type.js';
import {
  buildDualLaneAgreement,
  type DualLanePresence,
  type IdentityExactnessTier,
} from '../../retrieval/model/dual-lane-artifact.js';

const LTR_FEATURE_SCHEMA_HASH_HEX_LENGTH = 16;

export interface RankingFeatures {
  readonly bm25Score: number;
  readonly semanticScore: number;
  readonly popularityScore: number;
  readonly recencyScore: number;
  readonly classMatchScore: number;
  readonly attributeMatchScore: number;
  readonly diversityScore: number;
  readonly multilingualScore: number;
  readonly entityPosteriorScore: number;
  readonly identityExactnessTierScore: number;
  readonly laneCorroborationScore: number;
  readonly laneDisagreementScore: number;
  readonly entityOnlyIndicator: number;
  readonly generalOnlyIndicator: number;
}

export const LTR_FEATURE_NAME_ORDER = [
  'bm25Score',
  'semanticScore',
  'popularityScore',
  'recencyScore',
  'classMatchScore',
  'attributeMatchScore',
  'diversityScore',
  'multilingualScore',
  'entityPosteriorScore',
  'identityExactnessTierScore',
  'laneCorroborationScore',
  'laneDisagreementScore',
  'entityOnlyIndicator',
  'generalOnlyIndicator',
] as const satisfies readonly (keyof RankingFeatures)[];

const LTR_FEATURE_DIMENSION_VALUE = LTR_FEATURE_NAME_ORDER.length;
const LTR_FEATURE_SCHEMA_HASH_VALUE = createHash('sha256')
  .update([String(LTR_FEATURE_DIMENSION_VALUE), ...LTR_FEATURE_NAME_ORDER].join('\n'))
  .digest('hex')
  .slice(0, LTR_FEATURE_SCHEMA_HASH_HEX_LENGTH);

export const LTR_FEATURE_SCHEMA = Object.freeze({
  dimension: LTR_FEATURE_DIMENSION_VALUE,
  nameOrder: LTR_FEATURE_NAME_ORDER,
  hash: LTR_FEATURE_SCHEMA_HASH_VALUE,
});

export const LTR_FEATURE_DIMENSION = LTR_FEATURE_SCHEMA.dimension;
export const LTR_UNIFORM_FEATURE_WEIGHT = 1 / LTR_FEATURE_DIMENSION;
export const LTR_FEATURE_SCHEMA_HASH = LTR_FEATURE_SCHEMA.hash;

/** LTR ordinal encoding for identity exactness tiers (higher = more exact). */
const LTR_IDENTITY_EXACTNESS_ALIAS_PHONETIC_SCORE = 0.25;

function encodeIdentityExactnessTier(
  tier: IdentityExactnessTier | undefined,
): number {
  switch (tier) {
    case 'exact':
      return 1.0;
    case 'alias_exact':
      return 2 / 3;
    case 'alias_fuzzy':
      return 1 / 3;
    case 'alias_phonetic':
      return LTR_IDENTITY_EXACTNESS_ALIAS_PHONETIC_SCORE;
    case 'none':
    case undefined:
      return 0.0;
  }
}

export function rankingFeaturesToVector(
  features: RankingFeatures,
): readonly number[] {
  return LTR_FEATURE_NAME_ORDER.map((featureName) => {
    const value = features[featureName];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0.0;
  });
}

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
 *   entityPosterior    → entityPosteriorScore
 *   identityExactnessTier → identityExactnessTierScore
 *   lanePresence       → corroboration / disagreement / single-lane indicators
 */
export interface LTRScoreComponents {
  readonly semantic?: number | undefined;
  readonly popularity?: number | undefined;
  readonly attributeAlignment?: number | undefined;
  readonly preferenceAlignment?: number | undefined;
  /** Critic score [0,1]: Track-C criticProxy or Vivino ratingAvg/5. Undefined = absent. */
  readonly criticScore?: number | undefined;
  /** Vintage recency signal [0,1]. Undefined when vintageYear is absent. */
  readonly recency?: number | undefined;
  /** Producer prestige [0,1] from winery_rating. Undefined = absent from index. */
  readonly producerPrestige?: number | undefined;
  /** Multilingual (Korean) match signal {0,1}. */
  readonly multilingualScore?: number | undefined;
  /** Calibrated entity-resolver posterior preserved through dual-lane fusion. */
  readonly entityPosterior?: number | undefined;
  /** Identity exactness tier preserved from the entity lane. */
  readonly identityExactnessTier?: IdentityExactnessTier | undefined;
  /** Topology-aware lane presence after entity/general fusion. */
  readonly lanePresence?: DualLanePresence | undefined;
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
  const agreement = scores.lanePresence !== undefined
    ? buildDualLaneAgreement(scores.lanePresence)
    : undefined;

  return {
    // Preserve object key order exactly as LTR_FEATURE_NAME_ORDER so schema
    // introspection, snapshotting, and training metadata all see the same
    // canonical feature layout.
    bm25Score: 0.0,

    // Core signals — directly from score components
    semanticScore: scores.semantic ?? 0.0,
    popularityScore: scores.popularity ?? 0.0,
    recencyScore: scores.recency ?? 0.0,
    classMatchScore: scores.preferenceAlignment ?? 0.0,
    attributeMatchScore: scores.attributeAlignment ?? 0.0,

    // diversityScore: set-level signal, not yet per-candidate.
    // Remains 0.0 until ComponentScores gains a per-candidate diversity field.
    diversityScore: 0.0,

    // multilingualScore: 0.0 when absent — absent multilingual data is treated as
    // no signal (not rewarded). Previously defaulted to 0.5 (MULTILINGUAL_SCORE_NEUTRAL)
    // which caused train-serve skew by rewarding missing-data wines at inference time.
    multilingualScore: scores.multilingualScore ?? 0.0,

    // Dual-lane identity substrate. Missing topology projects to 0.0 so the
    // vector shape stays fixed while preserving the absence of identity evidence.
    entityPosteriorScore: scores.entityPosterior ?? 0.0,
    identityExactnessTierScore: encodeIdentityExactnessTier(scores.identityExactnessTier),
    laneCorroborationScore: agreement?.corroborated === true ? 1.0 : 0.0,
    laneDisagreementScore: agreement?.disagreement === true ? 1.0 : 0.0,
    entityOnlyIndicator: agreement?.entityOnly === true ? 1.0 : 0.0,
    generalOnlyIndicator: agreement?.generalOnly === true ? 1.0 : 0.0,
  };
}

/**
 * Extended LTR feature extraction for offline training that includes
 * additional prestige, critic, and query-target-type signals outside the
 * live LambdaMART inference schema. Used by
 * ltr-training-service.ts for offline model iteration without affecting the
 * served feature contract.
 *
 * When the next LambdaMART model version adds these features, promote
 * them to extractLTRFeatures() and update RankingFeatures accordingly.
 */
interface ExtendedLTRFeatures extends RankingFeatures {
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
  targetType?: QueryTargetType,
): ExtendedLTRFeatures {
  return {
    ...extractLTRFeatures(scores),
    criticScoreFeature: scores.criticScore ?? 0.0,
    // Do not fabricate neutral prestige at LTR feature extraction. Missing
    // prestige remains absent and is mapped to 0 only at the model boundary.
    producerPrestigeFeature: scores.producerPrestige ?? 0.0,
    ...encodeQueryTargetType(targetType),
  };
}
