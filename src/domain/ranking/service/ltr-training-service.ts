/**
 * LTR Training Service - Converts evaluation results to training examples.
 *
 * Epic 4: LambdaMART learning-to-rank training pipeline
 */

import { bootstrapLogger } from '../../../domain/shared/bootstrap-logger.js';
import type { EvalResult } from '../../evaluation/model/eval-result.js';
import type { EvalCase } from '../../evaluation/model/eval-case.js';

const ltrLog = bootstrapLogger.child({ component: 'LTRTrainingService' });
import type { RankingFeatures, LambdaMARTExample, QueryClassWeights } from './lambdamart-ranker.js';
import { trainLambdaMARTModel } from './lambdamart-ranker.js';
import { extractLTRFeatures } from './ltr-feature-extractor.js';
/** Strong degradation retains most of the label (synthetic hard negative). */
const TRAINING_LABEL_DEGRADATION_STRONG = 0.7;
/** Medium degradation for mid-tier negatives. */
const TRAINING_LABEL_DEGRADATION_MEDIUM = 0.4;
/** Weak degradation for easy negatives. */
const TRAINING_LABEL_DEGRADATION_WEAK = 0.1;
/** Deterministic label degradation multipliers for pairwise negatives. */
const TRAINING_LABEL_DEGRADATION_FACTORS = [
  TRAINING_LABEL_DEGRADATION_STRONG,
  TRAINING_LABEL_DEGRADATION_MEDIUM,
  TRAINING_LABEL_DEGRADATION_WEAK,
] as const;

/**
 * Extracts ranking features from evaluation result.
 *
 * Requires canonical score components from the eval pipeline and uses the
 * shared extractLTRFeatures() — the SAME function used at inference time,
 * making train-serve skew structurally impossible.
 */
function extractFeaturesFromResult(result: EvalResult): RankingFeatures {
  if (result.topResultScoreComponents === undefined) {
    throw new Error(
      `LTR training requires canonical topResultScoreComponents (caseId='${result.caseId}')`,
    );
  }

  return extractLTRFeatures(result.topResultScoreComponents);
}

/**
 * Synthetic negatives may attenuate only continuous ranking evidence.
 *
 * Dual-lane exactness / topology features are categorical serve-time states,
 * not continuous magnitudes. Preserving them verbatim keeps training examples
 * on the same live-reachable feature manifold as inference.
 */
function synthesizeNegativeFeatures(
  features: RankingFeatures,
  factor: number,
): RankingFeatures {
  return {
    bm25Score: features.bm25Score * factor,
    semanticScore: features.semanticScore * factor,
    popularityScore: features.popularityScore * factor,
    recencyScore: features.recencyScore * factor,
    classMatchScore: features.classMatchScore * factor,
    attributeMatchScore: features.attributeMatchScore * factor,
    diversityScore: features.diversityScore * factor,
    multilingualScore: features.multilingualScore * factor,
    entityPosteriorScore: features.entityPosteriorScore * factor,
    identityExactnessTierScore: features.identityExactnessTierScore,
    laneCorroborationScore: features.laneCorroborationScore,
    laneDisagreementScore: features.laneDisagreementScore,
    entityOnlyIndicator: features.entityOnlyIndicator,
    generalOnlyIndicator: features.generalOnlyIndicator,
  };
}

/**
 * Converts evaluation outcome to relevance label.
 */
function outcomeToLabel(result: EvalResult, evalCase: EvalCase): 0 | 1 | 2 | 3 {
  if (result.isCorrectResolve) {
    return 3;
  }
  if (result.isSafeAbstain && evalCase.expectedStatus === 'ambiguous') {
    return 2;
  }
  if (result.isAvoidableAbstain) {
    return 1;
  }
  return 0;
}

/**
 * Builds training examples from evaluation results and cases.
 */
export function buildTrainingExamples(
  results: readonly EvalResult[],
  cases: readonly EvalCase[],
): LambdaMARTExample[] {
  const resultById = new Map(results.map((r) => [r.caseId, r]));
  const examples: LambdaMARTExample[] = [];

  for (const evalCase of cases) {
    const result = resultById.get(evalCase.caseId);
    if (!result) continue;

    const features = extractFeaturesFromResult(result);
    const label = outcomeToLabel(result, evalCase);

    // Generate pairwise comparisons with degraded negatives at varying levels.
    // Use deterministic degradation factors (not random) to create consistent
    // training signal: label 3 vs 2, 3 vs 1, 3 vs 0, etc.
    for (const factor of TRAINING_LABEL_DEGRADATION_FACTORS) {
      const degradedLabel = Math.max(0, Math.round(label * factor)) as 0 | 1 | 2 | 3;
      if (degradedLabel < label) {
        examples.push({
          query: evalCase.query,
          queryClass: evalCase.queryClass,
          label1: label,
          features1: features,
          label2: degradedLabel,
          features2: synthesizeNegativeFeatures(features, factor),
        });
      }
    }
  }

  return examples;
}

/**
 * Trains LambdaMART models for all query classes.
 */
export function trainAllModels(
  examples: readonly LambdaMARTExample[],
): Map<string, QueryClassWeights> {
  const models = new Map<string, QueryClassWeights>();
  const queryClasses = Array.from(new Set(examples.map((ex) => ex.queryClass)));

  ltrLog.info(
    { queryClassCount: queryClasses.length, exampleCount: examples.length },
    'training LambdaMART models',
  );

  for (const queryClass of queryClasses) {
    const classExamples = examples.filter((ex) => ex.queryClass === queryClass);
    const weights = trainLambdaMARTModel(classExamples, queryClass);

    models.set(queryClass, weights);

    ltrLog.info(
      {
        queryClass,
        exampleCount: classExamples.length,
        ndcg5: weights.ndcg5ValidationScore,
      },
      'query class model trained',
    );
  }

  return models;
}
