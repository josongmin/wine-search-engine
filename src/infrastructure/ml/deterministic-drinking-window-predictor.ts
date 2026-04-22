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

    return {
      drinkingWindowStart,
      drinkingWindowEnd,
      peakYear,
      confidence: evaluated.confidence,
      modelVersion: this.modelVersion,
    };
  }
}
