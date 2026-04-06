import { describe, expect, it } from 'vitest';
import { inferDrinkingWindowConfidence } from '../drinking-window-confidence.js';

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
