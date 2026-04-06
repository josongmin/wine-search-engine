/**
 * LambdaMART Learning-to-Rank (LTR) ranking model.
 *
 * Epic 4: LambdaMART LTR
 * Trains on evaluation results to learn optimal ranking weights per query class.
 *
 * RFC-009: SOTA++ learning-to-rank for production ranking optimization
 *
 * Numerical stability notes:
 * - stableSigmoid() avoids exp() overflow for large positive inputs
 * - Weight normalization guards against near-zero collapse
 * - scoreFeatures guards against NaN propagation from non-finite inputs
 *
 * Algorithm:
 * - Builds gradient-based objective from pairwise comparisons (LambdaMART loss)
 * - Learns per-query-class feature weights
 * - Optimizes NDCG@K metric
 * - Includes regularization to prevent overfitting
 */

/**
 * Ranking features extracted from retrieval results.
 */
/**
 * Deterministic pseudo-random number generator (xorshift32).
 *
 * Returns a value in [0, 1) given a mutable state object so callers can
 * advance the sequence without closure allocation.  The seed is derived
 * from the training context (queryClass + exampleCount) so training runs
 * are reproducible across process restarts.
 */
function xorshift32(state: { value: number }): number {
  let x = state.value;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  // Ensure positive 32-bit integer
  state.value = x >>> 0;
  return (x >>> 0) / 0x100000000;
}

/**
 * Deterministic Fisher-Yates shuffle that mutates `arr` in-place.
 * Uses xorshift32 seeded from the provided seed value.
 */
function deterministicShuffle<T>(arr: T[], seed: number): void {
  const rng = { value: (seed >>> 0) || 1 };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(xorshift32(rng) * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j] as T;
    arr[j] = tmp as T;
  }
}

/**
 * Numerically stable sigmoid that avoids exp() overflow.
 * For x >= 0 we compute exp(-x) (always <= 1, no overflow).
 * For x <  0 we compute exp(x)  (always <= 1, no overflow).
 */
function stableSigmoid(x: number): number {
  if (x >= 0) {
    const ez = Math.exp(-x);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(x);
  return ez / (1 + ez);
}

export interface RankingFeatures {
  readonly bm25Score: number;
  readonly semanticScore: number;
  readonly popularityScore: number;
  readonly recencyScore: number;
  readonly classMatchScore: number;
  readonly attributeMatchScore: number;
  readonly diversityScore: number;
  readonly multilingualScore: number;
}

/**
 * Training example for LambdaMART: a pair of documents and their labels.
 */
export interface LambdaMARTExample {
  readonly query: string;
  readonly queryClass: string;
  readonly label1: 0 | 1 | 2 | 3;
  readonly features1: RankingFeatures;
  readonly label2: 0 | 1 | 2 | 3;
  readonly features2: RankingFeatures;
}

/**
 * Per-query-class model weights learned by LambdaMART.
 */
export interface QueryClassWeights {
  readonly queryClass: string;
  readonly weights: readonly number[];
  readonly bias: number;
  readonly trainingExampleCount: number;
  readonly ndcg5ValidationScore: number;
  readonly trainedAt: Date;
}

/**
 * Trains a LambdaMART model for a specific query class.
 */
export function trainLambdaMARTModel(
    examples: readonly LambdaMARTExample[],
    queryClass: string,
    learningRate: number = 0.01,
    regularization: number = 0.001,
  ): QueryClassWeights {
    const classExamples = examples.filter((ex) => ex.queryClass === queryClass);

    if (classExamples.length === 0) {
      return {
        queryClass,
        weights: [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125] as readonly number[],
        bias: 0.5,
        trainingExampleCount: 0,
        ndcg5ValidationScore: 0,
        trainedAt: new Date(),
      };
    }

    // Mutable copy for training
    const weights: number[] = [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125];
    let bias = 0.5;

    const numIterations = Math.min(100, classExamples.length * 10);
    const batchSize = Math.max(1, Math.floor(classExamples.length / 10));
    const featureNames = [
      'bm25Score',
      'semanticScore',
      'popularityScore',
      'recencyScore',
      'classMatchScore',
      'attributeMatchScore',
      'diversityScore',
      'multilingualScore',
    ] as const;

    // Derive a deterministic seed from the queryClass string and example count
    // so training is reproducible across process restarts (no Math.random()).
    let classSeed = classExamples.length;
    for (let ci = 0; ci < queryClass.length; ci++) {
      classSeed = (classSeed * 31 + queryClass.charCodeAt(ci)) >>> 0;
    }

    for (let iter = 0; iter < numIterations; iter++) {
      const shuffled = [...classExamples];
      deterministicShuffle(shuffled, (classSeed + iter) >>> 0);
      const batch = shuffled.slice(0, batchSize);

      const gradients: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
      let biasMeanDelta = 0;

      for (const example of batch) {
        const score1 = scoreFeatures(example.features1, weights, bias);
        const score2 = scoreFeatures(example.features2, weights, bias);

        const labelDiff = example.label1 - example.label2;
        const scoreDiff = score1 - score2;
        const lambda = labelDiff * stableSigmoid(-scoreDiff);

        for (let j = 0; j < 8; j++) {
          const fname = (featureNames[j] ?? featureNames[0]) as keyof RankingFeatures;
          const featureDiff = example.features1[fname] - example.features2[fname];
          const currentGradient = gradients[j] ?? 0;
          gradients[j] = currentGradient + lambda * featureDiff;
        }
        biasMeanDelta += lambda;
      }

      for (let j = 0; j < 8; j++) {
        const currentWeight = weights[j] ?? 0;
        const currentGradient = gradients[j] ?? 0;
        const gradient = currentGradient / batch.length;
        const nextWeight =
          currentWeight + learningRate * gradient - regularization * currentWeight;
        weights[j] = Math.max(-1, Math.min(1, nextWeight));
      }

      bias = bias + learningRate * (biasMeanDelta / batch.length);
      bias = Math.max(-1, Math.min(2, bias));
    }

    const absWeights = weights.map((w) => Math.abs(w));
    const weightSum = absWeights.reduce((a, b) => a + b, 0);
    // Guard: if all weights collapsed to near-zero (e.g., regularization drove
    // them all toward 0), fall back to uniform weights to avoid extreme values
    // that lose discriminative power after clamping.
    const normalizedWeights =
      weightSum > 1e-8
        ? weights.map((w) => w / weightSum)
        : weights.map(() => 1 / weights.length);

    const validationNdcg = computeValidationNdcg(classExamples, normalizedWeights, bias);

    return {
      queryClass,
      weights: normalizedWeights,
      bias,
      trainingExampleCount: classExamples.length,
      ndcg5ValidationScore: validationNdcg,
      trainedAt: new Date(),
    };
}

/**
 * Scores a document's ranking using learned weights.
 */
export function scoreDocument(
  features: RankingFeatures,
  weights: QueryClassWeights,
): number {
  return scoreFeatures(features, weights.weights, weights.bias);
}

function scoreFeatures(
  features: RankingFeatures,
  weights: readonly number[],
  bias: number,
): number {
  const featureValues = [
    features.bm25Score,
    features.semanticScore,
    features.popularityScore,
    features.recencyScore,
    features.classMatchScore,
    features.attributeMatchScore,
    features.diversityScore,
    features.multilingualScore,
  ];

  let score = bias;
  for (let i = 0; i < 8; i++) {
    const fv = featureValues[i] ?? 0;
    const wv = weights[i] ?? 0;
    // Guard against NaN propagation from non-finite inputs
    if (!Number.isFinite(fv) || !Number.isFinite(wv)) continue;
    score += fv * wv;
  }
  return Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
}

function computeValidationNdcg(
  examples: readonly LambdaMARTExample[],
  weights: readonly number[],
  bias: number,
): number {
  let totalNdcg = 0;
  let queryCount = 0;
  const queryExamples: Map<string, LambdaMARTExample[]> = new Map();

  for (const ex of examples) {
    const queryList = queryExamples.get(ex.query) ?? [];
    queryList.push(ex);
    queryExamples.set(ex.query, queryList);
  }

  for (const [, exs] of queryExamples) {
    const scored = exs.flatMap((ex) => [
      { label: ex.label1, score: scoreFeatures(ex.features1, weights, bias) },
      { label: ex.label2, score: scoreFeatures(ex.features2, weights, bias) },
    ]);

    const ranked = scored.sort((a, b) => b.score - a.score).slice(0, 5);

    let dcg = 0;
    for (const [i, item] of ranked.entries()) {
      const gain = Math.pow(2, item.label) - 1;
      const discount = 1 / Math.log2(i + 2);
      dcg += gain * discount;
    }

    const idcg = Array.from(
      { length: Math.min(5, exs.length) },
      (_, i) => (Math.pow(2, 3) - 1) / Math.log2(i + 2),
    ).reduce((sum, value) => sum + value, 0);

    const queryNdcg = idcg > 0 ? dcg / idcg : 0;
    totalNdcg += queryNdcg;
    queryCount++;
  }

  return queryCount > 0 ? totalNdcg / queryCount : 0;
}
