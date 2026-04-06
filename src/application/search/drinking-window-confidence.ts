import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';

export function inferDrinkingWindowEvidenceLevel(
  modelVersion?: string,
): NonNullable<DrinkingWindowBlock['evidenceLevel']> {
  if (modelVersion === undefined || modelVersion.trim().length === 0) {
    return 'heuristic';
  }

  return modelVersion.startsWith('heuristic') ? 'heuristic' : 'learned';
}

export function inferDrinkingWindowConfidence(
  modelVersion?: string,
): DrinkingWindowBlock['confidence'] {
  return inferDrinkingWindowEvidenceLevel(modelVersion) === 'heuristic' ? 'low' : 'high';
}

export function inferDrinkingWindowBlockingEligibility(
  modelVersion?: string,
): boolean {
  return inferDrinkingWindowEvidenceLevel(modelVersion) === 'learned';
}
