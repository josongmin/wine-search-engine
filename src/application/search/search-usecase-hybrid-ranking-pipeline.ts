import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { RankingInput } from '../../domain/ranking/model/ranking-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type {
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
  EntityDocumentLookupPort,
  EntityResolverPort,
  RankingPort,
} from './port/search-pipeline-deps.port.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import { buildHybridRouteResolveResult } from './search-usecase-hybrid-route.js';
import { retrieveHybridCandidatesForPlan } from './search-usecase-hybrid-candidates.js';
import type { SearchRouteExecutionResult } from './search-usecase-route-dispatch.js';
import { buildResolverCandidatesFromPlan } from './search-usecase-resolver-candidates.js';

export interface HybridRankingRouteDeps {
  readonly candidatePool: CandidatePoolPort;
  readonly browseRetriever?: BrowseRetrieverPort | undefined;
  readonly compareRetriever?: CompareRetrieverPort | undefined;
  readonly ranker: RankingPort;
}

export interface RankedRouteEntityResolutionDeps {
  readonly entityResolver?: EntityResolverPort | undefined;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
}

export interface HybridRankedRoutePipelineDeps
  extends HybridRankingRouteDeps, RankedRouteEntityResolutionDeps {}

function buildMissingEntityResolverResult(plan: QueryPlanV1): EntityResolveResult {
  return {
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: 0,
      top2CalibratedScore: 0,
      calibratedGap: 0,
      decisionConfidenceC: 0,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: ['HYBRID_ROUTE_MISSING_ENTITY_RESOLVER'],
    },
    conformalSetSize: 1,
    degradation: { reasons: ['entity_resolver_unavailable'] },
  };
}

/**
 * Shared entity-route execution used by hybrid ranked-route fallbacks when a
 * specialized retriever needs an anchor entity first (for example compare mode).
 */
export async function resolveEntityRouteForPlan(
  plan: QueryPlanV1,
  deps: RankedRouteEntityResolutionDeps,
): Promise<EntityResolveResult> {
  if (deps.entityResolver === undefined) {
    pipelineDebug(
      { step: 'resolver.anchor.missing', query_class: plan.queryClass },
      'pipeline hybrid anchor resolver unavailable',
    );
    return buildMissingEntityResolverResult(plan);
  }

  const candidateEntities = await buildResolverCandidatesFromPlan(
    plan,
    deps.entityLookup,
  );

  pipelineDebug(
    {
      step: 'resolver.anchor.start',
      query_class: plan.queryClass,
      resolver_candidate_count: candidateEntities.length,
    },
    'pipeline hybrid anchor resolve',
  );

  const resolved = await deps.entityResolver.resolve({
    rawQuery: plan.rawQuery,
    normalizedQuery: plan.normalizedQuery,
    ...(plan.normalizedQueryViews !== undefined
      ? { normalizedQueryViews: plan.normalizedQueryViews }
      : {}),
    queryClass: plan.queryClass,
    policy: plan.policy,
    anchorCandidates: plan.anchors,
    uncertainty: plan.uncertainty,
    candidateEntities,
  });

  pipelineDebug(
    {
      step: 'resolver.anchor.done',
      resolve_status: resolved.status,
      candidate_count: resolved.candidates.length,
    },
    'pipeline hybrid anchor resolve',
  );

  return resolved;
}

/**
 * Shared resolver callback for ranked routes that may need an entity-route
 * anchor resolution before specialized retrieval can execute.
 */
export function createRankedRouteEntityResolver(
  deps: RankedRouteEntityResolutionDeps,
): (plan: QueryPlanV1) => Promise<EntityResolveResult> {
  return (plan) => resolveEntityRouteForPlan(plan, deps);
}

/**
 * Candidate pool output → rank → optional LTR → synthetic hybrid resolve result.
 */
export async function runHybridRankingPipeline(
  plan: QueryPlanV1,
  candidates: readonly HybridCandidate[],
  ranker: RankingPort,
): Promise<SearchRouteExecutionResult> {
  const rankingInput: RankingInput = {
    queryPlan: plan,
    candidates,
    constraints: plan.constraints,
  };

  const rankedResults = await ranker.rank(rankingInput);
  const rankerDegradation = ranker.getLastRuntimeSignal?.()?.degradation;
  const funnelMetrics = ranker.getLastFunnelMetrics?.();

  pipelineDebug(
    {
      step: 'ranking.hybrid.complete',
      query_class: plan.queryClass,
      input_candidates: candidates.length,
      ranked_count: rankedResults.length,
      has_funnel_metrics: funnelMetrics !== undefined,
    },
    'pipeline hybrid ranking',
  );

  const resolveResult: EntityResolveResult = buildHybridRouteResolveResult(plan, rankedResults);

  return {
    resolveResult,
    rankedResults,
    ...(rankerDegradation !== undefined ? { routeDegradation: rankerDegradation } : {}),
    ...(funnelMetrics !== undefined ? { funnelMetrics } : {}),
  };
}

/**
 * Shared hybrid-ranked route execution:
 * specialized retrieval fallback + ranking/LTR + synthetic resolve.
 */
export async function executeHybridRouteRankingPipeline(
  plan: QueryPlanV1,
  deps: HybridRankingRouteDeps,
  resolveEntity: (plan: QueryPlanV1) => Promise<EntityResolveResult>,
): Promise<SearchRouteExecutionResult> {
  const retrieval = await retrieveHybridCandidatesForPlan(
    plan,
    {
      candidatePool: deps.candidatePool,
      browseRetriever: deps.browseRetriever,
      compareRetriever: deps.compareRetriever,
    },
    resolveEntity,
  );
  const ranked = await runHybridRankingPipeline(plan, retrieval.candidates, deps.ranker);
  if (retrieval.routeDegradation === undefined) {
    return {
      ...ranked,
      ...(retrieval.specializedRouteObservability !== undefined
        ? { specializedRouteObservability: retrieval.specializedRouteObservability }
        : {}),
    };
  }

  return {
    ...ranked,
    routeDegradation: ranked.routeDegradation === undefined
      ? retrieval.routeDegradation
      : {
          executionMode: 'degraded',
          degradationReasons: [
            ...new Set([
              ...ranked.routeDegradation.degradationReasons,
              ...retrieval.routeDegradation.degradationReasons,
            ]),
          ],
        },
    ...(retrieval.specializedRouteObservability !== undefined
      ? { specializedRouteObservability: retrieval.specializedRouteObservability }
      : {}),
  };
}

/**
 * End-to-end shared ranked-route execution used by HybridUseCase:
 * specialized retrieval fallback + ranking/LTR + synthetic resolve.
 */
export async function executeHybridRankedRoutePlan(
  plan: QueryPlanV1,
  deps: HybridRankedRoutePipelineDeps,
): Promise<SearchRouteExecutionResult> {
  return executeHybridRouteRankingPipeline(
    plan,
    deps,
    createRankedRouteEntityResolver(deps),
  );
}
