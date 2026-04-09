/**
 * Platt scaling — sigmoid calibration of raw classifier scores.
 *
 * Reference: Platt 1999, "Probabilistic Outputs for Support Vector Machines".
 *
 * Fits P(correct=1 | score) = 1 / (1 + exp(a * score + b)) by gradient descent
 * on log-loss. Used as a post-hoc calibrator: feed raw model scores in,
 * get calibrated probabilities out.
 */

export interface PlattCalibrator {
  readonly a: number;
  readonly b: number;
  calibrate(rawScore: number): number;
}

/** Gradient descent learning rate (small for numerical stability). */
const PLATT_LEARNING_RATE = 0.01;
/** Max iterations of gradient descent. */
const PLATT_MAX_ITERATIONS = 200;
/** Initial sigmoid parameters (centered, unit slope). */
const PLATT_INIT_A = -1;
const PLATT_INIT_B = 0;
/** Numerical stability clamp on sigmoid input. */
const SIGMOID_INPUT_CLAMP = 50;

function sigmoid(z: number): number {
  // Clamp to avoid Math.exp overflow.
  if (z >  SIGMOID_INPUT_CLAMP) return 1;
  if (z < -SIGMOID_INPUT_CLAMP) return 0;
  return 1 / (1 + Math.exp(z));
}

class PlattCalibratorImpl implements PlattCalibrator {
  constructor(readonly a: number, readonly b: number) {}

  calibrate(rawScore: number): number {
    if (!Number.isFinite(rawScore)) return 0.5;
    return sigmoid(this.a * rawScore + this.b);
  }
}

/**
 * Fit a Platt sigmoid calibrator to (score, correct) pairs.
 *
 * Falls back to a degenerate calibrator (a=0, b=0 → constant 0.5) when
 * fewer than 2 valid points are available, since the sigmoid is undefined.
 */
export function fitPlattCalibrator(
  predictions: readonly { readonly score: number; readonly correct: boolean }[],
): PlattCalibrator {
  // Filter to finite scores only.
  const valid: { score: number; target: number }[] = [];
  for (const p of predictions) {
    if (!Number.isFinite(p.score)) continue;
    valid.push({ score: p.score, target: p.correct ? 1 : 0 });
  }
  if (valid.length < 2) {
    return new PlattCalibratorImpl(0, 0);
  }

  let a = PLATT_INIT_A;
  let b = PLATT_INIT_B;
  const N = valid.length;

  for (let iter = 0; iter < PLATT_MAX_ITERATIONS; iter++) {
    let gradA = 0;
    let gradB = 0;
    for (const v of valid) {
      const p = sigmoid(a * v.score + b);
      const error = p - v.target;
      gradA += error * v.score;
      gradB += error;
    }
    a -= (PLATT_LEARNING_RATE * gradA) / N;
    b -= (PLATT_LEARNING_RATE * gradB) / N;
  }

  return new PlattCalibratorImpl(a, b);
}
