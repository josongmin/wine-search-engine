import type { DrinkingWindowDeterministicInputV2 } from '../model/drinking-window-deterministic-input-v2.js';

/**
 * Deterministic drinking-window formula contract.
 *
 * This is a structural slot for a future parametric formula. The current
 * implementation is intentionally simple and deterministic so runtime wiring
 * can be added later without changing the predictor contract.
 *
 * Inputs are defined by {@link DrinkingWindowDeterministicInputV2}, which is
 * intentionally much wider than the current learned predictor port.
 */
export interface DrinkingWindowDeterministicFormulaResult {
  readonly startOffsetYears: number;
  readonly endOffsetYears: number;
  readonly peakOffsetYears?: number | undefined;
  readonly peakStartOffsetYears?: number | undefined;
  readonly peakEndOffsetYears?: number | undefined;
  readonly longevityScore?: number | undefined;
  readonly readinessScore?: number | undefined;
  readonly confidenceScore?: number | undefined;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly termBreakdown?: DrinkingWindowDeterministicTermBreakdown | undefined;
}

export interface DrinkingWindowDeterministicTermContribution {
  readonly value: number;
  readonly rationale: string;
}

export interface DrinkingWindowDeterministicTermBreakdown {
  readonly varietalAnchor: DrinkingWindowDeterministicTermContribution;
  readonly blendAdjustment: DrinkingWindowDeterministicTermContribution;
  readonly marketQuality: DrinkingWindowDeterministicTermContribution;
  readonly producerStrength: DrinkingWindowDeterministicTermContribution;
  readonly priceSignal: DrinkingWindowDeterministicTermContribution;
  readonly bottleSizeFactor: DrinkingWindowDeterministicTermContribution;
  readonly closureAdjustment: DrinkingWindowDeterministicTermContribution;
  readonly longevity: DrinkingWindowDeterministicTermContribution;
  readonly readiness: DrinkingWindowDeterministicTermContribution;
  readonly confidence: DrinkingWindowDeterministicTermContribution;
  readonly offsets: {
    readonly drinkFromYears: number;
    readonly peakStartYears: number;
    readonly peakCenterYears: number;
    readonly peakEndYears: number;
    readonly bestUntilYears: number;
  };
}

/**
 * Formula interface for deterministic drinking-window prediction.
 *
 * Implementations must be pure and deterministic for a given input.
 * The intended long-term shape is:
 * - `startOffsetYears = f_open(structure, freshness, priors, critic)`
 * - `endOffsetYears = f_close(structure, freshness, priors, critic)`
 * with explicit invariants such as `endOffsetYears > startOffsetYears`.
 */
export interface DrinkingWindowDeterministicFormulaPort {
  readonly formulaVersion: string;
  evaluate(input: DrinkingWindowDeterministicInputV2): DrinkingWindowDeterministicFormulaResult;
}
