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
    const b = positives === 0 ? -10 : 10;
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
    for (let ls = 0; ls < 20; ls++) {
      newA = a - step * dA;
      newB = b - step * dB;
      const newLoss = plattNegativeLogLikelihood(samples, newA, newB);
      if (newLoss < baseLoss) break;
      step *= 0.5;
    }

    const change = Math.max(Math.abs(newA - a), Math.abs(newB - b));
    a = newA;
    b = newB;
    if (change < PLATT_PARAM_TOLERANCE) break;
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
  return { temperature: Math.exp((lo + hi) / 2) };
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

  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    const y = labels[i];
    if (p === undefined || y === undefined) continue;
    const clamped = Math.max(0, Math.min(1 - Number.EPSILON, p));
    const bin = Math.min(binCount - 1, Math.floor(clamped * binCount));
    binCounts[bin] = (binCounts[bin] ?? 0) + 1;
    binCorrect[bin] = (binCorrect[bin] ?? 0) + y;
    binConfSum[bin] = (binConfSum[bin] ?? 0) + p;
  }

  let ece = 0;
  const n = predictions.length;
  for (let b = 0; b < binCount; b++) {
    const count = binCounts[b] ?? 0;
    if (count === 0) continue;
    const acc = (binCorrect[b] ?? 0) / count;
    const conf = (binConfSum[b] ?? 0) / count;
    ece += (count / n) * Math.abs(acc - conf);
  }
  return ece;
}

// ── Best fit selector ─────────────────────────────────────────────────────

/**
 * Fits all three methods (Platt, temperature, isotonic) on the provided
 * samples, measures ECE for each, and returns the {@link CalibrationParams}
 * for the method with the lowest ECE.
 *
 * Falls back to an empty isotonic (identity) when samples are empty or
 * degenerate (single class) — calibration without label diversity is
 * undefined.
 */
export function fitBestCalibration(
  samples: readonly CalibrationSample[],
  queryClass: QueryClass,
): CalibrationParams {
  if (samples.length === 0) {
    return {
      method: 'isotonic',
      queryClass,
      params: { breakpoint_count: 0 },
      trainedAt: new Date(),
      ece: 1,
    };
  }
  const labels = samples.map((s) => s.label);

  const platt = fitPlattScaling(samples);
  const plattPreds = samples.map((s) => sigmoid(platt.a * s.rawScore + platt.b));
  const plattEce = expectedCalibrationError(plattPreds, labels);

  const temperature = fitTemperatureScaling(samples);
  const temperaturePreds = samples.map((s) => sigmoid(s.rawScore / temperature.temperature));
  const temperatureEce = expectedCalibrationError(temperaturePreds, labels);

  const isotonic = fitIsotonicRegression(samples);
  const isotonicPreds = samples.map((s) => applyIsotonicFit(s.rawScore, isotonic.breakpoints));
  const isotonicEce = expectedCalibrationError(isotonicPreds, labels);

  const trainedAt = new Date();
  const candidates: readonly CalibrationParams[] = [
    {
      method: 'platt',
      queryClass,
      params: { a: platt.a, b: platt.b },
      trainedAt,
      ece: plattEce,
    },
    {
      method: 'temperature',
      queryClass,
      params: { temperature: temperature.temperature },
      trainedAt,
      ece: temperatureEce,
    },
    {
      method: 'isotonic',
      queryClass,
      params: encodeIsotonicParams(isotonic.breakpoints),
      trainedAt,
      ece: isotonicEce,
    },
  ];

  let best = candidates[0];
  for (const candidate of candidates) {
    if (best === undefined || candidate.ece < best.ece) {
      best = candidate;
    }
  }
  if (best === undefined) {
    throw new Error('fitBestCalibration: no candidate selected (unreachable)');
  }
  return best;
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
