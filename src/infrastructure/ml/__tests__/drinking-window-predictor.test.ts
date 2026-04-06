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

  it('predicts safely without a prior load()', () => {
    const predictor = new DrinkingWindowPredictor();

    const prediction = predictor.predict(input);

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

  it('throws when heuristic is disabled and ONNX is not loaded', () => {
    const predictor = new DrinkingWindowPredictor({ allowHeuristicFallback: false });

    expect(() => predictor.predict(input)).toThrow(/ONNX required/);
  });
});
