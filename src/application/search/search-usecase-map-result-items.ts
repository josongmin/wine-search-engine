import type { DrinkingWindowBlock, ResultItem } from '../../domain/response/model/result-item.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import { inferDrinkingWindowConfidence } from './drinking-window-confidence.js';

function needsDrinkingWindowPrediction(r: RankedResult): boolean {
  return (
    r.drinkingWindowStart === undefined &&
    r.vintage !== undefined &&
    r.body !== undefined &&
    r.tannin !== undefined &&
    r.acidity !== undefined &&
    r.sweetness !== undefined &&
    r.grapePrimaryEnc !== undefined &&
    r.regionEnc !== undefined &&
    r.countryEnc !== undefined
  );
}

/**
 * Maps ranked rows to API {@link ResultItem}s; enriches drinking window from cache or predictor.
 */
export async function mapRankedResultsToResultItems(
  rankedResults: readonly RankedResult[],
  drinkingWindow: DrinkingWindowUseCasePort | undefined,
  currentYear: number = new Date().getFullYear(),
): Promise<readonly ResultItem[]> {
  const resultsPendingPrediction = rankedResults.filter(
    (r) => drinkingWindow !== undefined && needsDrinkingWindowPrediction(r),
  );

  const predictions = await Promise.allSettled(
    resultsPendingPrediction.map((r) =>
      drinkingWindow!.check({
        vintage: r.vintage!,
        grapePrimaryEnc: r.grapePrimaryEnc!,
        regionEnc: r.regionEnc!,
        countryEnc: r.countryEnc!,
        body: r.body!,
        tannin: r.tannin!,
        acidity: r.acidity!,
        sweetness: r.sweetness!,
        avgCriticProxyScore: r.avgCriticProxyScore ?? 80,
      }),
    ),
  );

  const predictionMap = new Map<string, DrinkingWindowBlock>();
  resultsPendingPrediction.forEach((r, idx) => {
    const settled = predictions[idx];
    if (settled?.status === 'fulfilled') {
      predictionMap.set(r.entityId, settled.value);
    }
  });

  return rankedResults.map((r) => {
    const matchedConstraints = r.matchedConstraints ?? [];
    const unmetConstraints = r.unmetConstraints ?? [];
    const inferredConstraints = r.inferredConstraints ?? [];
    let drinkingWindowBlock: DrinkingWindowBlock | undefined;

    if (r.drinkingWindowStart !== undefined && r.drinkingWindowEnd !== undefined) {
      drinkingWindowBlock = {
        drinkingWindowStart: r.drinkingWindowStart,
        drinkingWindowEnd: r.drinkingWindowEnd,
        currentlyDrinkable:
          currentYear >= r.drinkingWindowStart && currentYear <= r.drinkingWindowEnd,
        confidence: inferDrinkingWindowConfidence(r.drinkingWindowModelVersion),
        ...(r.drinkingWindowModelVersion !== undefined
          ? { modelVersion: r.drinkingWindowModelVersion }
          : {}),
      };
    } else {
      const predicted = predictionMap.get(r.entityId);
      if (predicted) {
        drinkingWindowBlock = predicted;
      }
    }

    const baseItem: ResultItem = {
      entity: {
        entityId: r.entityId,
        canonicalLabel: r.canonicalLabel,
        type: 'wine',
        ...(r.producer !== undefined ? { producer: r.producer } : {}),
        ...(r.region !== undefined ? { region: r.region } : {}),
        ...(r.appellation !== undefined ? { appellation: r.appellation } : {}),
        ...(r.grapePrimary !== undefined ? { grapes: [r.grapePrimary] } : {}),
        ...(r.vintage !== undefined ? { vintage: r.vintage } : {}),
        ...(r.producerPrestige !== undefined ? { producerPrestige: r.producerPrestige } : {}),
      },
      relevanceScore: r.finalScore,
      match: {
        matchType: 'hybrid' as const,
        scoreComponents: {
          lexical: 0,
          semantic: r.componentScores.semantic,
          attribute: r.componentScores.attributeAlignment,
          popularity: r.componentScores.popularity,
          preferenceAlignment: r.componentScores.preferenceAlignment,
        },
      },
      constraints: {
        matched: matchedConstraints,
        unmet: unmetConstraints,
        inferred: inferredConstraints,
      },
      uncertainty: {
        uncertaintyConfidence: 1 - r.componentScores.uncertaintyPenalty,
        missingInfo: [],
        approximationUsed: false,
      },
      evidenceItems: r.evidenceItems,
    };

    return {
      ...baseItem,
      ...(drinkingWindowBlock !== undefined ? { drinkingWindow: drinkingWindowBlock } : {}),
      ...(unmetConstraints.length > 0 ? { violatedConstraints: unmetConstraints } : {}),
    };
  });
}
