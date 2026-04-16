import { describe, expect, it } from 'vitest';
import {
  inferDrinkingWindowBlockingEligibility,
  inferDrinkingWindowConfidence,
  inferDrinkingWindowEvidenceLevel,
} from '../drinking-window-confidence.js';

describe('inferDrinkingWindowConfidence', () => {
  it('treats non-learned model versions as low confidence', () => {
    expect(inferDrinkingWindowConfidence('heuristic-v1.0-enc20260405')).toBe('low');
  });

  it('treats missing model versions as low confidence', () => {
    expect(inferDrinkingWindowConfidence(undefined)).toBe('low');
    expect(inferDrinkingWindowConfidence('')).toBe('low');
  });

  it('treats unloaded sentinel as low confidence', () => {
    expect(inferDrinkingWindowConfidence('unloaded')).toBe('low');
  });

  it('treats explicit ONNX model versions as high confidence', () => {
    expect(inferDrinkingWindowConfidence('onnx:v2.1-enc20260405')).toBe('high');
  });
});

describe('drinking-window evidence helpers', () => {
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

  it('marks ONNX model versions as learned and blocking-eligible', () => {
    expect(inferDrinkingWindowEvidenceLevel('onnx:v2.1-enc20260405')).toBe('learned');
    expect(inferDrinkingWindowBlockingEligibility('onnx:v2.1-enc20260405')).toBe(true);
  });
});
