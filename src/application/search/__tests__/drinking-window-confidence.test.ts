import { describe, expect, it } from 'vitest';
import {
  inferDrinkingWindowBlockingEligibility,
  inferDrinkingWindowConfidence,
  inferDrinkingWindowEvidenceLevel,
} from '../drinking-window-confidence.js';

describe('inferDrinkingWindowConfidence', () => {
  it('treats heuristic model versions as low confidence', () => {
    expect(inferDrinkingWindowConfidence('heuristic-v1.0-enc20260405')).toBe('low');
  });

  it('treats missing model versions as low confidence', () => {
    expect(inferDrinkingWindowConfidence(undefined)).toBe('low');
    expect(inferDrinkingWindowConfidence('')).toBe('low');
  });

  it('allows explicit non-heuristic model versions to surface as high confidence', () => {
    expect(inferDrinkingWindowConfidence('onnx-v2.1-enc20260405')).toBe('high');
  });
});

describe('drinking-window honesty helpers', () => {
  it('marks heuristic model versions as heuristic and non-blocking', () => {
    expect(inferDrinkingWindowEvidenceLevel('heuristic-v1.0-enc20260405')).toBe('heuristic');
    expect(inferDrinkingWindowBlockingEligibility('heuristic-v1.0-enc20260405')).toBe(false);
  });

  it('marks explicit learned model versions as learned and blocking-eligible', () => {
    expect(inferDrinkingWindowEvidenceLevel('onnx-v2.1-enc20260405')).toBe('learned');
    expect(inferDrinkingWindowBlockingEligibility('onnx-v2.1-enc20260405')).toBe(true);
  });
});
