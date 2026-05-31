import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type {
  ExecutionLaneTrace,
  ExecutionRetrievalMode,
  ExecutionTopology,
} from '../../domain/query/model/engine-execution-contract.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { RankingMetadata } from '../../domain/ranking/port/ranker.port.js';
import type { DecisionOutput } from '../../domain/decision/model/decision-output.js';
import type { ResponseBuilderPort } from './port/search-pipeline-deps.port.js';
import type { SearchRouteRetrievalKind } from './search-usecase-route-dispatch.js';
import { deriveQueryFamily } from '../../domain/query/model/query-observability-vocab.js';
import { getExplanationObligation } from '../../domain/response/service/explanation-obligation.js';
import type { ResultItemMappingOptions } from './search-usecase-map-result-items.js';
import type { AdmissionClosureSummary } from '../../domain/decision/model/decision-input.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { SpecializedRouteObservability } from './specialized-route-observability.js';

const ADMISSION_HEALTHY_DEGRADATION_REASONS = new Set([
  'mixed_constraint_guided_hybrid_fallback',
]);

/**
 * Cap on how many top-ranked results trigger a (potentially slow) drinking-window
 * prediction in `recommendation` mode. Recommendation responses surface a broad
 * list, but the drinking-window block is only valuable for the few headline picks
 * the user actually acts on; predicting it for the whole list multiplies predictor
 * calls (each bounded by DRINKING_WINDOW_CHECK_TIMEOUT_MS in map-result-items) for
 * little user benefit. Limited to the top 3 picks. Other retrieval modes leave it
 * uncapped (maxPredictions undefined).
 */
const RECOMMENDATION_DRINKING_WINDOW_PREDICTION_LIMIT = 3;

/**
 * entity_lookup contract: a lookup caller asked for a single authoritative
 * wine. The decisionStatus field is the authoritative correctness signal —
 * when admission rejects (failed) or ambiguity stands (ambiguous), the top-1
 * result is still the closest candidate the engine found, and exposing it
 * with the appropriate status lets the caller act on the closest miss.
 * Returning multiple results would violate the lookup contract.
 *
 * Behaviour:
 *  - non entity_lookup kinds → unchanged (full rankedResults).
 *  - empty rankedResults → unchanged (return empty).
 *  - resolved → prefer decisionOutput.selectedEntity / chosenEntityId match,
 *    fall back to rankedResults[0].
 *  - ambiguous / failed → top-1 (closest miss). selectedEntity is absent on
 *    non-resolved decisions per RFC-007 §3.
 */
export function selectDisplayRankedResultsForDecision(
  rankedResults: readonly RankedResult[],
  decisionOutput: DecisionOutput,
  retrievalKind: SearchRouteRetrievalKind | undefined,
): readonly RankedResult[] {
  if (retrievalKind !== 'entity_lookup' || rankedResults.length === 0) {
    return rankedResults;
  }

  if (decisionOutput.decisionStatus === 'resolved') {
    const selectedEntityId =
      decisionOutput.selectedEntity?.entityId ?? decisionOutput.chosenEntityId;
    if (selectedEntityId !== undefined) {
      const selected = rankedResults.find((result) => result.entityId === selectedEntityId);
      if (selected !== undefined) {
        return [selected];
      }
    }
  }
  return rankedResults.slice(0, 1);
}

export function resolveResultItemMappingOptions(
  effectiveRetrievalMode: ExecutionRetrievalMode,
): ResultItemMappingOptions | undefined {
  return effectiveRetrievalMode === 'recommendation'
    ? { maxPredictions: RECOMMENDATION_DRINKING_WINDOW_PREDICTION_LIMIT }
    : undefined;
}

/**
 * Resolves the target year for drinking-window `currentlyDrinkable` checks.
 * Prefers the caller-injected `nowYear` (deterministic, replay-stable);
 * otherwise derives from `ctx.startTime`, which captures wall-clock exactly
 * ONCE per request at the pre-route phase entry. This funnels every
 * wall-clock read through a single seam so replay harnesses can override it.
 *
 * Accepts the minimal {startTime, nowYear?} shape so both
 * SearchPostRouteExecutionContext and RankedRouteDecisionPhaseContext can
 * call it. nowYear is optional in both — only RankedRouteDecisionPhaseContext
 * actually exposes it to replay harnesses today.
 */
export function resolveTargetYear(ctx: { readonly startTime: number; readonly nowYear?: number | undefined }): number {
  if (ctx.nowYear !== undefined && Number.isFinite(ctx.nowYear)) {
    return ctx.nowYear;
  }
  return new Date(ctx.startTime).getFullYear();
}

export function shouldIncludeCounterfactualsForRequest(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  includeCounterfactuals: boolean | undefined,
): boolean {
  const queryFamily = deriveQueryFamily(plan, compiled);
  const obligation = getExplanationObligation(queryFamily);
  return obligation.requiresCounterfactual || includeCounterfactuals !== false;
}

export function toAdmissionHonestyContract(
  routeDegradation: RankingDegradationSignal | undefined,
): {
  readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory' | undefined;
  readonly routeHealthy?: boolean | undefined;
} {
  if (routeDegradation === undefined) {
    return {
      executionMode: 'authoritative',
      routeHealthy: true,
    };
  }

  const admissionRelevantReasons = routeDegradation.degradationReasons.includes(
    'mixed_constraint_guided_hybrid_fallback',
  )
    ? routeDegradation.degradationReasons.filter((reason) => reason !== 'mixed_similar_retrieval_fallback')
    : routeDegradation.degradationReasons;

  return {
    executionMode: routeDegradation.executionMode,
    routeHealthy: admissionRelevantReasons.every((reason) =>
      ADMISSION_HEALTHY_DEGRADATION_REASONS.has(reason),
    ),
  };
}

export function buildResponseExecutionContract(
  routeExecutionFacts: {
    readonly executionTopology: ExecutionTopology;
    readonly laneTrace: ExecutionLaneTrace;
    readonly effectiveRetrievalMode: ExecutionRetrievalMode;
    readonly retrievalKind: SearchRouteRetrievalKind;
    readonly sparseExecuted: boolean;
    readonly specializedRouteExecuted: SpecializedRouteObservability['specializedRouteExecuted'];
    readonly usedCompiledExecution: boolean;
  },
  rankingMetadata?: RankingMetadata,
  admissionClosure?: AdmissionClosureSummary,
): NonNullable<ResponseBuilderPort['build'] extends (params: infer T) => unknown ? T : never>['executionContract'] {
  return {
    executionTopology: routeExecutionFacts.executionTopology,
    effectiveRetrievalMode: routeExecutionFacts.effectiveRetrievalMode,
    retrievalKind: routeExecutionFacts.retrievalKind,
    sparseExecuted: routeExecutionFacts.sparseExecuted,
    specializedRouteExecuted: routeExecutionFacts.specializedRouteExecuted,
    usedCompiledExecution: routeExecutionFacts.usedCompiledExecution,
    laneTrace: routeExecutionFacts.laneTrace,
    ...(rankingMetadata?.provenanceClosure !== undefined
      ? { provenanceClosure: rankingMetadata.provenanceClosure }
      : {}),
    ...(admissionClosure !== undefined ? { admissionClosure } : {}),
  };
}
