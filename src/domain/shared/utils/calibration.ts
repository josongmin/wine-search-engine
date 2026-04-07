/**
 * Platt scaling: maps a raw logit to a calibrated probability using a sigmoid.
 *
 * Formula: P = 1 / (1 + exp(-(a * logit + b)))
 *
 * @param logit - The raw logit (uncalibrated score).
 * @param a - Slope parameter learned during calibration.
 * @param b - Intercept parameter learned during calibration.
 * @returns A calibrated probability in [0, 1].
 */
export function plattScaling(logit: number, a: number, b: number): number {
  return 1 / (1 + Math.exp(-(a * logit + b)));
}

/**
 * Temperature scaling: applies temperature-scaled softmax to an array of logits.
 *
 * Each output value is exp(logit_i / T) / sum(exp(logit_j / T)).
 *
 * @param logits - Array of raw logits.
 * @param temperature - Temperature parameter (T > 0). Higher T produces softer distributions.
 * @returns An array of calibrated probabilities in [0, 1] that sum to 1.
 * @throws {Error} If temperature is not positive or logits array is empty.
 */
export function temperatureScaling(logits: number[], temperature: number): number[] {
  if (temperature <= 0) {
    throw new Error('Temperature must be positive');
  }
  if (logits.length === 0) {
    throw new Error('Logits array must not be empty');
  }

  // Subtract max for numerical stability (loop avoids stack overflow on large arrays)
  let maxLogit = -Infinity;
  for (const l of logits) {
    if (l > maxLogit) maxLogit = l;
  }
  const scaled = logits.map((l) => Math.exp((l - maxLogit) / temperature));
  const sumScaled = scaled.reduce((acc, v) => acc + v, 0);

  return scaled.map((v) => v / sumScaled);
}
