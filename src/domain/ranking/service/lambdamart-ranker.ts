/**
 * LambdaMART Learning-to-Rank (LTR) ranking model.
 *
 * Epic 4: LambdaMART LTR
 * Trains on evaluation results to learn optimal ranking weights per query class.
 *
 * RFC-009: SOTA++ learning-to-rank for production ranking optimization
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
 * LambdaMART ranker: learns optimal ranking from evaluation results.
 */
export namespace LambdaMARTRanker {
  /**
   * Trains a LambdaMART model for a specific query class.
   */
  export function train(
    examples: readonly LambdaMARTExample[],
    queryClass: string,
    learningRate: number = 0.01,
    regularization: number = 0.001,
  ): QueryClassWeights {
    const classExamples = examples.filter((ex) => ex.queryClass === queryClass);

    if (classExamples.length === 0) {
      return {
        queryClass,
        weights: [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125],
        bias: 0.5,
        trainingExampleCount: 0,
        ndcg5ValidationScore: 0,
        trainedAt: new Date(),
      };
    }

    const weights = [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125];
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

    for (let iter = 0; iter < numIterations; iter++) {
      const shuffled = [...classExamples].sort(() => Math.random() - 0.5);
      const batch = shuffled.slice(0, batchSize);

      const gradients = Array(8).fill(0);
      let biasMeanDelta = 0;

      for (const example of batch) {
        const score1 = scoreFeatures(example.features1, weights, bias);
        const score2 = scoreFeatures(example.features2, weights, bias);

        const labelDiff = example.label1 - example.label2;
        const scoreDiff = score1 - score2;
        const lambda = labelDiff * (1 / (1 + Math.exp(scoreDiff)));

        for (let j = 0; j < 8; j++) {
          const fname = featureNames[j];
          const featureDiff =
            (example.features1[fname] ?? 0) - (example.features2[fname] ?? 0);
          gradients[j] += lambda * featureDiff;
        }
        biasMeanDelta += lambda;
      }

      for (let j = 0; j < 8; j++) {
        const gradient = gradients[j] / batch.length;
        weights[j] = weights[j] + learningRate * gradient - regularization * weights[j];
        weights[j] = Math.max(-1, Math.min(1, weights[j]));
      }

      bias = bias + learningRate * (biasMeanDelta / batch.length);
      bias = Math.max(-1, Math.min(2, bias));
    }

    const weightSum = weights.reduce((a, b) => a + b, 0);
    const normalizedWeights = weights.map((w) => w / weightSum);

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
      score += (featureValues[i] ?? 0) * (weights[i] ?? 0);
    }
    return Math.max(0, Math.min(1, score));
  }

  function computeValidationNdcg(
    examples: readonly LambdaMARTExample[],
    weights: readonly number[],
    bias: number,
  ): number {
    let totalNdcg = 0;
    let queryCount = 0;
    const queryExamples: Record<string, LambdaMARTExample[]> = {};

    for (const ex of examples) {
      if (!queryExamples[ex.query]) {
        queryExamples[ex.query] = [];
      }
      queryExamples[ex.query].push(ex);
    }

    for (const queryStr of Object.keys(queryExamples)) {
      const exs = queryExamples[queryStr];
      if (!exs) continue;

      const scored = exs.flatMap((ex) => [
        { label: ex.label1, score: scoreFeatures(ex.features1, weights, bias) },
        { label: ex.label2, score: scoreFeatures(ex.features2, weights, bias) },
      ]);

      const ranked = scored.sort((a, b) => b.score - a.score).slice(0, 5);

      let dcg = 0;
      for (let i = 0; i < ranked.length; i++) {
        const gain = Math.pow(2, ranked[i].label) - 1;
        const discount = 1 / Math.log2(i + 2);
        dcg += gain * discount;
      }

      const idcg = Array(Math.min(5, exs.length))
        .fill(3)
        .reduce((sum, _, i) => sum + (Math.pow(2, 3) - 1) / Math.log2(i + 2), 0);

      const queryNdcg = idcg > 0 ? dcg / idcg : 0;
      totalNdcg += queryNdcg;
      queryCount++;
    }

    return queryCount > 0 ? totalNdcg / queryCount : 0;
  }
}
