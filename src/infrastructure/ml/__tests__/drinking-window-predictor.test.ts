import { DrinkingWindowPredictor } from '../drinking-window-predictor.js';

describe('DrinkingWindowPredictor', () => {
  const input = {
    vintage: 2015,
    grapePrimaryEnc: 42,
    regionEnc: 10,
    countryEnc: 1,
    body: 4,
    tannin: 4,
    acidity: 3,
    sweetness: 1,
    avgCriticProxyScore: 95,
  } as const;

  it('predicts safely without a prior load()', async () => {
    const predictor = new DrinkingWindowPredictor();

    const prediction = await predictor.predict(input);

    expect(prediction.drinkingWindowStart).toBeGreaterThanOrEqual(2015);
    expect(prediction.drinkingWindowEnd).toBeGreaterThan(
      prediction.drinkingWindowStart,
    );
    // High critic score + structured tannin/acidity → heuristic upgrades to medium (see predictor).
    expect(prediction.confidence).toBe('medium');
    expect(prediction.modelVersion).toContain('heuristic');
  });

  it('keeps the heuristic fallback contract even after load()', async () => {
    const predictor = new DrinkingWindowPredictor();

    await expect(predictor.load('/tmp/onnx-models')).rejects.toBeDefined();
    expect(predictor.modelVersion).toContain('heuristic');
  });

  it('throws when heuristic is disabled and ONNX is not loaded', async () => {
    const predictor = new DrinkingWindowPredictor({ allowHeuristicFallback: false });

    await expect(predictor.predict(input)).rejects.toThrow(/ONNX required/);
  });

  // E4-T7: RCA5-05 — drinkingWindowStart must never exceed drinkingWindowEnd
  it('always returns drinkingWindowStart <= drinkingWindowEnd (invariant)', async () => {
    const predictor = new DrinkingWindowPredictor();

    // Minimal structure wine: all bonuses near zero → shortest window (still >= MIN)
    const minimalInput = {
      vintage: 2022,
      grapePrimaryEnc: 0,
      regionEnc: 0,
      countryEnc: 0,
      body: 1,        // minimum body
      tannin: 1,      // minimum tannin
      acidity: 1,     // minimum acidity
      sweetness: 1,
      avgCriticProxyScore: 0, // no critic score
    };
    const prediction = await predictor.predict(minimalInput);
    expect(prediction.drinkingWindowStart).toBeLessThanOrEqual(prediction.drinkingWindowEnd);
    expect(prediction.drinkingWindowEnd).toBeGreaterThan(prediction.drinkingWindowStart);
  });

  it('returns safeStart <= safeEnd even for a recent vintage with no structure', async () => {
    const predictor = new DrinkingWindowPredictor();
    // RCA5-05 scenario: very recent vintage, minimal bonuses
    const recentInput = {
      vintage: 2024,
      grapePrimaryEnc: 0,
      regionEnc: 0,
      countryEnc: 0,
      body: 1,
      tannin: 1,
      acidity: 1,
      sweetness: 1,
      avgCriticProxyScore: 0,
    };
    const result = await predictor.predict(recentInput);
    // Invariant: end > start — no inversion, no exception
    expect(result.drinkingWindowEnd).toBeGreaterThan(result.drinkingWindowStart);
  });
});
