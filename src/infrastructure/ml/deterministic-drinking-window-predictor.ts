import type {
  DrinkingWindowDeterministicFormulaPort,
} from '../../domain/drinking-window/port/drinking-window-deterministic-formula.port.js';
import {
  type DrinkingWindowDeterministicInputV2,
  toDrinkingWindowDeterministicInputV2,
} from '../../domain/drinking-window/model/drinking-window-deterministic-input-v2.js';
import type {
  DrinkingWindowInput,
  DrinkingWindowPrediction,
  DrinkingWindowPredictorPort,
} from '../../domain/drinking-window/port/drinking-window-predictor.port.js';
import { StructuralDrinkingWindowFormula } from './structural-drinking-window-formula.js';

/**
 * Deterministic drinking-window predictor.
 *
 * This is the runtime baseline predictor. ONNX, when configured, can override
 * it as the learned path without changing use-case or port contracts.
 *
 * Mapping contract:
 * - formula emits offsets, never absolute years
 * - predictor anchors offsets to `input.vintage`
 * - predictor enforces the hard invariant `end >= start + 1`
 *
 * That split is intentional so future formula implementations can focus on
 * cellarability math while this adapter remains the single place that turns
 * offsets into user-facing calendar years.
 */
export class DeterministicDrinkingWindowPredictor implements DrinkingWindowPredictorPort {
  constructor(
    private readonly formula: DrinkingWindowDeterministicFormulaPort = new StructuralDrinkingWindowFormula(),
  ) {}

  get modelVersion(): string {
    return `deterministic:${this.formula.formulaVersion}`;
  }

  predict(input: DrinkingWindowInput): DrinkingWindowPrediction {
    return this.predictStructured(toDrinkingWindowDeterministicInputV2(input));
  }

  predictStructured(input: DrinkingWindowDeterministicInputV2): DrinkingWindowPrediction {
    // Rule 28: vintage is the absolute calendar anchor for every offset. A
    // non-finite vintage silently turns drinkingWindowStart/End/peakYear into
    // NaN (serialized as `null`), and `end > start` becomes `NaN > NaN` =
    // false — the window-validity invariant collapses without any error. The
    // ONNX path already throws here (predictWithOnnx); the deterministic path
    // must fail just as loudly rather than fabricate a null-year prediction.
    if (!Number.isFinite(input.vintage)) {
      throw new Error(
        `DeterministicDrinkingWindowPredictor: vintage is not finite (got ${String(input.vintage)})`,
      );
    }
    const evaluated = this.formula.evaluate(input);
    const drinkingWindowStart = Math.round(
      input.vintage + Math.max(0, evaluated.startOffsetYears),
    );
    const drinkingWindowEnd = Math.max(
      drinkingWindowStart + 1,
      Math.round(input.vintage + evaluated.endOffsetYears),
    );
    const peakYear = evaluated.peakOffsetYears !== undefined
      ? Math.round(input.vintage + evaluated.peakOffsetYears)
      : Math.round(
          drinkingWindowStart + (drinkingWindowEnd - drinkingWindowStart) / 2,
        );

    // Rule 15: numeric fallback documents the contract — when the formula
    // omits a confidenceScore we fall back to the midpoint of the medium
    // band so downstream numeric consumers can still rank wines without
    // collapsing to NaN. CONFIDENCE_FALLBACK_MEDIUM = midpoint of [0.5, 0.75).
    const CONFIDENCE_FALLBACK_MEDIUM = 0.625;
    const confidenceScore = evaluated.confidenceScore ?? CONFIDENCE_FALLBACK_MEDIUM;

    return {
      drinkingWindowStart,
      drinkingWindowEnd,
      peakYear,
      confidence: evaluated.confidence,
      confidenceScore,
      modelVersion: this.modelVersion,
    };
  }
}
