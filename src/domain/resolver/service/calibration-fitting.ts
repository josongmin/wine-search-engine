/**
 * Calibration-parameter fitting utilities for the resolver's
 * {@link CalibrationStore} (RFC-006 §6).
 *
 * Three calibration methods are supported, all reducing raw resolver match
 * scores to calibrated [0, 1] probabilities:
 *
 *  - **Isotonic regression** via the Pool Adjacent Violators (PAV)
 *    algorithm (Barlow et al. 1972). Produces a piecewise-monotonic step
 *    function encoded as `(x_i, y_i)` breakpoints. Robust to non-sigmoid
 *    raw-score distributions, dominant choice when the resolver's score is
 *    a weighted sum without a generative model behind it.
 *
 *  - **Platt scaling** (Platt 1999, refined by Lin et al. 2007). Fits
 *    `σ(a · raw + b)` via Newton's method on the regularised cross-entropy
 *    loss. Reasonable when the raw score behaves like a logit; tighter
 *    than isotonic when training data is small.
 *
 *  - **Temperature scaling** (Guo et al. 2017). Single-parameter
 *    `σ(raw / T)` fit by 1-D bisection on the loss derivative. Best for
 *    post-hoc smoothing of an overconfident model that's already well
 *    ordered.
 *
 * {@link fitBestCalibration} runs all three on the provided samples,
 * measures Expected Calibration Error (ECE) on the same set, and returns
 * the `CalibrationParams` shape that {@link Calibrator.applyCalibration}
 * understands. Persist the result via `CalibrationStore.save(queryClass, …)`.
 */
import type {
  CalibrationParams,
} from '../port/calibration-store.port.js';
import type { QueryClass } from '../../shared/types/index.js';

export interface CalibrationSample {
  readonly rawScore: number;
  /** 1 if the resolver's candidate was the correct entity, 0 otherwise. */
  readonly label: 0 | 1;
}

interface IsotonicBreakpoint {
  readonly x: number;
  readonly y: number;
}

/** Default number of equal-width ECE bins. Guo et al. 2017 use 15. */
const DEFAULT_ECE_BIN_COUNT = 15;

/**
 * Fraction of samples reserved for holdout ECE measurement (default 20%).
 * Lower bound mandated by RFC-006 §7.4 ("calibration holdout minimum
 * 500 examples"); when the input is smaller than 500 the entire dataset
 * is used in-sample and the returned ECE is annotated `ece` directly
 * (no holdout possible — annotate caller documentation).
 */
const DEFAULT_HOLDOUT_FRACTION = 0.2;

/** Minimum total samples required to attempt a holdout split. Below this we fit on all and measure in-sample (annotated). */
const MIN_HOLDOUT_TOTAL = 50;

/** Maximum Newton iterations for Platt fitting (well-conditioned data converges in <10). */
const PLATT_MAX_ITERATIONS = 100;

/** Convergence tolerance on parameter delta for Platt. */
const PLATT_PARAM_TOLERANCE = 1e-6;

/** L2 regularisation strength to keep the Hessian positive-definite. */
const PLATT_RIDGE = 1e-8;

/** Temperature search bounds. Below this, sigmoid saturates; above, smoothing dominates. */
const TEMPERATURE_LOWER_BOUND = 1e-3;
const TEMPERATURE_UPPER_BOUND = 1e3;
const TEMPERATURE_BISECTION_ITERATIONS = 60;

/**
 * Bias used for degenerate single-class Platt fits — large enough that
 * `sigmoid(b)` rounds to the dominant class but small enough to stay
 * numerically safe under double precision.
 */
const PLATT_DEGENERATE_BIAS = 10;

/** Maximum backtracking-line-search halvings per Newton step. */
const PLATT_LINE_SEARCH_ITERATIONS = 20;

/** Backtracking step shrink factor (Armijo-style halving). */
const PLATT_LINE_SEARCH_SHRINK = 0.5;

// ── PAV isotonic regression ────────────────────────────────────────────────

/**
 * Pool Adjacent Violators (PAV) algorithm.
 *
 * Given samples sorted by `rawScore`, produces the maximum-likelihood
 * non-decreasing fit to the binary labels. Output is a list of
 * `(x, y)` breakpoints where each `x` is the lower-bound score of a
 * pooled block and `y` is the block's mean label.
 *
 * Duplicate x values are collapsed into a single block (no x_i can equal
 * x_{i-1} in the result).
 */
export function fitIsotonicRegression(
  samples: readonly CalibrationSample[],
): { readonly breakpoints: readonly IsotonicBreakpoint[] } {
  if (samples.length === 0) {
    return { breakpoints: [] };
  }

  const sorted = [...samples].sort((a, b) => a.rawScore - b.rawScore);

  interface PavBlock {
    minX: number;
    sumY: number;
    weight: number;
  }
  const stack: PavBlock[] = [];

  for (const sample of sorted) {
    let block: PavBlock = {
      minX: sample.rawScore,
      sumY: sample.label,
      weight: 1,
    };
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const topMean = top.sumY / top.weight;
      const blockMean = block.sumY / block.weight;
      if (topMean <= blockMean) break;
      // Violation: merge.
      stack.pop();
      block = {
        minX: top.minX,
        sumY: top.sumY + block.sumY,
        weight: top.weight + block.weight,
      };
    }
    stack.push(block);
  }

  const breakpoints: IsotonicBreakpoint[] = [];
  for (const block of stack) {
    const y = block.sumY / block.weight;
    const x = block.minX;
    const prev = breakpoints[breakpoints.length - 1];
    if (prev !== undefined && prev.x === x) {
      // Duplicate rawScore — replace prev (same x, later block's y dominates).
      breakpoints[breakpoints.length - 1] = { x, y };
    } else {
      breakpoints.push({ x, y });
    }
  }

  return { breakpoints };
}

/** Encodes PAV breakpoints into the {@link CalibrationParams.params} shape. */
export function encodeIsotonicParams(
  breakpoints: readonly IsotonicBreakpoint[],
): Readonly<Record<string, number>> {
  const params: Record<string, number> = { breakpoint_count: breakpoints.length };
  for (let i = 0; i < breakpoints.length; i++) {
    const bp = breakpoints[i];
    if (bp === undefined) {
      throw new Error(`encodeIsotonicParams: breakpoint at index ${i} undefined`);
    }
    params[`x_${i}`] = bp.x;
    params[`y_${i}`] = bp.y;
  }
  return params;
}

/** Apply an isotonic fit to a raw score (mirrors Calibrator.applyIsotonicFallback). */
export function applyIsotonicFit(
  rawScore: number,
  breakpoints: readonly IsotonicBreakpoint[],
): number {
  if (breakpoints.length === 0) {
    return clamp01(rawScore);
  }
  let prevX = -Infinity;
  let prevY = 0;
  let lastY = 0;
  for (let i = 0; i < breakpoints.length; i++) {
    const bp = breakpoints[i];
    if (bp === undefined) {
      throw new Error(`applyIsotonicFit: breakpoint at index ${i} undefined`);
    }
    if (rawScore <= bp.x) {
      if (i === 0 || bp.x === prevX) {
        return clamp01(bp.y);
      }
      const t = (rawScore - prevX) / Math.max(Number.EPSILON, bp.x - prevX);
      return clamp01(prevY + t * (bp.y - prevY));
    }
    prevX = bp.x;
    prevY = bp.y;
    lastY = bp.y;
  }
  return clamp01(lastY);
}

// ── Platt scaling (Newton-Raphson on logistic regression) ─────────────────

/**
 * Fits `σ(a · raw + b)` to (rawScore, label) pairs via Newton's method
 * with L2 ridge regularisation on the Hessian. Returns `{a, b}` in the
 * shape consumed by {@link Calibrator.applyCalibration} (Platt branch).
 *
 * Bias initialised to Lin et al. (2007) prior log-odds.
 */
export function fitPlattScaling(
  samples: readonly CalibrationSample[],
): { readonly a: number; readonly b: number } {
  if (samples.length === 0) {
    return { a: 0, b: 0 };
  }

  let positives = 0;
  let negatives = 0;
  for (const s of samples) {
    if (s.label === 1) positives += 1;
    else negatives += 1;
  }
  if (positives === 0 || negatives === 0) {
    // Degenerate: only one class. Return params that bias toward that class.
    const b = positives === 0 ? -PLATT_DEGENERATE_BIAS : PLATT_DEGENERATE_BIAS;
    return { a: 0, b };
  }

  let a = 0;
  let b = Math.log((negatives + 1) / (positives + 1));

  for (let iter = 0; iter < PLATT_MAX_ITERATIONS; iter++) {
    let gA = 0;
    let gB = 0;
    let hAA = PLATT_RIDGE;
    let hAB = 0;
    let hBB = PLATT_RIDGE;

    for (const s of samples) {
      const z = a * s.rawScore + b;
      const p = sigmoid(z);
      const w = p * (1 - p);
      const r = p - s.label;
      gA += r * s.rawScore;
      gB += r;
      hAA += w * s.rawScore * s.rawScore;
      hAB += w * s.rawScore;
      hBB += w;
    }

    // Solve 2x2 H · Δ = g for Δ (Δ = step direction toward minimum of -L).
    const det = hAA * hBB - hAB * hAB;
    if (!Number.isFinite(det) || Math.abs(det) < Number.EPSILON) {
      break;
    }
    const dA = (hBB * gA - hAB * gB) / det;
    const dB = (hAA * gB - hAB * gA) / det;

    // Backtracking line search to guard against overshoot.
    let step = 1;
    const baseLoss = plattNegativeLogLikelihood(samples, a, b);
    let newA = a;
    let newB = b;
    for (let ls = 0; ls < PLATT_LINE_SEARCH_ITERATIONS; ls++) {
      newA = a - step * dA;
      newB = b - step * dB;
      const newLoss = plattNegativeLogLikelihood(samples, newA, newB);
      if (newLoss < baseLoss) break;
      step *= PLATT_LINE_SEARCH_SHRINK;
    }

    const change = Math.max(Math.abs(newA - a), Math.abs(newB - b));
    a = newA;
    b = newB;
    if (change < PLATT_PARAM_TOLERANCE) break;
  }

  // Hessian inversion can drift on pathological data (e.g. all rawScore=0).
  // If we end up with non-finite params, fall back to the prior-bias-only
  // baseline so the persisted CalibrationParams can never poison the
  // runtime calibrator with NaN multipliers.
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { a: 0, b: Math.log((negatives + 1) / (positives + 1)) };
  }

  return { a, b };
}

function plattNegativeLogLikelihood(
  samples: readonly CalibrationSample[],
  a: number,
  b: number,
): number {
  let loss = 0;
  for (const s of samples) {
    const z = a * s.rawScore + b;
    // log(1 + exp(-z)) for y=1, log(1 + exp(z)) for y=0 — numerically stable.
    if (s.label === 1) {
      loss += logSumExpZero(-z);
    } else {
      loss += logSumExpZero(z);
    }
  }
  return loss;
}

/** Returns log(1 + exp(x)) without overflow for large positive x. */
function logSumExpZero(x: number): number {
  if (x > 0) return x + Math.log1p(Math.exp(-x));
  return Math.log1p(Math.exp(x));
}

// ── Temperature scaling (1-D bisection on derivative of NLL) ──────────────

/**
 * Fits temperature `T > 0` so that `σ(raw / T)` minimises NLL against the
 * binary labels. The NLL is convex in `1/T`, so we bisect on the derivative
 * of NLL w.r.t. log(T). Returns `T = 1` as a safe identity fallback for
 * single-class or empty data.
 */
export function fitTemperatureScaling(
  samples: readonly CalibrationSample[],
): { readonly temperature: number } {
  if (samples.length === 0) {
    return { temperature: 1 };
  }
  let hasPos = false;
  let hasNeg = false;
  for (const s of samples) {
    if (s.label === 1) hasPos = true;
    else hasNeg = true;
    if (hasPos && hasNeg) break;
  }
  if (!hasPos || !hasNeg) {
    return { temperature: 1 };
  }

  // Bisect on log(T).
  let lo = Math.log(TEMPERATURE_LOWER_BOUND);
  let hi = Math.log(TEMPERATURE_UPPER_BOUND);
  const derivative = (logT: number): number => {
    const T = Math.exp(logT);
    let d = 0;
    for (const s of samples) {
      const z = s.rawScore / T;
      const p = sigmoid(z);
      // ∂NLL/∂logT = sum((p - y) · z) · (-1)
      d += -(p - s.label) * z;
    }
    return d;
  };
  const dLo = derivative(lo);
  const dHi = derivative(hi);
  if (Math.sign(dLo) === Math.sign(dHi)) {
    // No sign change — minimum is at the bound closest to zero derivative.
    return { temperature: Math.exp(Math.abs(dLo) < Math.abs(dHi) ? lo : hi) };
  }
  for (let iter = 0; iter < TEMPERATURE_BISECTION_ITERATIONS; iter++) {
    const mid = (lo + hi) / 2;
    const dMid = derivative(mid);
    if (Math.sign(dMid) === Math.sign(dLo)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const result = Math.exp((lo + hi) / 2);
  // Bisection on a malformed derivative landscape can produce Infinity /
  // NaN at the bound limits. Fall back to identity scaling (T=1) so the
  // persisted params stay finite — runtime calibrator would otherwise
  // divide by NaN and emit NaN confidences.
  if (!Number.isFinite(result) || result <= 0) {
    return { temperature: 1 };
  }
  return { temperature: result };
}

// ── Expected Calibration Error (ECE) ──────────────────────────────────────

/**
 * Expected Calibration Error: weighted gap between predicted probability
 * and observed accuracy across `binCount` equal-width bins of the [0, 1]
 * prediction range.
 *
 * `ECE = Σ_b (|B_b| / N) · |acc(B_b) − conf(B_b)|`
 *
 * Naeini et al. 2015. Lower is better; perfectly calibrated models have ECE = 0.
 */
export function expectedCalibrationError(
  predictions: readonly number[],
  labels: readonly (0 | 1)[],
  binCount: number = DEFAULT_ECE_BIN_COUNT,
): number {
  if (predictions.length !== labels.length) {
    throw new Error(
      `ECE: predictions (${predictions.length}) and labels (${labels.length}) length mismatch`,
    );
  }
  if (predictions.length === 0) return 0;
  if (binCount < 1) throw new Error('ECE: binCount must be >= 1');

  const binCounts = new Array<number>(binCount).fill(0);
  const binCorrect = new Array<number>(binCount).fill(0);
  const binConfSum = new Array<number>(binCount).fill(0);

  // Surfaces NaN/Infinity predictions distinctly so they can't quietly
  // collapse into bin 0 (or into an out-of-range NaN index that
  // JavaScript coerces to a string key on the array). A miscalibrated
  // candidate that emits NaN must fail loud — silent absorption into
  // ECE would make a broken fitter look perfectly calibrated.
  let nonFiniteCount = 0;
  let validCount = 0;
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    const y = labels[i];
    if (p === undefined || y === undefined) continue;
    if (!Number.isFinite(p)) {
      nonFiniteCount += 1;
      continue;
    }
    const clamped = Math.max(0, Math.min(1 - Number.EPSILON, p));
    const bin = Math.min(binCount - 1, Math.floor(clamped * binCount));
    binCounts[bin] = (binCounts[bin] ?? 0) + 1;
    binCorrect[bin] = (binCorrect[bin] ?? 0) + y;
    binConfSum[bin] = (binConfSum[bin] ?? 0) + p;
    validCount += 1;
  }

  // ECE on a sample of all-NaN predictions is undefined; report the worst
  // possible value (1) rather than 0. Same when every prediction was
  // out-of-range — the model is fundamentally broken.
  if (validCount === 0) {
    return nonFiniteCount > 0 ? 1 : 0;
  }

  let ece = 0;
  for (let b = 0; b < binCount; b++) {
    const count = binCounts[b] ?? 0;
    if (count === 0) continue;
    const acc = (binCorrect[b] ?? 0) / count;
    const conf = (binConfSum[b] ?? 0) / count;
    ece += (count / validCount) * Math.abs(acc - conf);
  }
  // If any prediction was non-finite, mix in a penalty so the reported
  // ECE rises monotonically with the broken-fraction — keeps the
  // best-fit selector from preferring a NaN-emitting fitter just because
  // it scored low on the finite subset.
  if (nonFiniteCount > 0) {
    const total = validCount + nonFiniteCount;
    ece = ece * (validCount / total) + (nonFiniteCount / total);
  }
  return ece;
}

// ── Best fit selector ─────────────────────────────────────────────────────

export interface FitBestCalibrationOptions {
  /**
   * Fraction of samples reserved for holdout ECE measurement. Defaults to
   * {@link DEFAULT_HOLDOUT_FRACTION} (0.2). Set to 0 to opt out and report
   * in-sample ECE (for very small datasets or unit tests).
   */
  readonly holdoutFraction?: number;
}

interface StratifiedSplit {
  readonly train: readonly CalibrationSample[];
  readonly holdout: readonly CalibrationSample[];
  /** True when the split actually carries holdout samples (otherwise in-sample). */
  readonly hasHoldout: boolean;
}

/**
 * Deterministic stratified split: positives and negatives each take their
 * own every-Nth slice for the holdout, balancing class proportions.
 * Deterministic ordering (no RNG) lets two calls on the same data produce
 * the same params — important for reproducible training pipelines.
 */
function stratifiedHoldoutSplit(
  samples: readonly CalibrationSample[],
  holdoutFraction: number,
): StratifiedSplit {
  if (holdoutFraction <= 0 || samples.length < MIN_HOLDOUT_TOTAL) {
    return { train: samples, holdout: [], hasHoldout: false };
  }
  const positives: CalibrationSample[] = [];
  const negatives: CalibrationSample[] = [];
  for (const s of samples) {
    (s.label === 1 ? positives : negatives).push(s);
  }
  // Sort each class by rawScore so the every-Nth stride spans the score range.
  positives.sort((a, b) => a.rawScore - b.rawScore);
  negatives.sort((a, b) => a.rawScore - b.rawScore);

  const stride = Math.max(2, Math.round(1 / holdoutFraction));
  const train: CalibrationSample[] = [];
  const holdout: CalibrationSample[] = [];
  const slice = (arr: readonly CalibrationSample[]): void => {
    for (let i = 0; i < arr.length; i++) {
      const sample = arr[i];
      if (sample === undefined) continue;
      if (i % stride === 0) holdout.push(sample);
      else train.push(sample);
    }
  };
  slice(positives);
  slice(negatives);

  // Refuse to split if either class would have zero training samples — a
  // single-class train set produces degenerate fits.
  const trainPos = train.filter((s) => s.label === 1).length;
  const trainNeg = train.length - trainPos;
  if (trainPos === 0 || trainNeg === 0 || holdout.length === 0) {
    return { train: samples, holdout: [], hasHoldout: false };
  }
  return { train, holdout, hasHoldout: true };
}

/**
 * Fits all three methods (Platt, temperature, isotonic) on the training
 * subset of the provided samples, measures ECE on a held-out subset, and
 * returns the {@link CalibrationParams} for the method with the lowest
 * holdout ECE — then refits that chosen method on the FULL sample set so
 * the persisted parameters use all available data.
 *
 * In-sample fallback fires when the dataset is too small to split safely
 * ({@link MIN_HOLDOUT_TOTAL}) or when one class would be wiped out by the
 * holdout cut. The returned `ece` is the holdout ECE when available, else
 * the in-sample ECE — callers can detect which by checking the trainedAt
 * timestamp's relationship to `holdoutFraction` or via the `outOfSample`
 * flag exposed through {@link fitBestCalibrationWithDiagnostics}.
 *
 * Empty / single-class data → identity-isotonic fallback (calibration
 * without label diversity is undefined).
 */
export function fitBestCalibration(
  samples: readonly CalibrationSample[],
  queryClass: QueryClass,
  options: FitBestCalibrationOptions = {},
): CalibrationParams {
  return fitBestCalibrationWithDiagnostics(samples, queryClass, options).params;
}

export interface FitBestCalibrationDiagnostics {
  readonly params: CalibrationParams;
  /** True when the reported ECE was measured on a holdout set, not the training set. */
  readonly outOfSample: boolean;
  /** ECE measured for every candidate method on the holdout (or in-sample). */
  readonly methodEce: Readonly<Record<'platt' | 'temperature' | 'isotonic', number>>;
}

/**
 * Diagnostic variant of {@link fitBestCalibration} for operators who need
 * to inspect the per-method ECE values + whether the measurement was on
 * holdout. The CLI prints this to give the operator visibility into
 * "why was isotonic chosen over Platt for this query class".
 */
export function fitBestCalibrationWithDiagnostics(
  samples: readonly CalibrationSample[],
  queryClass: QueryClass,
  options: FitBestCalibrationOptions = {},
): FitBestCalibrationDiagnostics {
  const trainedAt = new Date();
  if (samples.length === 0) {
    return {
      params: {
        method: 'isotonic',
        queryClass,
        params: { breakpoint_count: 0 },
        trainedAt,
        ece: 1,
      },
      outOfSample: false,
      methodEce: { platt: 1, temperature: 1, isotonic: 1 },
    };
  }

  const holdoutFraction = options.holdoutFraction ?? DEFAULT_HOLDOUT_FRACTION;
  const split = stratifiedHoldoutSplit(samples, holdoutFraction);
  const train = split.train;
  const evalSet = split.hasHoldout ? split.holdout : train;
  const evalLabels = evalSet.map((s) => s.label);

  // Fit candidates on the training subset, score them on the eval subset.
  const platt = fitPlattScaling(train);
  const plattPreds = evalSet.map((s) => sigmoid(platt.a * s.rawScore + platt.b));
  const plattEce = expectedCalibrationError(plattPreds, evalLabels);

  const temperature = fitTemperatureScaling(train);
  const temperaturePreds = evalSet.map((s) => sigmoid(s.rawScore / temperature.temperature));
  const temperatureEce = expectedCalibrationError(temperaturePreds, evalLabels);

  const isotonicTrain = fitIsotonicRegression(train);
  const isotonicPreds = evalSet.map((s) => applyIsotonicFit(s.rawScore, isotonicTrain.breakpoints));
  const isotonicEce = expectedCalibrationError(isotonicPreds, evalLabels);

  const methodEce = {
    platt: plattEce,
    temperature: temperatureEce,
    isotonic: isotonicEce,
  } as const;

  // Pick the method with the lowest eval ECE.
  let bestMethod: 'platt' | 'temperature' | 'isotonic' = 'isotonic';
  let bestEce = isotonicEce;
  if (plattEce < bestEce) {
    bestMethod = 'platt';
    bestEce = plattEce;
  }
  if (temperatureEce < bestEce) {
    bestMethod = 'temperature';
    bestEce = temperatureEce;
  }

  // Refit the chosen method on the FULL sample set so persisted params use
  // every available datapoint — the holdout only served as a model-selection
  // signal, not as a deployed-params filter.
  let params: CalibrationParams;
  if (bestMethod === 'platt') {
    const full = fitPlattScaling(samples);
    params = {
      method: 'platt',
      queryClass,
      params: { a: full.a, b: full.b },
      trainedAt,
      ece: bestEce,
    };
  } else if (bestMethod === 'temperature') {
    const full = fitTemperatureScaling(samples);
    params = {
      method: 'temperature',
      queryClass,
      params: { temperature: full.temperature },
      trainedAt,
      ece: bestEce,
    };
  } else {
    const full = fitIsotonicRegression(samples);
    params = {
      method: 'isotonic',
      queryClass,
      params: encodeIsotonicParams(full.breakpoints),
      trainedAt,
      ece: bestEce,
    };
  }

  return {
    params,
    outOfSample: split.hasHoldout,
    methodEce,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
