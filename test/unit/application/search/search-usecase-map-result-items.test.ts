import { describe, expect, it, vi } from 'vitest';
import { mapRankedResultsToResultItems } from '../../../../src/application/search/search-usecase-map-result-items.js';
import type { RankedResult } from '../../../../src/domain/ranking/model/ranked-result.js';

function makeRankedResult(): RankedResult {
  return {
    entityId: 'wine-1',
    canonicalLabel: 'Opus One 2018',
    finalScore: 0.92,
    rank: 1,
    producer: 'Opus One',
    region: 'Napa Valley',
    grapePrimary: 'Cabernet Sauvignon',
    vintageYear: 2018,
    grapePrimaryEnc: 1,
    regionEnc: 2,
    countryEnc: 3,
    body: 4,
    tannin: 4,
    acidity: 3,
    sweetness: 1,
    avgCriticProxyScore: 96,
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    evidenceItems: [],
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.8,
      hardConstraintPass: true,
      softConstraint: 0.2,
      attributeAlignment: 0.7,
      preferenceAlignment: 0.5,
      popularity: 0.4,
      availability: 1,
      uncertaintyPenalty: 0.1,
    },
  } as RankedResult;
}

describe('mapRankedResultsToResultItems', () => {
  it('clears drinking-window timeout timers after a successful fast prediction', async () => {
    vi.useFakeTimers();
    const drinkingWindow = {
      check: vi.fn().mockResolvedValue({
        drinkingWindowStart: 2026,
        drinkingWindowEnd: 2032,
        currentlyDrinkable: false,
        confidence: 'high',
        evidenceLevel: 'model_based',
        blockingEligible: true,
      }),
    };

    const pending = mapRankedResultsToResultItems([makeRankedResult()], drinkingWindow as never, 2025);
    await vi.runAllTimersAsync();
    const items = await pending;

    expect(drinkingWindow.check).toHaveBeenCalledOnce();
    expect(items[0]?.drinkingWindow).toEqual({
      drinkingWindowStart: 2026,
      drinkingWindowEnd: 2032,
      currentlyDrinkable: false,
      confidence: 'high',
      evidenceLevel: 'model_based',
      blockingEligible: true,
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
