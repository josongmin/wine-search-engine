/**
 * LTR Training Service - Converts evaluation results to training examples.
 *
 * Epic 4: LambdaMART learning-to-rank training pipeline
 */

import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import type { EvalResult } from '../../evaluation/model/eval-result.js';
import type { EvalCase } from '../../evaluation/model/eval-case.js';

const ltrLog = bootstrapLogger.child({ component: 'LTRTrainingService' });
import type { RankingFeatures, LambdaMARTExample, QueryClassWeights } from './lambdamart-ranker.js';
import { trainLambdaMARTModel } from './lambdamart-ranker.js';
import { extractLTRFeatures } from './ltr-feature-extractor.js';

/**
 * Extracts ranking features from evaluation result.
 *
 * When real ComponentScores are stored from the eval pipeline, uses the
 * shared extractLTRFeatures() — the SAME function used at inference time,
 * making train-serve skew structurally impossible.
 *
 * Falls back to proxy signals for legacy eval results without stored
 * ComponentScores.
 */
function extractFeaturesFromResult(result: EvalResult, _evalCase: EvalCase): RankingFeatures {
  // When real ComponentScores are stored from the eval pipeline, use them directly.
  // This is the SAME extractLTRFeatures() function used at inference time,
  // making train-serve skew structurally impossible.
  if (result.topResultScoreComponents !== undefined) {
    return extractLTRFeatures(result.topResultScoreComponents);
  }

  // Fallback for legacy eval results without stored ComponentScores.
  // Uses proxy signals from eval outcomes — has inherent train-serve gap.
  const utility = (result.utilityScore + 1.5) / 2.5;
  let outcomeSignal = 0.3;
  if (result.isCorrectResolve) outcomeSignal = 1.0;
  else if (result.isSafeAbstain) outcomeSignal = 0.6;
  else if (result.isAvoidableAbstain) outcomeSignal = 0.2;
  else if (result.isWrongResolve) outcomeSignal = 0.0;

  return {
    bm25Score: 0.0,
    semanticScore: result.decisionConfidence,
    popularityScore: 0.5,
    recencyScore: 0.0,
    classMatchScore: outcomeSignal,
    attributeMatchScore: utility,
    diversityScore: 0.0,
    multilingualScore: 0.0,
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

    const features = extractFeaturesFromResult(result, evalCase);
    const label = outcomeToLabel(result, evalCase);

    // Generate pairwise comparisons with degraded negatives at varying levels.
    // Use deterministic degradation factors (not random) to create consistent
    // training signal: label 3 vs 2, 3 vs 1, 3 vs 0, etc.
    const degradationFactors = [0.7, 0.4, 0.1] as const;
    for (const factor of degradationFactors) {
      const degradedLabel = Math.max(0, Math.round(label * factor)) as 0 | 1 | 2 | 3;
      if (degradedLabel < label) {
        examples.push({
          query: evalCase.query,
          queryClass: evalCase.queryClass,
          label1: label,
          features1: features,
          label2: degradedLabel,
          features2: {
            bm25Score: features.bm25Score * factor,
            semanticScore: features.semanticScore * factor,
            popularityScore: features.popularityScore * factor,
            recencyScore: features.recencyScore * factor,
            classMatchScore: features.classMatchScore * factor,
            attributeMatchScore: features.attributeMatchScore * factor,
            diversityScore: features.diversityScore * factor,
            multilingualScore: features.multilingualScore * factor,
          },
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

/**
 * Model registry: stores trained models and metadata.
 */
export interface LTRModelRegistry {
  readonly modelId: string;
  readonly version: string;
  readonly trainedAt: Date;
  readonly models: ReadonlyMap<string, QueryClassWeights>;
  readonly trainingMetrics: {
    readonly totalExamples: number;
    readonly meanNdcg5: number;
    readonly minNdcg5: number;
    readonly maxNdcg5: number;
  };
}

/**
 * Creates a model registry from trained models.
 */
export function createModelRegistry(
  models: ReadonlyMap<string, QueryClassWeights>,
): LTRModelRegistry {
  const weights = Array.from(models.values());
  const ndcgScores = weights.map((w) => w.ndcg5ValidationScore);

  return {
    modelId: `ltr-model-${Date.now()}`,
    version: '1.0.0',
    trainedAt: new Date(),
    models,
    trainingMetrics: {
      totalExamples: weights.reduce((sum, w) => sum + w.trainingExampleCount, 0),
      meanNdcg5: ndcgScores.length > 0 ? ndcgScores.reduce((a, b) => a + b, 0) / ndcgScores.length : 0,
      // Loop-based min/max to avoid stack overflow on large ndcgScores arrays.
      minNdcg5: (() => { let m = Infinity; for (const v of ndcgScores) if (v < m) m = v; return m === Infinity ? 0 : m; })(),
      maxNdcg5: (() => { let m = -Infinity; for (const v of ndcgScores) if (v > m) m = v; return m === -Infinity ? 0 : m; })(),
    },
  };
}
