import { describe, expect, it, vi } from 'vitest';
import { mapRankedResultsToResultItems } from '../../../../src/application/search/search-usecase-map-result-items.js';
import type { RankedResult } from '../../../../src/domain/ranking/model/ranked-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

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

  it('projects entity-route identity provenance into exact match metadata', async () => {
    const items = await mapRankedResultsToResultItems([
      {
        ...makeRankedResult(),
        entityId: createEntityId('wine-kalaris'),
        evidenceItems: [{
          type: 'identity',
          source: 'entity_resolver',
          contribution: '+0.97',
          strength: 'high',
          provenance: 'Entity resolved via alias match',
          metadata: {
            matchType: 'alias_exact',
            matchedAlias: 'Kalaris Merlot',
            aliasScore: 0.97,
          },
        }],
      },
    ], undefined, 2025);

    expect(items[0]?.match.matchType).toBe('alias_exact');
    expect(items[0]?.match.matchedAlias).toBe('Kalaris Merlot');
    expect(items[0]?.match.scoreComponents.lexical).toBeCloseTo(0.97);
  });

  it('projects hybrid lexical provenance from score decomposition instead of forcing zero', async () => {
    const items = await mapRankedResultsToResultItems([
      {
        ...makeRankedResult(),
        retrievalProvenance: {
          channels: ['sparse_bm25', 'dense_semantic'],
          channelScores: [],
          queryViewMatches: [],
          anchorConditioned: false,
          matchedFilterConstraints: [],
          fusionProfile: 'hybrid',
          fusionScore: 0.92,
        },
        scoreDecomposition: {
          lexicalContribution: 0.41,
          semanticContribution: 0.33,
          anchorContribution: 0,
          attributeSatisfaction: 0.12,
          popularityContribution: 0.08,
          preferenceAlignmentContribution: 0.06,
          heuristicScoreRaw: 0.92,
          heuristicScoreNormalized: 0.92,
          finalScore: 0.92,
        },
      },
    ], undefined, 2025);

    expect(items[0]?.match.matchType).toBe('hybrid');
    expect(items[0]?.match.scoreComponents.lexical).toBeCloseTo(0.41);
  });

  it('T-E6-01: NaN uncertaintyPenalty omits uncertaintyConfidence instead of masking to 0.5', async () => {
    const items = await mapRankedResultsToResultItems([
      {
        ...makeRankedResult(),
        componentScores: {
          ...makeRankedResult().componentScores,
          uncertaintyPenalty: NaN,
        },
      },
    ], undefined, 2025);

    // Must NOT contain the field at all — no 0.5 neutral masking
    expect(items[0]?.uncertainty).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(items[0]?.uncertainty, 'uncertaintyConfidence')).toBe(false);
    expect(items[0]?.uncertainty.uncertaintyConfidence).toBeUndefined();
  });

  it('T-E6-01: Infinity uncertaintyPenalty omits uncertaintyConfidence', async () => {
    const items = await mapRankedResultsToResultItems([
      {
        ...makeRankedResult(),
        componentScores: {
          ...makeRankedResult().componentScores,
          uncertaintyPenalty: Infinity,
        },
      },
    ], undefined, 2025);

    expect(Object.prototype.hasOwnProperty.call(items[0]?.uncertainty, 'uncertaintyConfidence')).toBe(false);
  });

  it('T-E6-01: valid uncertaintyPenalty still populates uncertaintyConfidence', async () => {
    const items = await mapRankedResultsToResultItems([
      {
        ...makeRankedResult(),
        componentScores: {
          ...makeRankedResult().componentScores,
          uncertaintyPenalty: 0.15,
        },
      },
    ], undefined, 2025);

    expect(items[0]?.uncertainty.uncertaintyConfidence).toBeCloseTo(0.85);
  });

  it('T-E6-01: zero uncertaintyPenalty yields confidence 1.0', async () => {
    const items = await mapRankedResultsToResultItems([
      {
        ...makeRankedResult(),
        componentScores: {
          ...makeRankedResult().componentScores,
          uncertaintyPenalty: 0,
        },
      },
    ], undefined, 2025);

    expect(items[0]?.uncertainty.uncertaintyConfidence).toBe(1);
  });

  it('omits missing sensory priors instead of injecting a 0.5 midpoint into predictor input', async () => {
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

    const pending = mapRankedResultsToResultItems([
      {
        ...makeRankedResult(),
        body: undefined,
        sweetness: undefined,
      },
    ], drinkingWindow as never, 2025);
    await vi.runAllTimersAsync();
    const items = await pending;

    const request = drinkingWindow.check.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(request, 'body')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(request, 'sweetness')).toBe(false);
    expect(items[0]?.uncertainty.missingInfo).toEqual(['body', 'sweetness']);
    expect(items[0]?.uncertainty.approximationUsed).toBe(true);
    vi.useRealTimers();
  });

  it('limits drinking-window predictions to top-N ranked results when maxPredictions is set', async () => {
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

    const ranked = [
      makeRankedResult(),
      { ...makeRankedResult(), entityId: 'wine-2', canonicalLabel: 'Wine 2' },
      { ...makeRankedResult(), entityId: 'wine-3', canonicalLabel: 'Wine 3' },
      { ...makeRankedResult(), entityId: 'wine-4', canonicalLabel: 'Wine 4' },
    ];

    const pending = mapRankedResultsToResultItems(
      ranked,
      drinkingWindow as never,
      2025,
      undefined,
      { maxPredictions: 3 },
    );
    await vi.runAllTimersAsync();
    const items = await pending;

    expect(drinkingWindow.check).toHaveBeenCalledTimes(3);
    expect(items).toHaveLength(4);
    expect(items[0]?.drinkingWindow).toBeDefined();
    expect(items[1]?.drinkingWindow).toBeDefined();
    expect(items[2]?.drinkingWindow).toBeDefined();
    expect(items[3]?.drinkingWindow).toBeUndefined();
    vi.useRealTimers();
  });
});
