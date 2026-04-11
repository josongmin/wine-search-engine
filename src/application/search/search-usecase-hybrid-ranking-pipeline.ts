import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { RankingInput } from '../../domain/ranking/model/ranking-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type {
  BlockingUseCasePort,
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
  EntityDocumentLookupPort,
  EntityResolverPort,
  RankingPort,
} from './port/search-pipeline-deps.port.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { buildHybridRouteResolveResult } from './search-usecase-hybrid-route.js';
import { retrieveHybridCandidatesForPlan } from './search-usecase-hybrid-candidates.js';
import type { SearchRouteExecutionResult } from './search-usecase-route-dispatch.js';
import { buildResolverCandidatesFromGenerator } from './search-usecase-resolver-candidates.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import { buildRelaxationLadder } from '../../domain/query/service/constraint-relaxation.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import { throwIfAborted } from '../../domain/shared/cooperative-abort.js';

export interface HybridRankingRouteDeps {
  readonly candidatePool: CandidatePoolPort;
  readonly browseRetriever?: BrowseRetrieverPort | undefined;
  readonly compareRetriever?: CompareRetrieverPort | undefined;
  readonly ranker: RankingPort;
}

export interface RankedRouteEntityResolutionDeps {
  readonly entityResolver?: EntityResolverPort | undefined;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
  /** TA2-4: Optional blocker for seeding candidates beyond alias anchors. */
  readonly blocker?: BlockingUseCasePort | undefined;
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
      { step: PipelineDebugStep.RESOLVER_ANCHOR_MISSING, query_class: plan.queryClass },
      'pipeline hybrid anchor resolver unavailable',
    );
    return buildMissingEntityResolverResult(plan);
  }

  // TA2-4: Invoke blocker to surface entity IDs not covered by alias anchors.
  let blockerOnlyIds: readonly import('../../domain/shared/types/index.js').EntityId[] = [];
  if (deps.blocker !== undefined) {
    const allBlockerIds = await deps.blocker.block(plan.rawQuery, plan.normalizedQuery);
    const anchorCoveredIds = new Set(
      plan.anchors.flatMap((a) => a.candidateEntityIds.map(String)),
    );
    blockerOnlyIds = allBlockerIds.filter((id) => !anchorCoveredIds.has(String(id)));
  }

  const candidateEntities = await buildResolverCandidatesFromGenerator(
    {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      anchors: plan.anchors,
      ...(blockerOnlyIds.length > 0 ? { blockerOnlyIds } : {}),
    },
    deps.entityLookup,
  );

  pipelineDebug(
    {
      step: PipelineDebugStep.RESOLVER_ANCHOR_START,
      query_class: plan.queryClass,
      resolver_candidate_count: candidateEntities.length,
      blocker_seed_count: blockerOnlyIds.length,
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
      step: PipelineDebugStep.RESOLVER_ANCHOR_DONE,
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
  compiled?: CompiledWineQuery,
): Promise<SearchRouteExecutionResult> {
  const retrievalPlan = compiled?.query.retrievalPlan ?? buildRetrievalPlan(plan.constraints);
  const rankingInput: RankingInput = {
    queryPlan: plan,
    candidates,
    constraints: plan.constraints,
    retrievalPlan,
    ...(compiled !== undefined ? { compiled } : {}),
  };

  const { results: rankedResults, metadata: rankingMetadata } = await ranker.rank(rankingInput);
  const rankerDegradation = rankingMetadata.runtimeSignal?.degradation ?? ranker.getLastRuntimeSignal?.()?.degradation;
  // Prefer metadata.funnelMetrics (per-call, concurrency-safe) over the legacy
  // getter (instance state, race-prone under concurrent rank() calls).
  const funnelMetrics = rankingMetadata.funnelMetrics ?? ranker.getLastFunnelMetrics?.();

  if (ranker.getLastFunnelMetrics === undefined) {
    pipelineDebug(
      {
        step: PipelineDebugStep.RANKING_HYBRID_COMPLETE,
        query_class: plan.queryClass,
        warning: 'ranker lacks getLastFunnelMetrics — stage D (policy_apply) will be skipped; inject RankingStagePipeline for full funnel observability',
      },
      'pipeline hybrid ranking: bare ranker injected, funnel metrics unavailable',
    );
  }

  pipelineDebug(
    {
      step: PipelineDebugStep.RANKING_HYBRID_COMPLETE,
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
    rankingMetadata,
  };
}

/**
 * Shared hybrid-ranked route execution:
 * specialized retrieval fallback + ranking/LTR + synthetic resolve.
 *
 * No-result recovery — progressive constraint relaxation:
 * If the ranked result set is empty AND the plan has hard constraints,
 * we attempt up to MAX_RELAXATION_STEPS constraint relaxation retries.
 * Each step removes the most-specific geography/variety constraint and retries
 * the full retrieval+ranking pipeline with a mutated plan.
 *
 * The final result carries a `routeDegradation` signal listing relaxed
 * attributes so the response builder can surface a "results may not match all
 * criteria" banner to the user.
 */
// Cover the realistic relaxation depth: appellation → region → country → vintage/grape.
// 4 steps handles 95% of real queries; beyond that, the query is too specific for the index.
const MAX_RELAXATION_STEPS = 4;

export async function executeHybridRouteRankingPipeline(
  plan: QueryPlanV1,
  deps: HybridRankingRouteDeps,
  resolveEntity: (plan: QueryPlanV1) => Promise<EntityResolveResult>,
  compiled?: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
): Promise<SearchRouteExecutionResult> {
  const retrieval = await retrieveHybridCandidatesForPlan(
    plan,
    {
      candidatePool: deps.candidatePool,
      browseRetriever: deps.browseRetriever,
      compareRetriever: deps.compareRetriever,
    },
    resolveEntity,
    compiled,
    requestContext,
  );
  const ranked = await runHybridRankingPipeline(plan, retrieval.candidates, deps.ranker, compiled);

  // No-result recovery: attempt progressive constraint relaxation.
  if (ranked.rankedResults.length === 0 && plan.constraints.hard.length > 0) {
    const ladder = buildRelaxationLadder(plan.constraints);
    const stepsToTry = ladder.slice(0, MAX_RELAXATION_STEPS);
    let abortedDuringRelaxation = false;

    for (const step of stepsToTry) {
      // Check abort signal before each relaxation attempt to prevent latency runaway.
      // MAX_RELAXATION_STEPS=4 can add 4 full round-trips to zero-result queries.
      if (requestContext?.abortSignal?.aborted === true) {
        pipelineDebug(
          { step: 'retrieval.constraint_relaxation.aborted', relaxed_attributes: step.relaxedAttributes },
          'pipeline constraint relaxation aborted by request signal',
        );
        abortedDuringRelaxation = true;
        break;
      }

      pipelineDebug(
        {
          step: 'retrieval.constraint_relaxation.attempt',
          relaxed_attributes: step.relaxedAttributes,
          original_hard_count: plan.constraints.hard.length,
          new_hard_count: step.constraints.hard.length,
        },
        'pipeline constraint relaxation retry',
      );

      // Build a shallow plan copy with relaxed constraints.
      const relaxedPlan: QueryPlanV1 = {
        ...plan,
        constraints: step.constraints,
      };

      // Pass compiled=undefined for relaxation retries.
      //
      // compiled.query.retrievalPlan is built from the ORIGINAL constraints —
      // if we pass it through, retrieveHybridCandidatesForPlan and
      // runHybridRankingPipeline both prefer compiled.query.retrievalPlan over
      // buildRetrievalPlan(relaxedPlan.constraints), so the Vespa YQL filter
      // would still contain the un-relaxed constraints, making the retry
      // identical to the first attempt and permanently returning zero results.
      //
      // Without compiled, both call sites fall back to
      // buildRetrievalPlan(plan.constraints) using relaxedPlan — correct.
      const relaxedRetrieval = await retrieveHybridCandidatesForPlan(
        relaxedPlan,
        {
          candidatePool: deps.candidatePool,
          browseRetriever: deps.browseRetriever,
          compareRetriever: deps.compareRetriever,
        },
        resolveEntity,
        undefined, // intentionally omitted — see comment above
        requestContext,
      );
      const relaxedRanked = await runHybridRankingPipeline(
        relaxedPlan,
        relaxedRetrieval.candidates,
        deps.ranker,
        undefined, // intentionally omitted — see comment above
      );

      if (relaxedRanked.rankedResults.length > 0) {
        pipelineDebug(
          {
            step: 'retrieval.constraint_relaxation.success',
            relaxed_attributes: step.relaxedAttributes,
            result_count: relaxedRanked.rankedResults.length,
          },
          'pipeline constraint relaxation recovered results',
        );

        // Merge degradation signals: relaxation is itself a degradation.
        const relaxationDegradation: RankingDegradationSignal = {
          executionMode: 'degraded',
          degradationReasons: [`constraint_relaxed:${step.relaxedAttributes.join(',')}`],
        };
        const mergedDegradation = mergeRouteDegradation(
          relaxedRanked.routeDegradation,
          relaxationDegradation,
        );

        return {
          ...relaxedRanked,
          routeDegradation: mergedDegradation,
          ...(relaxedRetrieval.specializedRouteObservability !== undefined
            ? { specializedRouteObservability: relaxedRetrieval.specializedRouteObservability }
            : {}),
        };
      }
      // Still no results — try next relaxation step.
    }

    // Propagate abort: returning HTTP 200 with empty results when the client has
    // already cancelled is incorrect — propagate the abort so the error handler
    // can close the connection cleanly.
    if (abortedDuringRelaxation) {
      throwIfAborted(requestContext?.abortSignal, 'Hybrid route ranking pipeline aborted during constraint relaxation');
    }

    // All relaxation steps exhausted — signal that recovery was attempted but failed.
    // This surfaces as a degradation reason so response builders can log/alert.
    if (stepsToTry.length > 0) {
      const exhaustionDegradation: RankingDegradationSignal = {
        executionMode: 'degraded',
        degradationReasons: [`constraint_relaxation_exhausted:${stepsToTry.length}_steps`],
      };
      const mergedWithExhaustion = mergeRouteDegradation(ranked.routeDegradation, exhaustionDegradation);
      return {
        ...ranked,
        routeDegradation: mergedWithExhaustion,
        ...(retrieval.specializedRouteObservability !== undefined
          ? { specializedRouteObservability: retrieval.specializedRouteObservability }
          : {}),
      };
    }
  }

  // Normal (non-relaxation) path — merge retrieval + ranking degradations.
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
    routeDegradation: mergeRouteDegradation(ranked.routeDegradation, retrieval.routeDegradation),
    ...(retrieval.specializedRouteObservability !== undefined
      ? { specializedRouteObservability: retrieval.specializedRouteObservability }
      : {}),
  };
}

function mergeRouteDegradation(
  a: RankingDegradationSignal | undefined,
  b: RankingDegradationSignal,
): RankingDegradationSignal {
  if (a === undefined) return b;
  return {
    executionMode: 'degraded',
    degradationReasons: [...new Set([...a.degradationReasons, ...b.degradationReasons])],
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
