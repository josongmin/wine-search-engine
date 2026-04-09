/**
 * ECE (Expected Calibration Error) — calibration quality of a probabilistic
 * classifier.
 *
 * Reference: Guo et al. 2017, "On Calibration of Modern Neural Networks".
 *
 * ECE = Σ (|B_m| / N) * |acc(B_m) - conf(B_m)|
 *
 * Lower ECE = better calibration. Default 15 bins per Guo et al.
 */

export interface ECEBin {
  readonly lo: number;
  readonly hi: number;
  readonly count: number;
  readonly avgConfidence: number;
  readonly accuracy: number;
  readonly calibrationError: number;
}

export interface ECEResult {
  readonly ece: number;
  readonly maxCalibrationError: number;
  readonly bins: readonly ECEBin[];
}

/** Default bin count from Guo et al. 2017. */
const DEFAULT_NUM_BINS = 15;

const EMPTY_RESULT: ECEResult = { ece: 0, maxCalibrationError: 0, bins: [] };

/**
 * Compute Expected Calibration Error from (confidence, correct) predictions.
 *
 * Confidence values are bucketed into `numBins` equal-width bins on [0, 1].
 * Predictions with confidence outside [0, 1] or non-finite are dropped.
 */
export function computeECE(
  predictions: readonly { readonly confidence: number; readonly correct: boolean }[],
  numBins: number = DEFAULT_NUM_BINS,
): ECEResult {
  if (predictions.length === 0 || numBins <= 0) {
    return EMPTY_RESULT;
  }

  const bins: { sum: number; correct: number; count: number; lo: number; hi: number }[] = [];
  for (let i = 0; i < numBins; i++) {
    bins.push({
      sum: 0,
      correct: 0,
      count: 0,
      lo: i / numBins,
      hi: (i + 1) / numBins,
    });
  }

  let validCount = 0;
  for (const p of predictions) {
    if (!Number.isFinite(p.confidence)) continue;
    if (p.confidence < 0 || p.confidence > 1) continue;
    // Right boundary inclusive on the last bin so confidence=1 lands in bin n-1.
    const idx = p.confidence === 1 ? numBins - 1 : Math.floor(p.confidence * numBins);
    const bin = bins[idx]!;
    bin.sum += p.confidence;
    if (p.correct) bin.correct++;
    bin.count++;
    validCount++;
  }

  if (validCount === 0) return EMPTY_RESULT;

  let ece = 0;
  let maxCal = 0;
  const result: ECEBin[] = [];
  for (const b of bins) {
    if (b.count === 0) {
      result.push({
        lo: b.lo,
        hi: b.hi,
        count: 0,
        avgConfidence: 0,
        accuracy: 0,
        calibrationError: 0,
      });
      continue;
    }
    const avgConfidence = b.sum / b.count;
    const accuracy = b.correct / b.count;
    const calibrationError = Math.abs(avgConfidence - accuracy);
    ece += (b.count / validCount) * calibrationError;
    if (calibrationError > maxCal) maxCal = calibrationError;
    result.push({
      lo: b.lo,
      hi: b.hi,
      count: b.count,
      avgConfidence,
      accuracy,
      calibrationError,
    });
  }

  return { ece, maxCalibrationError: maxCal, bins: result };
}
