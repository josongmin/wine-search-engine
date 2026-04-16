import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';

export function inferDrinkingWindowEvidenceLevel(
  modelVersion?: string,
): DrinkingWindowBlock['evidenceLevel'] {
  if (modelVersion !== undefined && modelVersion.startsWith('onnx:')) {
    return 'learned';
  }

  return undefined;
}

export function inferDrinkingWindowConfidence(
  modelVersion?: string,
): DrinkingWindowBlock['confidence'] {
  return inferDrinkingWindowEvidenceLevel(modelVersion) === 'learned' ? 'high' : 'low';
}

export function inferDrinkingWindowBlockingEligibility(
  modelVersion?: string,
): boolean {
  return inferDrinkingWindowEvidenceLevel(modelVersion) === 'learned';
}
