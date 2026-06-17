/**
 * Bridge from {@link EntityLookupV2UseCase} outcomes into the search entity-route
 * contract ({@link EntityRouteResult} / {@link EntityResolveResult}).
 *
 * Used when production wiring passes `entityLookupV2UseCase` into
 * {@link SearchUseCase} so `executeEntityRoute` delegates to the V2 lookup
 * authority.
 */

import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../domain/query/model/compiled-wine-query.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { ResolvedCandidate } from '../../../domain/resolver/model/resolved-candidate.js';
import { AMBIGUITY_TYPES, type AmbiguityType } from '../../../domain/resolver/model/ambiguity-state.js';
import type { LookupV2Status } from '../../../domain/resolver/v2/lookup-v2-types.js';
import { mapLookupV2StatusToWireDecisionStatus } from './entity-lookup-v2-mapping.js';
import {
  computeConformalSetSize,
  DEFAULT_ALPHA,
} from '../../../domain/resolver/service/resolver-conformal.js';
import { pipelineDebug } from '../../../domain/observability/request-pipeline-debug.js';
import { PipelineDebugStep } from '../../../domain/observability/pipeline-debug-steps.js';
import type { NextAction } from '../../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/index.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
import {
  buildSearchExecutionLaneTrace,
  type EntityRouteResult,
} from '../search-usecase-route-dispatch.js';
import {
  buildEntityRouteRankedResults,
  liftEntityResolveResultToLaneArtifacts,
} from '../search-usecase-entity-ranked-results.js';
import type { EntityLookupV2UseCasePort } from '../port/search-route-usecases.port.js';
import type { ResolverCandidate } from '../../../domain/resolver/model/resolved-candidate.js';
import type { EntityLookupV2Result } from './entity-lookup-v2.dto.js';

const LOOKUP_V2_REDIRECT_DISCOVERY_REASON = 'redirect_discovery';

const ambiguityTypeSet = new Set<string>(AMBIGUITY_TYPES);

function isAmbiguityType(value: string): value is AmbiguityType {
  return ambiguityTypeSet.has(value);
}

/** Compatibility alias — prefer {@link mapLookupV2StatusToWireDecisionStatus}. */
export const mapLookupV2StatusToResolverStatus = mapLookupV2StatusToWireDecisionStatus;

function mapLookupV2StatusToNextAction(status: LookupV2Status): NextAction {
  switch (status) {
    case 'resolved':
      return 'return_result';
    case 'ambiguous':
      return 'clarify';
    case 'redirect_discovery':
      return 'hybrid_search';
    case 'failed':
    default:
      return 'fail';
  }
}

function projectV2Candidates(v2Result: EntityLookupV2Result): readonly ResolvedCandidate[] {
  return v2Result.candidates.map((candidate) => ({
    entityId: createCanonicalEntityId(candidate.entityId),
    canonicalLabel: candidate.canonicalLabel,
    calibratedScore: candidate.calibratedScore,
    rank: candidate.rank,
    evidenceRefs: [],
  }));
}

function projectAmbiguityTypes(
  types: readonly string[] | undefined,
): readonly AmbiguityType[] {
  if (types == null || types.length === 0) {
    return [];
  }
  return types.filter(isAmbiguityType);
}

/**
 * Build a minimal but schema-valid {@link EntityResolveResult} from a V2 lookup
 * outcome so the search post-route phase can reuse the existing entity-route
 * ranked-result and lane-artifact builders.
 */
export function buildEntityResolveResultFromLookupV2(
  v2Result: EntityLookupV2Result,
  plan: QueryPlanV1,
): EntityResolveResult {
  const status = mapLookupV2StatusToWireDecisionStatus(v2Result.status);
  const candidates = projectV2Candidates(v2Result);
  const top1CalibratedScore = v2Result.evidenceSummary.topConfidence
    ?? v2Result.topCandidate?.calibratedScore
    ?? 0;
  const top2Candidate = candidates.find((candidate) => candidate.rank === 2);
  const top2CalibratedScore = top2Candidate?.calibratedScore;
  const calibratedGap = top2CalibratedScore !== undefined
    ? top1CalibratedScore - top2CalibratedScore
    : undefined;
  const decisionConfidenceC = top1CalibratedScore;
  const ambiguityTypes = projectAmbiguityTypes(v2Result.evidenceSummary.ambiguityTypes);
  const ambiguityDetected = v2Result.status === 'ambiguous' || ambiguityTypes.length > 0;
  const outcomeReasonCodes = [
    v2Result.evidenceSummary.decisionReasonCode,
    v2Result.evidenceSummary.admissionReasonCode,
  ].filter((code, index, codes) => code.length > 0 && codes.indexOf(code) === index);

  const resolveResult: EntityResolveResult = {
    status,
    recommendedNextAction: mapLookupV2StatusToNextAction(v2Result.status),
    decisionConfidenceC,
    ...(v2Result.topCandidate !== null
      ? {
          topEntity: {
            entityId: createCanonicalEntityId(v2Result.topCandidate.entityId),
            canonicalLabel: v2Result.topCandidate.canonicalLabel,
            calibratedScore: v2Result.topCandidate.calibratedScore,
          },
        }
      : {}),
    candidates,
    ...(ambiguityDetected && v2Result.evidenceSummary.ambiguitySeverity !== undefined
      ? {
          ambiguity: {
            types: ambiguityTypes,
            severity: v2Result.evidenceSummary.ambiguitySeverity,
            explanationCodes: outcomeReasonCodes,
          },
        }
      : {}),
    decisionTrace: {
      queryClass: v2Result.evidenceSummary.queryClass || plan.queryClass,
      top1CalibratedScore,
      top2CalibratedScore,
      calibratedGap,
      decisionConfidenceC,
      calibrationTrusted: v2Result.evidenceSummary.calibrationTrusted,
      ambiguityDetected,
      ambiguityTypes,
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes,
    },
    ...(v2Result.status === 'redirect_discovery'
      ? { degradation: { reasons: [LOOKUP_V2_REDIRECT_DISCOVERY_REASON] } }
      : {}),
    conformalSetSize: computeConformalSetSize(
      decisionConfidenceC,
      DEFAULT_ALPHA,
      candidates.length,
    ),
  };

  return resolveResult;
}

function buildEntityLookupV2Command(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
): {
  readonly query: string;
  readonly maxCandidates: number;
  readonly mode: 'default';
} {
  return {
    query: plan.rawQuery,
    maxCandidates: compiled.execution.budget.maxCandidates,
    mode: 'default',
  };
}

/**
 * Run the entity-only search route through the V2 lookup authority and project
 * the outcome into {@link EntityRouteResult}.
 */
/**
 * Hybrid / dual-lane anchor resolution through the V2 lookup authority.
 * Returns the resolver-shaped head plus an empty raw-candidate list — V2 owns
 * hydration internally (same contract as {@link executeEntityRouteViaLookupV2}).
 */
export async function resolveEntityRouteForPlanViaLookupV2(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  useCase: EntityLookupV2UseCasePort,
  options?: RequestExecutionContext,
): Promise<{
  readonly resolveResult: EntityResolveResult;
  readonly resolverCandidates: readonly ResolverCandidate[];
}> {
  const route = await executeEntityRouteViaLookupV2(plan, compiled, useCase, options);
  return {
    resolveResult: route.identityResolveResult,
    resolverCandidates: [],
  };
}

export async function executeEntityRouteViaLookupV2(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  useCase: EntityLookupV2UseCasePort,
  options?: RequestExecutionContext,
): Promise<EntityRouteResult> {
  pipelineDebug(
    {
      step: PipelineDebugStep.ROUTE_ENTITY_ONLY_START,
      query_class: plan.queryClass,
      lookup_authority: 'entity_lookup_v2',
    },
    'pipeline entity-only route (lookup v2)',
  );

  const v2Result = await useCase.execute(
    buildEntityLookupV2Command(plan, compiled),
    options,
  );
  const resolveResult = buildEntityResolveResultFromLookupV2(v2Result, plan);
  const rankedResults = buildEntityRouteRankedResults(plan, resolveResult, []);
  const laneArtifacts = {
    identity: liftEntityResolveResultToLaneArtifacts(plan, resolveResult, []),
    general: [],
    fused: [],
  };
  const topRankedResult = rankedResults[0];

  pipelineDebug(
    {
      step: PipelineDebugStep.ROUTE_ENTITY_ONLY_DONE,
      lookup_authority: 'entity_lookup_v2',
      lookup_v2_status: v2Result.status,
      resolve_status: resolveResult.status,
      candidate_count: resolveResult.candidates.length,
      ranked_count: rankedResults.length,
      ...(resolveResult.decisionTrace.outcomeReasonCodes.length > 0
        ? { outcome_reason_codes: resolveResult.decisionTrace.outcomeReasonCodes }
        : {}),
      ...(topRankedResult !== undefined
        ? {
            top_hard_constraint_pass: topRankedResult.componentScores.hardConstraintPass,
            top_matched_constraints: topRankedResult.matchedConstraints,
            top_unmet_constraints: topRankedResult.unmetConstraints,
            top_evidence_item_count: topRankedResult.evidenceItems.length,
          }
        : {}),
      has_degradation: resolveResult.degradation !== undefined,
    },
    'pipeline entity-only route (lookup v2)',
  );

  return {
    executionTopology: 'entity_only',
    executedPlan: plan,
    executedCompiled: compiled,
    identityResolveResult: resolveResult,
    fusedResolveResult: resolveResult,
    laneArtifacts,
    laneTrace: buildSearchExecutionLaneTrace({
      executionTopology: 'entity_only',
      identityResolveResult: resolveResult,
      fusedResolveResult: resolveResult,
      laneArtifacts,
    }),
    rankedResults,
    effectiveRetrievalMode: compiled.execution.effectiveRetrievalMode,
    usedCompiledExecution: true,
    retrievalKind: 'entity_lookup',
    sparseExecuted: false,
    specializedRouteExecuted: null,
  };
}
