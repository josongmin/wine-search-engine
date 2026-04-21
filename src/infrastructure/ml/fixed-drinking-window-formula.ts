import type {
  DrinkingWindowDeterministicFormulaPort,
  DrinkingWindowDeterministicFormulaResult,
} from '../../domain/drinking-window/port/drinking-window-deterministic-formula.port.js';
import type { DrinkingWindowDeterministicInputV2 } from '../../domain/drinking-window/model/drinking-window-deterministic-input-v2.js';

/**
 * Placeholder deterministic formula.
 *
 * This deliberately returns fixed offsets so the deterministic formula seam is
 * available now without introducing a heuristic runtime fallback. Replace the
 * constants with a real structural equation in a follow-up change.
 *
 * Recommended future equation shape for this class:
 * - `agingBackbone = w1*tannin + w2*acidity + w3*(body*tannin)`
 * - `earlyApproachability = w4*sweetness - w5*tannin`
 * - `criticSupport = w6*(avgCriticProxyScore/100)`
 * - `varietyPlacePrior = prior(grapePrimaryEnc, regionEnc, countryEnc, grapePrimary, appellation, regionHierarchy)`
 * - `elevagePrior = prior(oakTreatment, producerType, producerPrestige, classification)`
 * - `stylePrior = prior(wineType, style, alcoholPct, finishLength, certifications)`
 * - `startOffset = clamp(openBase + agingBackbone - earlyApproachability + varietyPlacePrior.open)`
 * - `endOffset = clamp(closeBase + agingBackbone + criticSupport + varietyPlacePrior.close + elevagePrior + stylePrior)`
 *
 * We intentionally do NOT apply any of those weights yet. This file is only a
 * deterministic slot with a fixed output contract so later structural work can
 * land without reopening runtime wiring.
 */
export const FIXED_DRINKING_WINDOW_FORMULA_VERSION = 'fixed-slot-v1';
const FIXED_START_OFFSET_YEARS = 4;
const FIXED_END_OFFSET_YEARS = 12;
const FIXED_PEAK_OFFSET_YEARS = 8;

export class FixedDrinkingWindowFormula implements DrinkingWindowDeterministicFormulaPort {
  readonly formulaVersion = FIXED_DRINKING_WINDOW_FORMULA_VERSION;

  evaluate(_input: DrinkingWindowDeterministicInputV2): DrinkingWindowDeterministicFormulaResult {
    return {
      startOffsetYears: FIXED_START_OFFSET_YEARS,
      endOffsetYears: FIXED_END_OFFSET_YEARS,
      peakOffsetYears: FIXED_PEAK_OFFSET_YEARS,
      confidence: 'low',
    };
  }
}
