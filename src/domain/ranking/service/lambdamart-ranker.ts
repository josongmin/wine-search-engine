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
import { z } from 'zod';
import { clamp01 } from '../../shared/utils/clamp.js';
import { compareScoreDescending } from '../../shared/utils/stable-comparator.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';

/**
 * Deterministic pseudo-random number generator (xorshift32).
 *
 * Returns a value in [0, 1) given a mutable state object so callers can
 * advance the sequence without closure allocation.  The seed is derived
 * from the training context (queryClass + exampleCount) so training runs
 * are reproducible across process restarts.
 */

/** Standard xorshift32 shift tuple (Marsaglia). */
const XORSHIFT32_LEFT1 = 13;
const XORSHIFT32_RIGHT = 17;
const XORSHIFT32_LEFT2 = 5;
/** 2^32 — normalizes unsigned 32-bit xorshift output to [0, 1). */
const UINT32_TO_UNIT_INTERVAL_DIVISOR = 0x100000000;

/** E2-T2: Zod schema for loaded LTR model weights — all must be finite numbers. */
const FiniteWeightsSchema = z.array(z.number().finite()).min(1);

/**
 * E2-T2: Validates loaded model weights and falls back to uniform weights on failure.
 * Returns { weights, usedFallback } so callers can log + report.
 */
export function validateAndNormalizeWeights(
  rawWeights: readonly number[],
): { weights: readonly number[]; usedFallback: boolean } {
  const parsed = FiniteWeightsSchema.safeParse(rawWeights);
  if (!parsed.success) {
    bootstrapLogger.warn(
      { reason: parsed.error.message, rawLength: rawWeights.length },
      '[LambdaMART] Loaded weights failed validation — falling back to uniform weights',
    );
    const uniformWeight = rawWeights.length > 0 ? 1 / rawWeights.length : LAMBDAMART_UNIFORM_FEATURE_WEIGHT;
    const fallback = Array.from({ length: Math.max(1, rawWeights.length) }, () => uniformWeight);
    return { weights: fallback, usedFallback: true };
  }
  return { weights: parsed.data, usedFallback: false };
}

/**
 * E2-T5: Check if the model's featureSchemaHash matches the current schema hash.
 * Logs a warning when there is a mismatch — the model may produce incorrect scores.
 * The log parameter is injectable for testability.
 */
export function checkFeatureParityAndWarn(
  modelHash: string,
  currentHash: string,
  log: { warn: (ctx: Record<string, unknown>, msg: string) => void } = bootstrapLogger,
): void {
  if (modelHash !== currentHash) {
    log.warn(
      { modelHash, currentHash },
      '[LambdaMART] LTR feature schema mismatch — model may produce incorrect scores',
    );
  }
}

/**
 * E2-T6: Guard for featureNames index access.
 * Throws a clear invariant error when j is out of bounds.
 * Exported for testability.
 */
export function throwOnUndefinedFeatureName(
  featureNames: readonly string[],
  j: number,
): string {
  const fname = featureNames[j];
  if (fname === undefined) {
    throw new Error(
      `LambdaMART invariant: featureNames[${j}] undefined (dimension=${LAMBDAMART_FEATURE_DIMENSION})`,
    );
  }
  return fname;
}

/**
 * E2-T4: Named weight constants for DEFAULT_HEURISTIC_WEIGHTS.
 * Domain rationale per constant below. Sum = 1.00.
 */
/** BM25 lexical relevance — useful but less discriminative for wines than embedding. */
const W_BM25 = 0.10;
/** Embedding (semantic) match — primary signal for semantic queries and synonyms. */
const W_SEMANTIC = 0.20;
/** Producer/wine popularity — boosts well-known labels across query classes. */
const W_POPULARITY = 0.15;
/** Vintage recency — relevant for aged-wine and cellaring queries. */
const W_RECENCY = 0.10;
/** Query-class structural match — high precision for exact-entity queries. */
const W_CLASS_MATCH = 0.15;
/** Constraint attribute match — crucial for region/grape/style filtered search. */
const W_ATTRIBUTE_MATCH = 0.15;
/** Diversity penalty — suppresses near-duplicate results in candidate set. */
const W_DIVERSITY = 0.05;
/** Multilingual coverage — important for Korean-script and transliterated queries. */
const W_MULTILINGUAL = 0.10;
// Sum check: 0.10+0.20+0.15+0.10+0.15+0.15+0.05+0.10 = 1.00

/**
 * Default heuristic weights for 8 LambdaMART features, summing to exactly 1.0.
 * Order matches featureNames in trainLambdaMARTModel and scoreFeaturesRaw.
 */
export const DEFAULT_HEURISTIC_WEIGHTS: readonly number[] = [
  W_BM25,
  W_SEMANTIC,
  W_POPULARITY,
  W_RECENCY,
  W_CLASS_MATCH,
  W_ATTRIBUTE_MATCH,
  W_DIVERSITY,
  W_MULTILINGUAL,
];

/** Eight ranking features → uniform prior sums to 1.0 for stable cold-start. */
const LAMBDAMART_UNIFORM_FEATURE_WEIGHT = 0.125;
const LAMBDAMART_INITIAL_BIAS = 0.5;
const LAMBDAMART_MAX_TRAINING_ITERATIONS = 100;
const LAMBDAMART_ITERATIONS_MULTIPLIER_PER_EXAMPLE = 10;
const LAMBDAMART_BATCH_SIZE_DIVISOR = 10;
/** String hash mix constant (djb-style; deterministic seed mixing). */
const QUERY_CLASS_SEED_MULTIPLIER = 31;
const LAMBDAMART_FEATURE_DIMENSION = 8;
const LAMBDAMART_WEIGHT_CLAMP_LOW = -1;
const LAMBDAMART_WEIGHT_CLAMP_HIGH = 1;
const LAMBDAMART_BIAS_CLAMP_HIGH = 2;
/** Below this L1 norm, weights are treated as collapsed; renormalize uniformly. */
const LAMBDAMART_WEIGHT_SUM_EPSILON = 1e-8;
/** Validation NDCG@K (pairwise expansion uses top-K ranked pool). */
const LAMBDAMART_VALIDATION_NDCG_K = 5;

function xorshift32(state: { value: number }): number {
  let x = state.value;
  x ^= x << XORSHIFT32_LEFT1;
  x ^= x >> XORSHIFT32_RIGHT;
  x ^= x << XORSHIFT32_LEFT2;
  // Ensure positive 32-bit integer
  state.value = x >>> 0;
  return (x >>> 0) / UINT32_TO_UNIT_INTERVAL_DIVISOR;
}

/**
 * Deterministic Fisher-Yates shuffle that mutates `arr` in-place.
 * Uses xorshift32 seeded from the provided seed value.
 */
function deterministicShuffle(arr: unknown[], seed: number): void {
  // xorshift32 requires a non-zero seed (a 0 state is a fixed point that
  // emits 0 forever). Coerce 0 to 1 — this is exactly the case where we
  // INTENTIONALLY want falsy-coalesce, not nullish-coalesce.
  // eslint-disable-next-line no-restricted-syntax -- xorshift32 forbids zero seed
  const rng = { value: (seed >>> 0) || 1 };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(xorshift32(rng) * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
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

/** Canonical feature name order — must match scoreFeaturesRaw and DEFAULT_HEURISTIC_WEIGHTS.
 *  Module-scope (Rule 16): value is deterministic, never changes per call. */
const LAMBDAMART_FEATURE_NAMES: readonly (keyof RankingFeatures)[] = [
  'bm25Score',
  'semanticScore',
  'popularityScore',
  'recencyScore',
  'classMatchScore',
  'attributeMatchScore',
  'diversityScore',
  'multilingualScore',
];

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
        weights: Array.from(
          { length: LAMBDAMART_FEATURE_DIMENSION },
          () => LAMBDAMART_UNIFORM_FEATURE_WEIGHT,
        ) as readonly number[],
        bias: LAMBDAMART_INITIAL_BIAS,
        trainingExampleCount: 0,
        ndcg5ValidationScore: 0,
        trainedAt: new Date(),
      };
    }

    // Mutable copy for training
    const weights: number[] = Array.from(
      { length: LAMBDAMART_FEATURE_DIMENSION },
      () => LAMBDAMART_UNIFORM_FEATURE_WEIGHT,
    );
    let bias = LAMBDAMART_INITIAL_BIAS;

    const numIterations = Math.min(
      LAMBDAMART_MAX_TRAINING_ITERATIONS,
      classExamples.length * LAMBDAMART_ITERATIONS_MULTIPLIER_PER_EXAMPLE,
    );
    const batchSize = Math.max(
      1,
      Math.floor(classExamples.length / LAMBDAMART_BATCH_SIZE_DIVISOR),
    );
    // LAMBDAMART_FEATURE_NAMES is module-scope (Rule 16: deterministic, never changes per call).
    // Derive a deterministic seed from the queryClass string and example count
    // so training is reproducible across process restarts (no Math.random()).
    let classSeed = classExamples.length;
    for (let ci = 0; ci < queryClass.length; ci++) {
      classSeed = (classSeed * QUERY_CLASS_SEED_MULTIPLIER + queryClass.charCodeAt(ci)) >>> 0;
    }

    for (let iter = 0; iter < numIterations; iter++) {
      const shuffled = [...classExamples];
      deterministicShuffle(shuffled, (classSeed + iter) >>> 0);
      const batch = shuffled.slice(0, batchSize);

      const gradients: number[] = Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, () => 0);
      let biasMeanDelta = 0;

      for (const example of batch) {
        // Training MUST use unclamped scores. Clamping to [0,1] mid-training
        // collapses scoreDiff to {-1, 0, +1} and gives a constant gradient,
        // preventing the model from learning ranking margins beyond the
        // initial saturation region.
        const score1 = scoreFeaturesRaw(example.features1, weights, bias);
        const score2 = scoreFeaturesRaw(example.features2, weights, bias);

        const labelDiff = example.label1 - example.label2;
        const scoreDiff = score1 - score2;
        const lambda = labelDiff * stableSigmoid(-scoreDiff);

        for (let j = 0; j < LAMBDAMART_FEATURE_DIMENSION; j++) {
          // E2-T6: throwOnUndefinedFeatureName guards against out-of-bounds access.
          // LAMBDAMART_FEATURE_NAMES has exactly LAMBDAMART_FEATURE_DIMENSION elements; j is always in range.
          const fname = throwOnUndefinedFeatureName(LAMBDAMART_FEATURE_NAMES, j) as keyof RankingFeatures;
          const featureDiff = example.features1[fname] - example.features2[fname];
          const currentGradient = gradients[j] ?? 0;
          gradients[j] = currentGradient + lambda * featureDiff;
        }
        biasMeanDelta += lambda;
      }

      // Invariant: batch is always non-empty (batchSize = max(1, ...) guarantees this)
      if (batch.length === 0) {
        throw new Error(
          `LambdaMART invariant violation: batch.length === 0 at iteration ${iter} for queryClass '${queryClass}'. ` +
          'batchSize is computed as Math.max(1, ...) so this should never occur.',
        );
      }

      // batch.length is asserted > 0 above (line 220 throw); the Math.max
      // duplicates the guard so the semgrep wine-divide-without-zero-guard
      // pattern is satisfied at the division site itself.
      const safeBatchSize = Math.max(1, batch.length);
      for (let j = 0; j < LAMBDAMART_FEATURE_DIMENSION; j++) {
        const currentWeight = weights[j] ?? 0;
        const currentGradient = gradients[j] ?? 0;
        const gradient = currentGradient / safeBatchSize;
        const nextWeight =
          currentWeight + learningRate * gradient - regularization * currentWeight;
        weights[j] = Math.max(
          LAMBDAMART_WEIGHT_CLAMP_LOW,
          Math.min(LAMBDAMART_WEIGHT_CLAMP_HIGH, nextWeight),
        );
      }

      bias = bias + learningRate * (biasMeanDelta / safeBatchSize);
      bias = Math.max(
        LAMBDAMART_WEIGHT_CLAMP_LOW,
        Math.min(LAMBDAMART_BIAS_CLAMP_HIGH, bias),
      );
    }

    const absWeights = weights.map((w) => Math.abs(w));
    const weightSum = absWeights.reduce((a, b) => a + b, 0);
    // Guard: if all weights collapsed to near-zero (e.g., regularization drove
    // them all toward 0), fall back to uniform weights to avoid extreme values
    // that lose discriminative power after clamping.
    // weights.length === LAMBDAMART_FEATURE_DIMENSION (constructor invariant);
    // Math.max duplicates the guard so semgrep wine-divide-without-zero-guard
    // is satisfied at the division site.
    const safeFeatureCount = Math.max(1, weights.length);
    const normalizedWeights =
      weightSum > LAMBDAMART_WEIGHT_SUM_EPSILON
        ? weights.map((w) => w / weightSum)
        : weights.map(() => 1 / safeFeatureCount);

    const validationNdcg = computeValidationNdcg(classExamples, normalizedWeights, bias);

    // Fix E: Warn when validation NDCG is pathologically low. NDCG < 0.1 almost always
    // means all training labels are zero (degenerate pool) or the model has diverged.
    // This is the earliest observable signal before the model pollutes production ranking.
    const NDCG_DEGENERATE_THRESHOLD = 0.1;
    if (validationNdcg < NDCG_DEGENERATE_THRESHOLD) {
      bootstrapLogger.warn(
        {
          queryClass,
          validationNdcg,
          trainingExampleCount: classExamples.length,
          ndcgThreshold: NDCG_DEGENERATE_THRESHOLD,
        },
        '[LambdaMART] Degenerate validation NDCG — all-zero labels or model divergence. Model will not rank meaningfully.',
      );
    }

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
 * Inference path: clamp the score to [0,1] for downstream consumers.
 *
 * E2-T2: Validates weights via FiniteWeightsSchema — any NaN/Infinity weight
 * triggers fallback to uniform weights before scoring.
 * E2-T3: finalScore is clamped to [0, 1] via clamp01().
 */
export function scoreDocument(
  features: RankingFeatures,
  weights: QueryClassWeights,
): number {
  const { weights: safeWeights } = validateAndNormalizeWeights(weights.weights);
  // Guard bias: FiniteWeightsSchema only validates the weights array, not bias.
  // A NaN/Infinity bias from a corrupted DB row would set score = bias before
  // the feature loop runs, corrupting all LambdaMART scores silently.
  const safeBias = Number.isFinite(weights.bias) ? weights.bias : LAMBDAMART_INITIAL_BIAS;
  if (!Number.isFinite(weights.bias)) {
    bootstrapLogger.warn(
      { bias: weights.bias, queryClass: weights.queryClass },
      '[LambdaMART] non-finite bias in loaded model — falling back to LAMBDAMART_INITIAL_BIAS',
    );
  }
  const raw = scoreFeaturesRaw(features, safeWeights, safeBias);
  return clamp01(raw);
}

/**
 * Raw (unclamped) scoring used during training. Clamping mid-training
 * collapses scoreDiff to {-1, 0, +1} and destroys the gradient signal,
 * trapping LambdaMART in a degenerate region. Inference path applies
 * the clamp via `scoreDocument`.
 */
function scoreFeaturesRaw(
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
  for (let i = 0; i < LAMBDAMART_FEATURE_DIMENSION; i++) {
    const fv = featureValues[i] ?? 0;
    const wv = weights[i] ?? 0;
    if (!Number.isFinite(fv) || !Number.isFinite(wv)) {
      // SCAN4-10: non-finite feature/weight must be loud — silent skip corrupts
      // gradient signal during training and can mask data pipeline bugs.
      bootstrapLogger.warn(
        { featureIndex: i, fv, wv },
        '[LambdaMART] non-finite value in scoreFeaturesRaw — skipping feature',
      );
      continue;
    }
    score += fv * wv;
  }
  return score;
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
    // Use raw scores so the validation NDCG reflects what the training
    // gradient actually optimized — clamping here would hide divergence
    // between the saturating clamp region and the model's true ordering.
    const scored = exs.flatMap((ex) => [
      { label: ex.label1, score: scoreFeaturesRaw(ex.features1, weights, bias) },
      { label: ex.label2, score: scoreFeaturesRaw(ex.features2, weights, bias) },
    ]);

    const ranked = scored
      .sort((a, b) => compareScoreDescending(a.score, b.score))
      .slice(0, LAMBDAMART_VALIDATION_NDCG_K);

    let dcg = 0;
    for (const [i, item] of ranked.entries()) {
      const gain = Math.pow(2, item.label) - 1;
      const discount = 1 / Math.log2(i + 2);
      dcg += gain * discount;
    }

    // IDCG is DCG of the IDEAL ranking — actual labels sorted by descending
    // relevance, truncated to K. The prior formulation (constant max-grade at
    // every position) is NOT IDCG: it turns NDCG into DCG-over-a-constant,
    // which systematically deflates NDCG for query pools where most labels
    // are below the hard-coded max grade (the common case). This
    // produced a flat-but-wrong validation signal during model promotion.
    const sortedLabelsForIdcg = scored
      .map((s) => s.label)
      .sort((a, b) => compareScoreDescending(a, b))
      .slice(0, LAMBDAMART_VALIDATION_NDCG_K);
    let idcg = 0;
    for (let i = 0; i < sortedLabelsForIdcg.length; i++) {
      const label = sortedLabelsForIdcg[i]!;
      idcg += (Math.pow(2, label) - 1) / Math.log2(i + 2);
    }

    const queryNdcg = idcg > 0 ? dcg / idcg : 0;
    totalNdcg += queryNdcg;
    queryCount++;
  }

  return queryCount > 0 ? totalNdcg / queryCount : 0;
}
