import type { DrinkingWindowBlock, ResultItem } from '../../domain/response/model/result-item.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import {
  DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE,
  type DrinkingWindowUseCasePort,
} from '../drinking-window/port/drinking-window-usecase.port.js';
import { DRINKING_WINDOW_SENSORY_ORDINAL_SCALE } from '../../domain/drinking-window/port/drinking-window-predictor.port.js';
import {
  inferDrinkingWindowBlockingEligibility,
  inferDrinkingWindowConfidence,
  inferDrinkingWindowEvidenceLevel,
} from './drinking-window-confidence.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';
import type { EvidenceItem } from '../../domain/shared/types/index.js';
import type { MatchDetail } from '../../domain/response/model/result-item.js';

const drinkingWindowLogger = bootstrapLogger.child({
  component: 'search-result-drinking-window',
});

const DRINKING_WINDOW_CHECK_TIMEOUT_MS = 2_000;

const EXACT_MATCH_TYPES = new Set<MatchDetail['matchType']>(['exact', 'alias_exact', 'alias_fuzzy']);

function findIdentityEvidence(
  evidenceItems: readonly EvidenceItem[],
): EvidenceItem | undefined {
  return evidenceItems.find((item) => item.type === 'identity');
}

function readIdentityMatchType(
  evidence: EvidenceItem | undefined,
): MatchDetail['matchType'] | undefined {
  const candidate = evidence?.metadata?.matchType;
  if (typeof candidate !== 'string') {
    return undefined;
  }
  return EXACT_MATCH_TYPES.has(candidate as MatchDetail['matchType'])
    ? candidate as MatchDetail['matchType']
    : undefined;
}

function readMatchedAlias(
  evidence: EvidenceItem | undefined,
): string | undefined {
  const matchedAlias = evidence?.metadata?.matchedAlias;
  return typeof matchedAlias === 'string' && matchedAlias.length > 0
    ? matchedAlias
    : undefined;
}

function deriveMatchType(
  result: RankedResult,
): MatchDetail['matchType'] {
  const identityEvidence = findIdentityEvidence(result.evidenceItems);
  const identityMatchType = readIdentityMatchType(identityEvidence);
  if (identityMatchType !== undefined) {
    return identityMatchType;
  }

  const protectedReason = result.retrievalProvenance?.protectedInclusionReason;
  if (protectedReason === 'exact_alias_match' || protectedReason === 'known_item_lookup') {
    return 'alias_exact';
  }

  const channels = new Set(result.retrievalProvenance?.channels ?? []);
  const hasLexicalChannel = channels.has('sparse_bm25') || channels.has('learned_sparse');
  const hasSemanticChannel = channels.has('dense_semantic');

  if (hasSemanticChannel && !hasLexicalChannel) {
    return 'semantic';
  }

  if (hasLexicalChannel && !hasSemanticChannel) {
    return 'alias_fuzzy';
  }

  return 'hybrid';
}

function deriveLexicalScore(
  result: RankedResult,
): number {
  const lexicalContribution = result.scoreDecomposition?.lexicalContribution;
  if (typeof lexicalContribution === 'number' && Number.isFinite(lexicalContribution)) {
    return clamp01(lexicalContribution);
  }

  const identityEvidence = findIdentityEvidence(result.evidenceItems);
  const aliasScore = identityEvidence?.metadata?.aliasScore;
  if (typeof aliasScore === 'number' && Number.isFinite(aliasScore)) {
    return clamp01(aliasScore);
  }

  const protectedReason = result.retrievalProvenance?.protectedInclusionReason;
  if (protectedReason === 'exact_alias_match' || protectedReason === 'known_item_lookup') {
    return 1;
  }

  return 0;
}

/**
 * T-E6-03: Route-aware score projection matrix.
 *
 * Entity route results bypass the heuristic ranker — their componentScores
 * are synthetic (entityIntegrity=1, semantic=calibratedScore, others=0).
 * Projecting those directly into the API's scoreComponents would be
 * misleading: the "semantic" field would carry the resolver's calibrated
 * posterior (e.g. 0.97) rather than an actual embedding similarity score.
 *
 * When a result originated from the entity route (detected via identity
 * evidence from entity_resolver source AND scoreDecomposition present),
 * we project scores from the entity-native decomposition instead:
 *
 *   Route   | lexical           | semantic              | attribute | popularity | preferenceAlignment
 *   --------|-------------------|-----------------------|-----------|------------|--------------------
 *   entity  | decomp.lexical    | decomp.semantic (=cal)| 0         | 0          | 0
 *   hybrid  | deriveLexicalScore| components.semantic   | comp.attr | comp.pop   | comp.pref
 *
 * This ensures that API consumers see provenance-consistent scores:
 * entity-route results expose resolver-calibrated signals, hybrid-route
 * results expose retrieval + ranking pipeline signals.
 */
function isEntityRouteResult(result: RankedResult): boolean {
  const identityEvidence = findIdentityEvidence(result.evidenceItems);
  return identityEvidence?.source === 'entity_resolver'
    && result.scoreDecomposition !== undefined;
}

function deriveScoreComponents(
  result: RankedResult,
): {
  readonly lexical: number;
  readonly semantic: number;
  readonly attribute: number;
  readonly popularity: number;
  readonly preferenceAlignment?: number | undefined;
} {
  if (isEntityRouteResult(result)) {
    // Entity route: project from entity-native ScoreDecomposition.
    // The decomposition's semanticContribution IS the calibratedScore —
    // this is correct and intentional for entity route provenance.
    const decomp = result.scoreDecomposition!;
    return {
      lexical: clamp01(decomp.lexicalContribution),
      semantic: clamp01(decomp.semanticContribution),
      attribute: clamp01(decomp.attributeSatisfaction),
      popularity: clamp01(decomp.popularityContribution),
      ...(decomp.preferenceAlignmentContribution !== 0
        ? { preferenceAlignment: clamp01(decomp.preferenceAlignmentContribution) }
        : {}),
    };
  }

  // Hybrid route: project from ranking pipeline componentScores.
  return {
    lexical: deriveLexicalScore(result),
    semantic: result.componentScores.semantic ?? 0,
    attribute: result.componentScores.attributeAlignment ?? 0,
    popularity: result.componentScores.popularity ?? 0,
    ...(result.componentScores.preferenceAlignment !== undefined
      ? { preferenceAlignment: result.componentScores.preferenceAlignment }
      : {}),
  };
}

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

export interface ResultItemMappingOptions {
  readonly maxPredictions?: number | undefined;
}

function needsDrinkingWindowPrediction(r: RankedResult, priors?: QueryLevelSensoryPriors): boolean {
  if (r.drinkingWindowStart !== undefined) return false;
  // Rule 28: vintageYear=undefined is guarded above, but a NaN vintage from a
  // corrupted index row would pass the undefined check and propagate into arithmetic.
  if (r.vintageYear === undefined || !Number.isFinite(r.vintageYear)) return false;
  if (r.grapePrimaryEnc === undefined) return false;
  if (r.regionEnc === undefined) return false;
  if (r.countryEnc === undefined) return false;

  // Sensory gate: tannin+acidity are REQUIRED by DrinkingWindowInput (non-optional).
  // body/sweetness are OPTIONAL in the port — the predictor falls back to its own
  // structural midpoints (HEURISTIC_STRUCTURE_CENTER=2, HEURISTIC_SWEETNESS_STRUCTURAL_MID=3)
  // when absent. Requiring all four here would silently block predictions for wines
  // that only have tannin+acidity data, which is common for older index documents.
  const hasTannin = r.tannin !== undefined || priors?.tannin !== undefined;
  const hasAcidity = r.acidity !== undefined || priors?.acidity !== undefined;

  return hasTannin && hasAcidity;
}

function buildDrinkingWindowCheckInput(
  r: RankedResult,
  priors: QueryLevelSensoryPriors | undefined,
  targetYear: number,
): {
  readonly request: Parameters<DrinkingWindowUseCasePort['check']>[0];
  readonly missingInfo: readonly string[];
  readonly approximationUsed: boolean;
} {
  const body = r.body ?? priors?.body;
  const tannin = r.tannin ?? priors?.tannin;
  const acidity = r.acidity ?? priors?.acidity;
  const sweetness = r.sweetness ?? priors?.sweetness;
  if (tannin === undefined || acidity === undefined) {
    throw new Error(
      `buildDrinkingWindowCheckInput: required sensory inputs missing for entity ${String(r.entityId)}`,
    );
  }

  const missingInfo = [
    ...(r.body === undefined ? ['body'] : []),
    ...(r.sweetness === undefined ? ['sweetness'] : []),
  ];

  return {
    request: {
      vintage: r.vintageYear!,
      grapePrimaryEnc: r.grapePrimaryEnc!,
      regionEnc: r.regionEnc!,
      countryEnc: r.countryEnc!,
      ...(body !== undefined ? { body: body * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE } : {}),
      tannin: tannin * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE,
      acidity: acidity * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE,
      ...(sweetness !== undefined ? { sweetness: sweetness * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE } : {}),
      avgCriticProxyScore: r.avgCriticProxyScore ?? DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE,
      targetYear,
    },
    missingInfo,
    approximationUsed:
      missingInfo.length > 0
      || body !== r.body
      || tannin !== r.tannin
      || acidity !== r.acidity
      || sweetness !== r.sweetness,
  };
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
  options?: ResultItemMappingOptions,
): Promise<readonly ResultItem[]> {
  if (!Number.isFinite(targetYear)) {
    throw new Error(
      `mapRankedResultsToResultItems: targetYear must be a finite number, got ${String(targetYear)}`,
    );
  }
  const maxPredictions = options?.maxPredictions;
  const predictionCandidates = rankedResults.filter(
    (r) => drinkingWindow !== undefined && needsDrinkingWindowPrediction(r, sensoryPriors),
  );
  const resultsPendingPrediction =
    maxPredictions !== undefined
      ? predictionCandidates.slice(0, Math.max(0, maxPredictions))
      : predictionCandidates;
  const drinkingWindowMissingInfo = new Map<string, readonly string[]>();
  const drinkingWindowApproximationUsed = new Map<string, boolean>();

  const predictions = await Promise.allSettled(
    resultsPendingPrediction.map((r) => {
      const request = buildDrinkingWindowCheckInput(r, sensoryPriors, targetYear);
      drinkingWindowMissingInfo.set(r.entityId, request.missingInfo);
      drinkingWindowApproximationUsed.set(r.entityId, request.approximationUsed);
      return withDrinkingWindowTimeout(drinkingWindow!.check(request.request));
    }),
  );

  const predictionMap = new Map<string, DrinkingWindowBlock>();
  resultsPendingPrediction.forEach((r, idx) => {
    const settled = predictions[idx];
    if (settled?.status === 'fulfilled') {
      predictionMap.set(r.entityId, settled.value);
      return;
    }
    if (settled?.status === 'rejected') {
      drinkingWindowApproximationUsed.set(r.entityId, true);
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

    if (r.drinkingWindowStart !== undefined && r.drinkingWindowEnd !== undefined
        && r.drinkingWindowStart <= r.drinkingWindowEnd) {
      // Guard: inverted windows (start > end) from ETL bugs or Track-C backfill errors
      // would fail the Zod response schema refine → HTTP 500. Omit the block instead.
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

    const matchType = deriveMatchType(r);
    const identityEvidence = findIdentityEvidence(r.evidenceItems);
    const matchedAlias = readMatchedAlias(identityEvidence);
    const missingInfo = drinkingWindowMissingInfo.get(r.entityId) ?? [];
    const approximationUsed = drinkingWindowApproximationUsed.get(r.entityId) ?? false;
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
        ...(r.wineType !== undefined ? { wineType: r.wineType } : {}),
        ...(r.classification !== undefined ? { classification: r.classification } : {}),
        ...(r.criticScoreNormalized !== undefined ? { criticScore: r.criticScoreNormalized } : {}),
        ...(r.alcoholPct !== undefined ? { alcoholPct: r.alcoholPct } : {}),
        ...(r.certifications !== undefined ? { certifications: r.certifications } : {}),
        ...(r.pairingTags !== undefined ? { pairingTags: r.pairingTags } : {}),
        ...(r.occasion !== undefined ? { occasion: r.occasion } : {}),
        ...(r.sourceRecordRefs !== undefined && r.sourceRecordRefs.length > 0
          ? { sourceRecordRefs: r.sourceRecordRefs }
          : {}),
        ...(r.body !== undefined ? { body: r.body } : {}),
        ...(r.tannin !== undefined ? { tannin: r.tannin } : {}),
        ...(r.acidity !== undefined ? { acidity: r.acidity } : {}),
        ...(r.sweetness !== undefined ? { sweetness: r.sweetness } : {}),
      },
      relevanceScore: r.finalScore,
      match: {
        matchType,
        ...(matchedAlias !== undefined ? { matchedAlias } : {}),
        // T-E6-03: Route-aware score projection — see deriveScoreComponents() doc.
        scoreComponents: deriveScoreComponents(r),
      },
      constraints: {
        matched: matchedConstraints,
        unmet: unmetConstraints,
        inferred: inferredConstraints,
      },
      uncertainty: {
        // T-E6-01: NaN/invalid uncertaintyPenalty → omit field entirely.
        // Previously masked with 0.5 neutral midpoint, hiding the real state.
        ...(Number.isFinite(r.componentScores.uncertaintyPenalty)
          ? { uncertaintyConfidence: clamp01(1 - r.componentScores.uncertaintyPenalty) }
          : {}),
        missingInfo,
        approximationUsed,
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
