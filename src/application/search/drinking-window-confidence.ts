import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';

function isOnnxDrinkingWindowModelVersion(modelVersion?: string): boolean {
  return modelVersion !== undefined && modelVersion.startsWith('onnx:');
}

function isDeterministicDrinkingWindowModelVersion(modelVersion?: string): boolean {
  return modelVersion !== undefined && modelVersion.startsWith('deterministic:');
}

function isLegacyLearnedIndexedDrinkingWindowModelVersion(modelVersion?: string): boolean {
  return modelVersion !== undefined
    && (modelVersion.startsWith('dw-') || modelVersion.startsWith('learned-'));
}

export function isRuntimeSupportedDrinkingWindowModelVersion(modelVersion?: string): boolean {
  return (
    isOnnxDrinkingWindowModelVersion(modelVersion)
    || isDeterministicDrinkingWindowModelVersion(modelVersion)
  );
}

export function isProjectableDrinkingWindowModelVersion(modelVersion?: string): boolean {
  return (
    isRuntimeSupportedDrinkingWindowModelVersion(modelVersion)
    || isLegacyLearnedIndexedDrinkingWindowModelVersion(modelVersion)
  );
}

export function inferDrinkingWindowEvidenceLevel(
  modelVersion?: string,
): DrinkingWindowBlock['evidenceLevel'] {
  if (isOnnxDrinkingWindowModelVersion(modelVersion) || isLegacyLearnedIndexedDrinkingWindowModelVersion(modelVersion)) {
    return 'learned';
  }
  if (isDeterministicDrinkingWindowModelVersion(modelVersion)) {
    return 'deterministic';
  }

  return undefined;
}

export function inferDrinkingWindowConfidence(
  modelVersion?: string,
): DrinkingWindowBlock['confidence'] {
  return inferDrinkingWindowEvidenceLevel(modelVersion) !== undefined ? 'high' : 'low';
}

export function inferDrinkingWindowBlockingEligibility(
  modelVersion?: string,
): boolean {
  return inferDrinkingWindowEvidenceLevel(modelVersion) !== undefined;
}
