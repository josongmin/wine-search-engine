import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import {
  MAX_PRODUCED_VINTAGE_YEAR,
  MIN_PRODUCED_VINTAGE_YEAR,
} from '../../domain/shared/constants.js';

function isProjectableDrinkingWindowYear(year: number | undefined): year is number {
  return year !== undefined
    && Number.isInteger(year)
    && year >= MIN_PRODUCED_VINTAGE_YEAR
    && year <= MAX_PRODUCED_VINTAGE_YEAR;
}

export function isProjectableDrinkingWindowVintage(
  vintageYear: number | undefined,
): vintageYear is number {
  return isProjectableDrinkingWindowYear(vintageYear);
}

export function projectDrinkingWindowBlock(
  block: DrinkingWindowBlock,
  targetYear: number,
): DrinkingWindowBlock | undefined {
  if (!Number.isFinite(targetYear)) {
    return undefined;
  }

  const start = block.drinkingWindowStart;
  const end = block.drinkingWindowEnd;
  if (!isProjectableDrinkingWindowYear(start) || !isProjectableDrinkingWindowYear(end) || start > end) {
    return undefined;
  }

  const peakYear = isProjectableDrinkingWindowYear(block.peakYear)
    && block.peakYear >= start
    && block.peakYear <= end
    ? block.peakYear
    : undefined;

  return {
    drinkingWindowStart: start,
    drinkingWindowEnd: end,
    ...(peakYear !== undefined ? { peakYear } : {}),
    currentlyDrinkable: targetYear >= start && targetYear <= end,
    confidence: block.confidence,
    ...(block.evidenceLevel !== undefined ? { evidenceLevel: block.evidenceLevel } : {}),
    ...(block.blockingEligible !== undefined ? { blockingEligible: block.blockingEligible } : {}),
    ...(block.modelVersion !== undefined ? { modelVersion: block.modelVersion } : {}),
  };
}
