import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';

export function inferDrinkingWindowConfidence(
  modelVersion?: string,
): DrinkingWindowBlock['confidence'] {
  if (modelVersion === undefined || modelVersion.trim().length === 0) {
    return 'low';
  }

  return modelVersion.startsWith('heuristic') ? 'low' : 'high';
}
