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
import { clamp01 } from '../../domain/shared/utils/clamp.js';

const drinkingWindowLogger = bootstrapLogger.child({
  component: 'search-result-drinking-window',
});

const DRINKING_WINDOW_CHECK_TIMEOUT_MS = 2_000;

/** Neutral confidence when uncertaintyPenalty is NaN/unavailable.
 *  0.5 = "no opinion" in [0,1] confidence space. */
const UNCERTAINTY_CONFIDENCE_NEUTRAL = 0.5;

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

/**
 * RFC-019 Phase 7: Sensory priors injected from planner's compositional
 * inference. These are query-level fallbacks for wines missing indexed sensory
 * attributes — e.g. a "Barolo" query derives `tannin≥0.65` even for wines
 * whose Vespa document lacks the `tannin` field.
 */
export interface QueryLevelSensoryPriors {
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
}

function needsDrinkingWindowPrediction(r: RankedResult, priors?: QueryLevelSensoryPriors): boolean {
  if (r.drinkingWindowStart !== undefined) return false;
  if (r.vintageYear === undefined) return false;
  if (r.grapePrimaryEnc === undefined) return false;
  if (r.regionEnc === undefined) return false;
  if (r.countryEnc === undefined) return false;

  // Sensory fields: accept either indexed value OR query-level prior.
  // This widens predictor coverage: wines with sparse sensory data still get
  // predictions when the compositional inference provides a fallback.
  const hasBody = r.body !== undefined || priors?.body !== undefined;
  const hasTannin = r.tannin !== undefined || priors?.tannin !== undefined;
  const hasAcidity = r.acidity !== undefined || priors?.acidity !== undefined;
  const hasSweetness = r.sweetness !== undefined || priors?.sweetness !== undefined;

  return hasBody && hasTannin && hasAcidity && hasSweetness;
}

/**
 * Maps ranked rows to API {@link ResultItem}s; enriches drinking window from cache or predictor.
 *
 * RFC-019 Phase 7: Optional `sensoryPriors` parameter carries query-level
 * compositional inference defaults (e.g. "Barolo" → tannin≥0.65) that
 * substitute for missing indexed sensory values, widening predictor coverage.
 */
export async function mapRankedResultsToResultItems(
  rankedResults: readonly RankedResult[],
  drinkingWindow: DrinkingWindowUseCasePort | undefined,
  // targetYear is REQUIRED — no wall-clock fallback. A silent
  // `new Date().getFullYear()` default here was a replay-determinism leak:
  // identical queries with identical snapshots produced different
  // `currentlyDrinkable` flags across New Year boundaries, breaking the
  // RFC-009 §8 replay hash and the golden-set fidelity guarantee.
  // Callers MUST source `targetYear` from a deterministic seam
  // (request-start wall clock captured once, or an injected clock from the
  // replay harness). See search-usecase-post-route-phase.ts for the canonical
  // plumbing pattern.
  targetYear: number,
  sensoryPriors?: QueryLevelSensoryPriors,
): Promise<readonly ResultItem[]> {
  if (!Number.isFinite(targetYear)) {
    throw new Error(
      `mapRankedResultsToResultItems: targetYear must be a finite number, got ${String(targetYear)}`,
    );
  }
  const resultsPendingPrediction = rankedResults.filter(
    (r) => drinkingWindow !== undefined && needsDrinkingWindowPrediction(r, sensoryPriors),
  );

  const predictions = await Promise.allSettled(
    resultsPendingPrediction.map((r) =>
      withDrinkingWindowTimeout(
        drinkingWindow!.check({
          vintage: r.vintageYear!,
          grapePrimaryEnc: r.grapePrimaryEnc!,
          regionEnc: r.regionEnc!,
          countryEnc: r.countryEnc!,
          // Indexed sensory values take precedence; priors fill gaps.
          body: r.body ?? sensoryPriors?.body ?? UNCERTAINTY_CONFIDENCE_NEUTRAL,
          tannin: r.tannin ?? sensoryPriors?.tannin ?? UNCERTAINTY_CONFIDENCE_NEUTRAL,
          acidity: r.acidity ?? sensoryPriors?.acidity ?? UNCERTAINTY_CONFIDENCE_NEUTRAL,
          sweetness: r.sweetness ?? sensoryPriors?.sweetness ?? UNCERTAINTY_CONFIDENCE_NEUTRAL,
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
        ...(r.priceBand !== undefined || r.priceUsd !== undefined
          ? { priceRange: r.priceUsd !== undefined ? `$${r.priceUsd}` : r.priceBand }
          : {}),
        ...(r.style !== undefined ? { style: r.style } : {}),
        ...(r.classification !== undefined ? { classification: r.classification } : {}),
        ...(r.criticScoreNormalized !== undefined ? { criticScore: r.criticScoreNormalized } : {}),
        ...(r.alcoholPct !== undefined ? { alcoholPct: r.alcoholPct } : {}),
        ...(r.certifications !== undefined ? { certifications: r.certifications } : {}),
        ...(r.pairingTags !== undefined ? { pairingTags: r.pairingTags } : {}),
        ...(r.occasion !== undefined ? { occasion: r.occasion } : {}),
        ...(r.body !== undefined ? { body: r.body } : {}),
        ...(r.tannin !== undefined ? { tannin: r.tannin } : {}),
        ...(r.acidity !== undefined ? { acidity: r.acidity } : {}),
        ...(r.sweetness !== undefined ? { sweetness: r.sweetness } : {}),
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
        // NaN guard: if uncertaintyPenalty is NaN (upstream bug), 1 - NaN → NaN,
        // and Math.max/min do NOT filter NaN — they propagate it to the client.
        uncertaintyConfidence: Number.isFinite(r.componentScores.uncertaintyPenalty)
          ? clamp01(1 - r.componentScores.uncertaintyPenalty)
          : UNCERTAINTY_CONFIDENCE_NEUTRAL,
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
