import { describe, it, expect } from 'vitest';
import {
  assertDrinkingWindowBackfillComplete,
  backfillDrinkingWindowRecords,
  predictDrinkingWindow,
  extractFeatures,
  assertHeuristicBackfillAllowed,
} from '../../../scripts/etl/drinking-window-backfill.js';

describe('predictDrinkingWindow', () => {
  const baseInput = {
    vintage: 2020,
    body: 0.5,
    tannin: 0.5,
    acidity: 0.5,
    sweetness: 0.3,
    avgCriticProxyScore: 85,
  };

  // 1. High tannin + high critic score → 'high' confidence
  it('returns high confidence when criticScore >= 90 AND tannin >= 0.6', () => {
    const result = predictDrinkingWindow({
      ...baseInput,
      tannin: 0.7,
      acidity: 0.3,
      avgCriticProxyScore: 92,
    });
    expect(result.confidence).toBe('high');
  });

  // high confidence also triggers via high acidity path
  it('returns high confidence when criticScore >= 90 AND acidity >= 0.8', () => {
    const result = predictDrinkingWindow({
      ...baseInput,
      tannin: 0.2,
      acidity: 0.85,
      avgCriticProxyScore: 95,
    });
    expect(result.confidence).toBe('high');
  });

  // 2. Low critic score → 'low' confidence
  it('returns low confidence when criticScore < 75', () => {
    const result = predictDrinkingWindow({
      ...baseInput,
      avgCriticProxyScore: 70,
    });
    expect(result.confidence).toBe('low');
  });

  // 3. Low tannin + low body → 'low' confidence
  it('returns low confidence when tannin < 0.3 AND body < 0.4', () => {
    const result = predictDrinkingWindow({
      ...baseInput,
      tannin: 0.2,
      body: 0.3,
      avgCriticProxyScore: 85, // above 75 so only the tannin+body branch triggers
    });
    expect(result.confidence).toBe('low');
  });

  // 4. Medium case → 'medium' confidence (default)
  it('returns medium confidence for moderate inputs', () => {
    const result = predictDrinkingWindow(baseInput);
    expect(result.confidence).toBe('medium');
  });

  // 5. Start <= End invariant
  it('ensures drinkingWindowStart <= drinkingWindowEnd', () => {
    const cases = [
      baseInput,
      { ...baseInput, tannin: 0, acidity: 0, body: 0, avgCriticProxyScore: 0 },
      { ...baseInput, tannin: 1, acidity: 1, body: 1, avgCriticProxyScore: 100 },
      { ...baseInput, tannin: 0.1, body: 0.9, avgCriticProxyScore: 10 },
    ];
    for (const input of cases) {
      const result = predictDrinkingWindow(input);
      expect(result.drinkingWindowStart).toBeLessThanOrEqual(
        result.drinkingWindowEnd,
      );
    }
  });

  // 6. Minimum gap: endOffset >= startOffset + 5 → minimum 5 year gap
  it('guarantees at least a 5-year gap between start and end', () => {
    const result = predictDrinkingWindow({
      ...baseInput,
      tannin: 0,
      acidity: 0,
      body: 0,
      sweetness: 0,
      avgCriticProxyScore: 0,
    });
    expect(result.drinkingWindowEnd - result.drinkingWindowStart).toBeGreaterThanOrEqual(5);
  });

  // 7. startOffset clamp [0, 15]: all-zero inputs → startOffset = 0 → start = vintage
  it('clamps startOffset to 0 for all-zero inputs (start = vintage)', () => {
    const result = predictDrinkingWindow({
      vintage: 2020,
      body: 0,
      tannin: 0,
      acidity: 0,
      sweetness: 0,
      avgCriticProxyScore: 0,
    });
    expect(result.drinkingWindowStart).toBe(2020);
  });

  // 8. endOffset clamp: extreme inputs → capped at reasonable range
  it('caps endOffset at 50 for extreme inputs', () => {
    const result = predictDrinkingWindow({
      vintage: 2000,
      body: 0,
      tannin: 1,
      acidity: 1,
      sweetness: 1,
      avgCriticProxyScore: 100,
    });
    // startOffset clamp is [0, 15], endOffset clamp is [startOffset+5, 50]
    // So drinkingWindowEnd <= vintage + 50
    expect(result.drinkingWindowEnd).toBeLessThanOrEqual(2000 + 50);
  });

  // 9. peakYear between start and end (midpoint)
  it('sets peakYear as the midpoint between start and end', () => {
    const result = predictDrinkingWindow(baseInput);
    expect(result.peakYear).toBeGreaterThanOrEqual(result.drinkingWindowStart);
    expect(result.peakYear).toBeLessThanOrEqual(result.drinkingWindowEnd);

    // Verify it is actually the midpoint
    const expectedPeak = Math.round(
      (result.drinkingWindowStart + result.drinkingWindowEnd) / 2,
    );
    expect(result.peakYear).toBe(expectedPeak);
  });

  // 10. Model version
  it('returns model version v1.0-heuristic-20260405', () => {
    const result = predictDrinkingWindow(baseInput);
    expect(result.modelVersion).toBe('v1.0-heuristic-20260405');
  });

  // 11. Vintage passthrough
  it('produces start/end years relative to the given vintage', () => {
    const result2020 = predictDrinkingWindow({ ...baseInput, vintage: 2020 });
    const result2010 = predictDrinkingWindow({ ...baseInput, vintage: 2010 });

    // Same offsets, different vintage → difference should be exactly 10
    expect(result2020.drinkingWindowStart - result2010.drinkingWindowStart).toBe(10);
    expect(result2020.drinkingWindowEnd - result2010.drinkingWindowEnd).toBe(10);
    expect(result2020.peakYear - result2010.peakYear).toBe(10);
  });

  // 12. Negative criticScore → guarded by Math.max(0, ...)
  it('treats negative criticScore as 0 via Math.max guard', () => {
    const resultNegative = predictDrinkingWindow({
      ...baseInput,
      avgCriticProxyScore: -50,
    });
    const resultZero = predictDrinkingWindow({
      ...baseInput,
      avgCriticProxyScore: 0,
    });
    expect(resultNegative.drinkingWindowStart).toBe(resultZero.drinkingWindowStart);
    expect(resultNegative.drinkingWindowEnd).toBe(resultZero.drinkingWindowEnd);
    expect(resultNegative.peakYear).toBe(resultZero.peakYear);
  });
});

describe('extractFeatures', () => {
  const validRecord = {
    sourceId: 'wine-123',
    vintageYear: 2020,
    body: 0.6,
    tannin: 0.5,
    acidity: 0.4,
    sweetness: 0.2,
    criticProxy: { proxyScore: 88 },
  };

  // 13. Valid record → returns DrinkingWindowInput
  it('returns DrinkingWindowInput when all fields are present', () => {
    const result = extractFeatures(validRecord);
    expect(result).toEqual({
      vintage: 2020,
      body: 0.6,
      tannin: 0.5,
      acidity: 0.4,
      sweetness: 0.2,
      avgCriticProxyScore: 88,
    });
  });

  // 14. Missing vintageYear → null
  it('returns null when vintageYear is missing', () => {
    const { vintageYear: _vintageYear, ...rest } = validRecord;
    expect(extractFeatures(rest)).toBeNull();
  });

  // 15. Missing body → null
  it('returns null when body is missing', () => {
    const { body: _body, ...rest } = validRecord;
    expect(extractFeatures(rest)).toBeNull();
  });

  // Also verify other required fields
  it('returns null when tannin is missing', () => {
    const { tannin: _tannin, ...rest } = validRecord;
    expect(extractFeatures(rest)).toBeNull();
  });

  it('returns null when acidity is missing', () => {
    const { acidity: _acidity, ...rest } = validRecord;
    expect(extractFeatures(rest)).toBeNull();
  });

  it('returns null when sweetness is missing', () => {
    const { sweetness: _sweetness, ...rest } = validRecord;
    expect(extractFeatures(rest)).toBeNull();
  });

  // 16. Missing criticProxy → avgCriticProxyScore defaults to 0
  it('defaults avgCriticProxyScore to 0 when criticProxy is missing', () => {
    const { criticProxy: _criticProxy, ...rest } = validRecord;
    const result = extractFeatures(rest);
    expect(result).not.toBeNull();
    expect(result!.avgCriticProxyScore).toBe(0);
  });

  it('defaults avgCriticProxyScore to 0 when proxyScore is missing', () => {
    const record = { ...validRecord, criticProxy: {} };
    const result = extractFeatures(record);
    expect(result).not.toBeNull();
    expect(result!.avgCriticProxyScore).toBe(0);
  });

  // 17. Zero vintageYear (falsy) → returns null
  it('returns null when vintageYear is 0 (falsy)', () => {
    const record = { ...validRecord, vintageYear: 0 };
    expect(extractFeatures(record)).toBeNull();
  });

  it('returns null when vintageYear is null', () => {
    const record = { ...validRecord, vintageYear: null };
    expect(extractFeatures(record)).toBeNull();
  });
});

describe('heuristic backfill guard', () => {
  it('refuses to run without an explicit opt-in', () => {
    expect(() => assertHeuristicBackfillAllowed({} as NodeJS.ProcessEnv)).toThrow(
      /ALLOW_HEURISTIC_DRINKING_WINDOW_BACKFILL=1/,
    );
  });

  it('allows explicit opt-in only', () => {
    expect(
      assertHeuristicBackfillAllowed({
        ALLOW_HEURISTIC_DRINKING_WINDOW_BACKFILL: '1',
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});

describe('backfill output guard', () => {
  it('refuses to write partial outputs when any record lacks required features', () => {
    const result = backfillDrinkingWindowRecords([
      {
        sourceId: 'wine-1',
        vintageYear: 2020,
        body: 0.6,
        tannin: 0.5,
        acidity: 0.4,
        sweetness: 0.2,
        criticProxy: { proxyScore: 88 },
      },
      {
        sourceId: 'wine-2',
        vintageYear: 2020,
        body: null,
        tannin: 0.5,
        acidity: 0.4,
        sweetness: 0.2,
        criticProxy: { proxyScore: 88 },
      },
    ]);

    expect(result.failed).toBe(1);
    expect(() => assertDrinkingWindowBackfillComplete(result)).toThrow(
      /refused to write partial output/,
    );
  });
});
