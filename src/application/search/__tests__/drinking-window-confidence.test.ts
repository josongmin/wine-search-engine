import { describe, expect, it } from 'vitest';
import {
  inferDrinkingWindowBlockingEligibility,
  inferDrinkingWindowConfidence,
  inferDrinkingWindowEvidenceLevel,
  isProjectableDrinkingWindowModelVersion,
  isRuntimeSupportedDrinkingWindowModelVersion,
} from '../drinking-window-confidence.js';

describe('inferDrinkingWindowConfidence', () => {
  it('treats heuristic model versions as low confidence', () => {
    expect(inferDrinkingWindowConfidence('heuristic-v1.0-enc20260405')).toBe('low');
  });

  it('treats missing model versions as low confidence', () => {
    expect(inferDrinkingWindowConfidence(undefined)).toBe('low');
    expect(inferDrinkingWindowConfidence('')).toBe('low');
  });

  it('treats unloaded sentinel as low confidence', () => {
    expect(inferDrinkingWindowConfidence('unloaded')).toBe('low');
  });

  it('treats deterministic model versions as high confidence', () => {
    expect(inferDrinkingWindowConfidence('deterministic:structural-slot-v2')).toBe('high');
  });

  it('treats explicit ONNX model versions as high confidence', () => {
    expect(inferDrinkingWindowConfidence('onnx:v2.1-enc20260405')).toBe('high');
  });
});

describe('drinking-window evidence helpers', () => {
  it('accepts deterministic and ONNX namespaces as runtime models only', () => {
    expect(isRuntimeSupportedDrinkingWindowModelVersion('deterministic:structural-slot-v2')).toBe(true);
    expect(isRuntimeSupportedDrinkingWindowModelVersion('onnx:v2.1-enc20260405')).toBe(true);
    expect(isRuntimeSupportedDrinkingWindowModelVersion('heuristic-v1.0-enc20260405')).toBe(false);
    expect(isRuntimeSupportedDrinkingWindowModelVersion('dw-v1')).toBe(false);
  });

  it('keeps legacy indexed learned namespaces projectable for backward compatibility', () => {
    expect(isProjectableDrinkingWindowModelVersion('deterministic:structural-slot-v2')).toBe(true);
    expect(isProjectableDrinkingWindowModelVersion('onnx:v2.1-enc20260405')).toBe(true);
    expect(isProjectableDrinkingWindowModelVersion('dw-v1')).toBe(true);
    expect(isProjectableDrinkingWindowModelVersion('learned-v1.0-seeded')).toBe(true);
    expect(isProjectableDrinkingWindowModelVersion('heuristic-v1.0-enc20260405')).toBe(false);
  });

  it('returns undefined evidence for heuristic model versions', () => {
    expect(inferDrinkingWindowEvidenceLevel('heuristic-v1.0-enc20260405')).toBeUndefined();
    expect(inferDrinkingWindowBlockingEligibility('heuristic-v1.0-enc20260405')).toBe(false);
  });

  it('returns undefined evidence for missing/empty/unloaded model versions', () => {
    expect(inferDrinkingWindowEvidenceLevel(undefined)).toBeUndefined();
    expect(inferDrinkingWindowEvidenceLevel('')).toBeUndefined();
    expect(inferDrinkingWindowEvidenceLevel('unloaded')).toBeUndefined();
    expect(inferDrinkingWindowBlockingEligibility(undefined)).toBe(false);
    expect(inferDrinkingWindowBlockingEligibility('')).toBe(false);
    expect(inferDrinkingWindowBlockingEligibility('unloaded')).toBe(false);
  });

  it('marks deterministic model versions as deterministic evidence and blocking-eligible', () => {
    expect(inferDrinkingWindowEvidenceLevel('deterministic:structural-slot-v2')).toBe('deterministic');
    expect(inferDrinkingWindowBlockingEligibility('deterministic:structural-slot-v2')).toBe(true);
  });

  it('maps legacy indexed learned namespaces to learned evidence', () => {
    expect(inferDrinkingWindowEvidenceLevel('dw-v1')).toBe('learned');
    expect(inferDrinkingWindowEvidenceLevel('learned-v1.0-seeded')).toBe('learned');
    expect(inferDrinkingWindowBlockingEligibility('dw-v1')).toBe(true);
  });

  it('marks ONNX model versions as learned and blocking-eligible', () => {
    expect(inferDrinkingWindowEvidenceLevel('onnx:v2.1-enc20260405')).toBe('learned');
    expect(inferDrinkingWindowBlockingEligibility('onnx:v2.1-enc20260405')).toBe(true);
  });
});
