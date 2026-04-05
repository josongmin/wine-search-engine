/**
 * LTR Training Service - Converts evaluation results to training examples.
 *
 * Epic 4: LambdaMART learning-to-rank training pipeline
 */

import type { EvalResult } from '../../evaluation/model/eval-result.js';
import type { EvalCase } from '../../evaluation/model/eval-case.js';
import type { RankingFeatures, LambdaMARTExample, QueryClassWeights } from './lambdamart-ranker.js';
import { trainLambdaMARTModel } from './lambdamart-ranker.js';

/**
 * Extracts ranking features from evaluation result.
 *
 * IMPORTANT: Feature semantics MUST match the inference-time mapping in
 * search.usecase.ts to avoid train-serve skew. If inference sets a feature
 * to 0.0 (no signal), training must also set it to 0.0.
 *
 * Inference mapping (search.usecase.ts):
 *   bm25Score          = 0.0                              (no lexical BM25)
 *   semanticScore      = ComponentScores.semantic
 *   popularityScore    = ComponentScores.popularity
 *   recencyScore       = 0.0                              (no recency signal)
 *   classMatchScore    = ComponentScores.preferenceAlignment
 *   attributeMatchScore= ComponentScores.attributeAlignment
 *   diversityScore     = 0.0                              (no diversity signal)
 *   multilingualScore  = 0.0                              (no multilingual signal)
 *
 * Training proxies (from EvalResult):
 *   semanticScore      ← decisionConfidence (best proxy for retrieval quality)
 *   popularityScore    ← 0.5 (neutral — no popularity signal in eval data)
 *   classMatchScore    ← outcomeSignal (proxy for preference alignment)
 *   attributeMatchScore← utility normalized to [0, 1]
 */
function extractFeaturesFromResult(result: EvalResult, _evalCase: EvalCase): RankingFeatures {
  const utility = (result.utilityScore + 1.5) / 2.5; // normalize [-1.5, +1.0] → [0, 1]

  // Outcome-based quality signal: proxy for preference / class alignment
  let outcomeSignal = 0.3;
  if (result.isCorrectResolve) outcomeSignal = 1.0;
  else if (result.isSafeAbstain) outcomeSignal = 0.6;
  else if (result.isAvoidableAbstain) outcomeSignal = 0.2;
  else if (result.isWrongResolve) outcomeSignal = 0.0;

  return {
    bm25Score: 0.0,                          // No BM25 signal — matches inference
    semanticScore: result.decisionConfidence, // Best proxy for retrieval quality
    popularityScore: 0.5,                     // Neutral — no popularity in eval data
    recencyScore: 0.0,                        // No recency signal — matches inference
    classMatchScore: outcomeSignal,           // Proxy for preference alignment
    attributeMatchScore: utility,             // Utility normalized to [0, 1]
    diversityScore: 0.0,                      // No diversity signal — matches inference
    multilingualScore: 0.0,                   // No multilingual signal — matches inference
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

  console.warn(`Training LambdaMART models for ${queryClasses.length} query classes`);
  console.warn(`Total training examples: ${examples.length}`);

  for (const queryClass of queryClasses) {
    const classExamples = examples.filter((ex) => ex.queryClass === queryClass);
    const weights = trainLambdaMARTModel(classExamples, queryClass);

    models.set(queryClass, weights);

    console.warn(
      `✓ ${queryClass}: trained on ${classExamples.length} examples, ` +
      `NDCG@5=${weights.ndcg5ValidationScore.toFixed(3)}`,
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
      minNdcg5: ndcgScores.length > 0 ? Math.min(...ndcgScores) : 0,
      maxNdcg5: ndcgScores.length > 0 ? Math.max(...ndcgScores) : 0,
    },
  };
}
