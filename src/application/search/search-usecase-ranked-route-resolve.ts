import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../domain/resolver/service/resolver.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';
import type { ExecutionRetrievalMode } from '../../domain/query/model/engine-execution-contract.js';

const NON_ENTITY_SYNTHETIC_CONFORMAL_SET_SIZE = 1;
const NON_ENTITY_SYNTHETIC_CONFIDENCE_TOP_K = 3;

function shouldBypassSyntheticResolveConformal(
  effectiveRetrievalMode: ExecutionRetrievalMode | undefined,
): boolean {
  switch (effectiveRetrievalMode) {
    case 'recommendation':
    case 'compare_candidates':
    case 'similar_items':
    case 'producer_browse':
    case 'region_browse':
      return true;
    default:
      return false;
  }
}

function computeNonEntityCandidateSetConfidence(
  rankedResults: readonly RankedResult[],
): number {
  const shortlistScores = rankedResults
    .slice(0, NON_ENTITY_SYNTHETIC_CONFIDENCE_TOP_K)
    .map((result) => clamp01(result.finalScore));

  if (shortlistScores.length === 0) {
    return 0;
  }

  // Multi-recommendation / browse answers succeed when the returned shortlist
  // contains at least one good option. Model that contract as the union
  // probability over the shortlist instead of reusing single-entity top-1
  // confidence semantics.
  const allMissProbability = shortlistScores.reduce(
    (product, score) => product * (1 - score),
    1,
  );

  return clamp01(1 - allMissProbability);
}

interface RankedRouteResolveOptions {
  readonly outcomeReasonCode: 'HYBRID_ROUTE' | 'MIXED_ROUTE';
  readonly topEntity?: EntityResolveResult['topEntity'];
  readonly effectiveRetrievalMode?: ExecutionRetrievalMode | undefined;
}

/**
 * Builds synthetic resolver output for ranked routes whose candidate ordering
 * already comes from retrieval/ranking rather than the entity resolver.
 */
export function buildRankedRouteResolveResult(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  options: RankedRouteResolveOptions,
): EntityResolveResult {
  const topResult = rankedResults[0];
  const top1Score = clamp01(rankedResults[0]?.finalScore ?? 0);
  const decisionConfidenceC = shouldBypassSyntheticResolveConformal(options.effectiveRetrievalMode)
    ? computeNonEntityCandidateSetConfidence(rankedResults)
    : top1Score;
  const top2Result = rankedResults[1];
  const top2Score = top2Result !== undefined
    ? clamp01(top2Result.finalScore)
    : undefined;
  const calibratedGap = top2Score !== undefined
    ? Math.max(0, top1Score - top2Score)
    : undefined;
  const topEntity = options.topEntity
    ?? (topResult !== undefined
      ? {
          entityId: topResult.entityId,
          canonicalLabel: topResult.canonicalLabel,
          calibratedScore: top1Score,
        }
      : undefined);
  const candidates = rankedResults.map((result, index) => ({
    entityId: result.entityId,
    canonicalLabel: result.canonicalLabel,
    calibratedScore: clamp01(result.finalScore),
    rank: index + 1,
    // Synthetic ranked-route resolve results do not carry resolver
    // identity refs. Decision-input assembly derives identity semantics
    // from ranked-route alignment instead of reusing ranking evidence.
    evidenceRefs: [],
  }));

  // E3-U6: Calibrator insertion point — when a future ranked-route calibrator
  // is wired, it must be applied HERE (after rankedResults are sorted, before
  // decisionTrace/confidence scores are emitted). This is the single authoritative
  // hook. Do NOT create a parallel decision layer or second insertion point.
  // Feature inputs: rankedResults[*].finalScore, top1Score, calibratedGap,
  // plan.queryClass — all available at this scope. No Ranker internal state needed.
  //
  // E5-U5: Calibrator Activation Prerequisites (checklist)
  // Before wiring a calibrator at this insertion point, ALL of the following
  // must be closed:
  //   ✓ E3-U5: Feature source contract (ranked-result.ts comment)
  //   ✓ E3-U6: Insertion point defined (this comment)
  //   ✓ E3-U7: No-copy rule documented (decision-engine.ts comment)
  //   ✓ E5-U1: Eval feature delta list locked (search-usecase-eval-provenance.ts)
  //   ✓ E5-U2: Eval export wiring map locked
  //   - E5-U6: Shadow-first path defined and passing before production cutover
  //   - E5-U7: Promotion acceptance gate criteria met
  // Do NOT activate (even behind a feature flag) until ALL items above are checked.

  return {
    status: rankedResults.length > 0 ? 'resolved' : 'failed',
    ...(topEntity !== undefined ? { topEntity } : {}),
    candidates,
    decisionConfidenceC,
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: top1Score,
      top2CalibratedScore: top2Score,
      calibratedGap,
      decisionConfidenceC,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: [options.outcomeReasonCode],
    },
    conformalSetSize: shouldBypassSyntheticResolveConformal(options.effectiveRetrievalMode)
      ? NON_ENTITY_SYNTHETIC_CONFORMAL_SET_SIZE
      : computeConformalSetSize(top1Score, DEFAULT_ALPHA, rankedResults.length),
  };
}
