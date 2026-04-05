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
 * Since EvalResult doesn't contain raw retrieval-level signals, we derive
 * proxy features from the available decision-level data:
 * - decisionConfidence → proxy for bm25/semantic match quality
 * - utilityScore → proxy for overall match quality
 * - latencyMs → inverse proxy for retrieval efficiency
 * - outcome flags → proxy for class/attribute alignment
 *
 * These proxies ensure LambdaMART learns a consistent signal (high confidence
 * + correct resolve → high feature values) instead of pure noise.
 */
function extractFeaturesFromResult(result: EvalResult, evalCase: EvalCase): RankingFeatures {
  const conf = result.decisionConfidence; // [0, 1]
  const utility = (result.utilityScore + 1.5) / 2.5; // normalize [-1.5, +1.0] → [0, 1]
  const latencyFactor = Math.max(0, 1 - result.latencyMs / 5000); // faster = better, cap at 5s

  // Outcome-based quality signal: 1.0 for correct, 0.5 for safe abstain, 0.0 for wrong
  let outcomeSignal = 0.3;
  if (result.isCorrectResolve) outcomeSignal = 1.0;
  else if (result.isSafeAbstain) outcomeSignal = 0.6;
  else if (result.isAvoidableAbstain) outcomeSignal = 0.2;
  else if (result.isWrongResolve) outcomeSignal = 0.0;

  return {
    bm25Score: conf * 0.7 + outcomeSignal * 0.3,
    semanticScore: conf * 0.6 + utility * 0.4,
    popularityScore: latencyFactor * 0.5 + outcomeSignal * 0.5,
    recencyScore: latencyFactor,
    classMatchScore: outcomeSignal,
    attributeMatchScore: conf * 0.5 + outcomeSignal * 0.5,
    diversityScore: result.evidenceItems.length > 0 ? 0.7 : 0.3,
    multilingualScore: evalCase.sliceTags.includes('lang:ko') ? 0.6 : 0.4,
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
          label1: label as 0 | 1 | 2 | 3,
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
