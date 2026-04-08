import type { DrinkingWindowBlock, ResultItem } from '../../domain/response/model/result-item.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import {
  DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE,
  type DrinkingWindowUseCasePort,
} from '../drinking-window/port/drinking-window-usecase.port.js';
import {
  inferDrinkingWindowBlockingEligibility,
  inferDrinkingWindowConfidence,
  inferDrinkingWindowEvidenceLevel,
} from './drinking-window-confidence.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const drinkingWindowLogger = bootstrapLogger.child({
  component: 'search-result-drinking-window',
});

const DRINKING_WINDOW_CHECK_TIMEOUT_MS = 2_000;

async function withDrinkingWindowTimeout(
  predictionPromise: Promise<DrinkingWindowBlock>,
): Promise<DrinkingWindowBlock> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      predictionPromise,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error('drinking_window_timeout'));
        }, DRINKING_WINDOW_CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function needsDrinkingWindowPrediction(r: RankedResult): boolean {
  return (
    r.drinkingWindowStart === undefined &&
    r.vintageYear !== undefined &&
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
  targetYear: number = new Date().getFullYear(),
): Promise<readonly ResultItem[]> {
  const resultsPendingPrediction = rankedResults.filter(
    (r) => drinkingWindow !== undefined && needsDrinkingWindowPrediction(r),
  );

  const predictions = await Promise.allSettled(
    resultsPendingPrediction.map((r) =>
      withDrinkingWindowTimeout(
        drinkingWindow!.check({
          vintage: r.vintageYear!,
          grapePrimaryEnc: r.grapePrimaryEnc!,
          regionEnc: r.regionEnc!,
          countryEnc: r.countryEnc!,
          body: r.body!,
          tannin: r.tannin!,
          acidity: r.acidity!,
          sweetness: r.sweetness!,
          avgCriticProxyScore:
            r.avgCriticProxyScore ?? DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE,
          targetYear,
        }),
      ),
    ),
  );

  const predictionMap = new Map<string, DrinkingWindowBlock>();
  resultsPendingPrediction.forEach((r, idx) => {
    const settled = predictions[idx];
    if (settled?.status === 'fulfilled') {
      predictionMap.set(r.entityId, settled.value);
      return;
    }
    if (settled?.status === 'rejected') {
      drinkingWindowLogger.warn(
        {
          entityId: r.entityId,
          err: settled.reason,
        },
        'drinking_window_prediction_soft_failed',
      );
    }
  });

  return rankedResults.map((r) => {
    const matchedConstraints = r.matchedConstraints;
    const unmetConstraints = r.unmetConstraints;
    const inferredConstraints = r.inferredConstraints;
    let drinkingWindowBlock: DrinkingWindowBlock | undefined;

    if (r.drinkingWindowStart !== undefined && r.drinkingWindowEnd !== undefined) {
      drinkingWindowBlock = {
        drinkingWindowStart: r.drinkingWindowStart,
        drinkingWindowEnd: r.drinkingWindowEnd,
        currentlyDrinkable:
          targetYear >= r.drinkingWindowStart && targetYear <= r.drinkingWindowEnd,
        confidence: inferDrinkingWindowConfidence(r.drinkingWindowModelVersion),
        evidenceLevel: inferDrinkingWindowEvidenceLevel(r.drinkingWindowModelVersion),
        blockingEligible: inferDrinkingWindowBlockingEligibility(r.drinkingWindowModelVersion),
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
        ...(r.vintageYear !== undefined ? { vintage: r.vintageYear } : {}),
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
        uncertaintyConfidence: Math.max(0, Math.min(1, 1 - r.componentScores.uncertaintyPenalty)),
        missingInfo: [],
        approximationUsed: false,
      },
      evidenceItems: r.evidenceItems,
    };

    return {
      ...baseItem,
      ...(drinkingWindowBlock !== undefined ? { drinkingWindow: drinkingWindowBlock } : {}),
      // violatedConstraints is derived from constraints.unmet by ResponseBuilder.enrichResults()
      // — do not set it here to avoid duplicate/divergent sources.
    };
  });
}
