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

  it('throws when ONNX models are not loaded', async () => {
    const predictor = new DrinkingWindowPredictor();

    await expect(predictor.predict(input)).rejects.toThrow(/ONNX models not loaded/);
  });

  it('reports unloaded model version before load', () => {
    const predictor = new DrinkingWindowPredictor();

    expect(predictor.modelVersion).toBe('unloaded');
  });

  it('rejects load with non-existent model directory', async () => {
    const predictor = new DrinkingWindowPredictor();

    await expect(predictor.load('/tmp/nonexistent-onnx-models')).rejects.toBeDefined();
    // Model version must remain unloaded after failed load
    expect(predictor.modelVersion).toBe('unloaded');
  });
});
