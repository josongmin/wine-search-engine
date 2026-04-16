/**
 * Regression test: heuristic_drinking_window removal (2026-04-16).
 *
 * Ensures the heuristic drinking-window path is never re-introduced.
 * Append-only — never delete tests from this file.
 */

import { describe, expect, it } from 'vitest';
import { DrinkingWindowPredictor } from '../../src/infrastructure/ml/drinking-window-predictor.js';
import {
  inferDrinkingWindowBlockingEligibility,
  inferDrinkingWindowEvidenceLevel,
} from '../../src/application/search/drinking-window-confidence.js';

describe('heuristic drinking-window removal', () => {
  it('predictor throws when ONNX is not loaded (no heuristic fallback)', async () => {
    const predictor = new DrinkingWindowPredictor();

    await expect(
      predictor.predict({
        vintage: 2020,
        grapePrimaryEnc: 1,
        regionEnc: 2,
        countryEnc: 3,
        tannin: 3,
        acidity: 3,
        avgCriticProxyScore: 90,
      }),
    ).rejects.toThrow(/ONNX models not loaded/);
  });

  it('predictor initial modelVersion is "unloaded", not heuristic', () => {
    const predictor = new DrinkingWindowPredictor();

    expect(predictor.modelVersion).toBe('unloaded');
    expect(predictor.modelVersion).not.toMatch(/heuristic/);
  });

  it('inferDrinkingWindowEvidenceLevel returns undefined for heuristic modelVersion', () => {
    expect(inferDrinkingWindowEvidenceLevel('heuristic-v1.0-enc20260405')).toBeUndefined();
  });

  it('inferDrinkingWindowEvidenceLevel returns undefined for missing/empty/unloaded', () => {
    expect(inferDrinkingWindowEvidenceLevel(undefined)).toBeUndefined();
    expect(inferDrinkingWindowEvidenceLevel('')).toBeUndefined();
    expect(inferDrinkingWindowEvidenceLevel('unloaded')).toBeUndefined();
  });

  it('inferDrinkingWindowEvidenceLevel returns learned only for onnx: prefix', () => {
    expect(inferDrinkingWindowEvidenceLevel('onnx:v2.1-enc20260405')).toBe('learned');
  });

  it('inferDrinkingWindowBlockingEligibility is false for non-ONNX versions', () => {
    expect(inferDrinkingWindowBlockingEligibility('heuristic-v1.0')).toBe(false);
    expect(inferDrinkingWindowBlockingEligibility(undefined)).toBe(false);
    expect(inferDrinkingWindowBlockingEligibility('unloaded')).toBe(false);
  });
});
