import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
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
import {
  retrieveHybridCandidatesForPlan,
  projectRewritesForDecisionInput,
  type HybridCandidateRetrievalResult,
} from './search-usecase-hybrid-candidates.js';
import type { SearchRouteExecutionResult } from './search-usecase-route-dispatch.js';
import { buildResolverCandidatesFromGenerator } from './search-usecase-resolver-candidates.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import { buildRelaxationLadder } from '../../domain/query/service/constraint-relaxation.js';
import { buildTrivialGraphFromAtoms } from '../../domain/query/service/build-trivial-graph-from-atoms.js';
import { isConstraintGraphEmitEnabled } from '../../domain/query/service/constraint-graph-flags.js';
import { liftBundleToAtoms } from '../../domain/shared/types/constraint-atom.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type {
  ExecutionProvenanceClosure,
  ProvenanceCoverageStage,
} from '../../domain/query/model/engine-execution-contract.js';
import { throwIfAborted } from '../../domain/shared/cooperative-abort.js';
import {
  buildExecutionProvenanceClosureFromStages,
  buildHybridCandidateCoverageStage,
  buildRankedResultCoverageStage,
} from './search-usecase-provenance-closure.js';

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

function capAnchorResolverBlockerSeedIds(
  plan: QueryPlanV1,
  blockerOnlyIds: readonly CanonicalEntityId[],
  compiled: CompiledWineQuery,
): readonly CanonicalEntityId[] {
  const maxCandidates = compiled.execution.budget.maxCandidates;

  const anchorCoveredIds = new Set(
    plan.anchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)),
  );
  const remainingSlots = Math.max(0, maxCandidates - anchorCoveredIds.size);
  return blockerOnlyIds.slice(0, remainingSlots);
}

function buildMissingEntityResolverResult(plan: QueryPlanV1): EntityResolveResult {
  return {
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: 0,
      top2CalibratedScore: undefined,
      calibratedGap: undefined,
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

export function buildRelaxedCompiledQuery(
  compiled: CompiledWineQuery,
  relaxedPlan: QueryPlanV1,
): CompiledWineQuery {
  // ADR-011/014 + Phase 1b.4: constraint relaxation drops hard attributes
  // from `compiled.query.constraints`, but the pre-relaxation
  // `constraintGraph` still carries slot nodes for those dropped
  // attributes. Graph-aware readers (provenance-closure, decision-input,
  // ranker hard-gate) would fail candidates on stale obligations while
  // the flat path happily accepts them — the exact split that golden-set
  // `Masi Amarone` / `Barolo Monfortino` tripped. The Wave 1 hotfix
  // (commit e909609) stripped `constraintGraph` entirely from the relaxed
  // compiled query so every reader fell back to the flat bundle path.
  // That was a safety patch: correct, but graph-aware semantics were LOST
  // for relaxed queries. Under LLM topology (XOR/OR branches from
  // Phase 1b.2) the strip would silently demote a valid topology to
  // flat AND-all — a SOTA++ regression.
  //
  // Phase 1b.4 regenerates the graph from the relaxed bundle instead.
  // Because relaxation only DROPS attributes from the hard list (see
  // `buildRelaxationLadder` — the soft/inferred lists are preserved
  // verbatim), `liftBundleToAtoms(relaxedPlan.constraints)` is a subset
  // of the original atom list and the trivial graph over that subset is
  // trivially consistent with the flat `relaxedPlan.constraints` path.
  //
  // We regenerate as a TRIVIAL graph only — even if the original graph
  // was `origin: 'hybrid'` or `'planner_emitted'` from an LLM topology
  // planner, a relaxed query may drop slots that the XOR/OR branches
  // referenced, so preserving the LLM topology is unsound without
  // per-node rewriting. Demoting to deterministic trivial is the
  // strictly-correct contract for Phase 1b.4. A future Phase 1c.x could
  // add topology-preserving rewriting where the relaxed slot set still
  // satisfies every LLM-emitted branch, but until then demotion is the
  // conservative floor.
  //
  // Feature-flag gating: the regeneration is suppressed when
  // `CONSTRAINT_GRAPH_EMIT=false`, mirroring the compiler's SSoT helper.
  // In that rollback mode the relaxed compiled query carries no graph at
  // all — identical to the Phase 1a rollback semantics at the compiler
  // seam.
  const { constraintGraph: _droppedStaleGraph, ...compiledSansGraph } = compiled;
  const regeneratedGraph = isConstraintGraphEmitEnabled()
    ? buildTrivialGraphFromAtoms(liftBundleToAtoms(relaxedPlan.constraints))
    : undefined;
  return {
    ...compiledSansGraph,
    query: {
      ...compiled.query,
      constraints: relaxedPlan.constraints,
      retrievalPlan: buildRetrievalPlan(relaxedPlan.constraints),
    },
    ...(regeneratedGraph !== undefined ? { constraintGraph: regeneratedGraph } : {}),
  };
}

function buildHybridExecutionFacts(params: {
  readonly plan: QueryPlanV1;
  readonly compiled: CompiledWineQuery;
  readonly specializedRouteExecuted?: SearchRouteExecutionResult['specializedRouteExecuted'] | undefined;
  readonly sparseExecuted?: boolean | undefined;
}): Pick<SearchRouteExecutionResult,
  'effectiveRetrievalMode'
  | 'retrievalKind'
  | 'sparseExecuted'
  | 'specializedRouteExecuted'
  | 'usedCompiledExecution'
> {
  const effectiveRetrievalMode = params.compiled.execution.effectiveRetrievalMode;
  const usedCompiledExecution = true;
  const specializedRouteExecuted = params.specializedRouteExecuted ?? null;
  const sparseExecuted = params.sparseExecuted ?? true;
  return {
    effectiveRetrievalMode,
    retrievalKind: specializedRouteExecuted !== null ? 'specialized_hybrid' : 'generic_hybrid',
    sparseExecuted,
    specializedRouteExecuted,
    usedCompiledExecution,
  };
}

function buildHybridExecutionFactsFromRetrieval(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  retrieval: HybridCandidateRetrievalResult,
): Pick<SearchRouteExecutionResult,
  'effectiveRetrievalMode'
  | 'retrievalKind'
  | 'sparseExecuted'
  | 'specializedRouteExecuted'
  | 'usedCompiledExecution'
> {
  return buildHybridExecutionFacts({
    plan,
    compiled,
    specializedRouteExecuted: retrieval.specializedRouteObservability?.specializedRouteExecuted ?? null,
    sparseExecuted: retrieval.sparseExecuted,
  });
}

function mergeProvenanceShortfall(
  routeDegradation: RankingDegradationSignal | undefined,
  provenanceClosure: ExecutionProvenanceClosure | undefined,
): RankingDegradationSignal | undefined {
  if (provenanceClosure === undefined || provenanceClosure.missing.length === 0) {
    return routeDegradation;
  }

  const provenanceDegradation: RankingDegradationSignal = {
    executionMode: 'degraded',
    degradationReasons: provenanceClosure.missing.map(
      (obligation) => `provenance_shortfall:${obligation}`,
    ),
  };

  if (routeDegradation === undefined) {
    return provenanceDegradation;
  }

  return mergeRouteDegradation(routeDegradation, provenanceDegradation);
}

/**
 * Shared entity-route execution used by hybrid ranked-route fallbacks when a
 * specialized retriever needs an anchor entity first (for example compare mode).
 */
export async function resolveEntityRouteForPlan(
  plan: QueryPlanV1,
  deps: RankedRouteEntityResolutionDeps,
  compiled: CompiledWineQuery,
): Promise<EntityResolveResult> {
  if (deps.entityResolver === undefined) {
    pipelineDebug(
      { step: PipelineDebugStep.RESOLVER_ANCHOR_MISSING, query_class: plan.queryClass },
      'pipeline hybrid anchor resolver unavailable',
    );
    return buildMissingEntityResolverResult(plan);
  }

  // TA2-4: Invoke blocker to surface entity IDs not covered by alias anchors.
  let blockerOnlyIds: readonly CanonicalEntityId[] = [];
  if (deps.blocker !== undefined) {
    const allBlockerIds = await deps.blocker.block(plan.rawQuery, plan.normalizedQuery);
    const anchorCoveredIds = new Set(
      plan.anchors.flatMap((a) => a.candidateEntityIds.map(String)),
    );
    blockerOnlyIds = capAnchorResolverBlockerSeedIds(
      plan,
      allBlockerIds.filter((id) => !anchorCoveredIds.has(String(id))),
      compiled,
    );
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
  compiled: CompiledWineQuery,
): (plan: QueryPlanV1) => Promise<EntityResolveResult> {
  return (plan) => resolveEntityRouteForPlan(plan, deps, compiled);
}

/**
 * Candidate pool output → rank → optional LTR → synthetic hybrid resolve result.
 */
export async function runHybridRankingPipeline(
  plan: QueryPlanV1,
  candidates: readonly HybridCandidate[],
  ranker: RankingPort,
  compiled: CompiledWineQuery,
  retrievalProvenanceCoverage?: ProvenanceCoverageStage,
  retrievalPlanOverride?: ReturnType<typeof buildRetrievalPlan>,
): Promise<SearchRouteExecutionResult> {
  const retrievalPlan = retrievalPlanOverride ?? compiled.query.retrievalPlan;
  const rankingInput: RankingInput = {
    queryPlan: plan,
    candidates,
    constraints: plan.constraints,
    retrievalPlan,
    compiled,
  };

  const { results: rankedResults, metadata: rankingMetadata } = await ranker.rank(rankingInput);
  const provenanceClosure = buildExecutionProvenanceClosureFromStages(
    compiled.execution.provenancePolicy,
    retrievalProvenanceCoverage
      ?? buildHybridCandidateCoverageStage(
        plan,
        candidates,
        compiled.execution.provenancePolicy,
        compiled.constraintGraph,
      ),
    buildRankedResultCoverageStage(
      plan,
      rankedResults,
      compiled.execution.provenancePolicy,
      compiled.constraintGraph,
    ),
  );
  const rankerDegradation = mergeProvenanceShortfall(
    rankingMetadata.runtimeSignal?.degradation ?? ranker.getLastRuntimeSignal?.()?.degradation,
    provenanceClosure,
  );
  const enrichedRankingMetadata = { ...rankingMetadata, provenanceClosure };
  // Prefer metadata.funnelMetrics (per-call, concurrency-safe) over the legacy
  // getter (instance state, race-prone under concurrent rank() calls).
  const funnelMetrics = enrichedRankingMetadata.funnelMetrics ?? ranker.getLastFunnelMetrics?.();

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
      provenance_satisfied: provenanceClosure.satisfied,
      provenance_missing: provenanceClosure.missing,
    },
    'pipeline hybrid ranking',
  );

  const resolveResult: EntityResolveResult = buildHybridRouteResolveResult(plan, rankedResults);

  return {
    resolveResult,
    rankedResults,
    ...buildHybridExecutionFacts({
      plan,
      compiled,
      sparseExecuted: true,
    }),
    ...(rankerDegradation !== undefined ? { routeDegradation: rankerDegradation } : {}),
    ...(funnelMetrics !== undefined ? { funnelMetrics } : {}),
    rankingMetadata: enrichedRankingMetadata,
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

function resolveRemainingLatencyBudgetMs(
  plan: QueryPlanV1,
  requestContext: RequestExecutionContext | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  const maxLatencyMs = plan.queryBudget?.maxLatencyMs;
  const requestStartTimeMs = requestContext?.requestStartTimeMs;
  if (
    maxLatencyMs === undefined
    || !Number.isFinite(maxLatencyMs)
    || requestStartTimeMs === undefined
    || !Number.isFinite(requestStartTimeMs)
  ) {
    return undefined;
  }

  return maxLatencyMs - Math.max(0, nowMs - requestStartTimeMs);
}

export async function executeHybridRouteRankingPipeline(
  plan: QueryPlanV1,
  deps: HybridRankingRouteDeps,
  resolveEntity: (plan: QueryPlanV1) => Promise<EntityResolveResult>,
  compiled: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
  anchorEntityId?: CanonicalEntityId,
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
    anchorEntityId,
  );
  const ranked = await runHybridRankingPipeline(
    plan,
    retrieval.candidates,
    deps.ranker,
    compiled,
    retrieval.retrievalProvenanceCoverage,
  );

  // No-result recovery: attempt progressive constraint relaxation.
  if (ranked.rankedResults.length === 0 && plan.constraints.hard.length > 0) {
    const ladder = buildRelaxationLadder(plan.constraints);
    const stepsToTry = ladder.slice(0, MAX_RELAXATION_STEPS);
    let abortedDuringRelaxation = false;

    for (const step of stepsToTry) {
      const remainingLatencyBudgetMs = resolveRemainingLatencyBudgetMs(plan, requestContext);
      if (remainingLatencyBudgetMs !== undefined && remainingLatencyBudgetMs <= 0) {
        pipelineDebug(
          {
            step: 'retrieval.constraint_relaxation.skipped_due_to_budget',
            relaxed_attributes: step.relaxedAttributes,
          },
          'pipeline constraint relaxation skipped due to exhausted request budget',
        );
        break;
      }

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

      // Preserve compiled execution facts, but rebuild only the structured
      // retrieval plan from the relaxed constraints. This keeps the retry on
      // the same execution contract (route/mode/budget/provenance policy) while
      // ensuring retrieval filters and boosts reflect the relaxed constraint set.
      const relaxedCompiled = buildRelaxedCompiledQuery(compiled, relaxedPlan);
      const relaxedRetrieval = await retrieveHybridCandidatesForPlan(
        relaxedPlan,
        {
          candidatePool: deps.candidatePool,
          browseRetriever: deps.browseRetriever,
          compareRetriever: deps.compareRetriever,
        },
        resolveEntity,
        relaxedCompiled,
        requestContext,
        anchorEntityId,
      );
      const relaxedRanked = await runHybridRankingPipeline(
        relaxedPlan,
        relaxedRetrieval.candidates,
        deps.ranker,
        relaxedCompiled,
        relaxedRetrieval.retrievalProvenanceCoverage,
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
          ...buildHybridExecutionFactsFromRetrieval(relaxedPlan, relaxedCompiled, relaxedRetrieval),
          routeDegradation: mergedDegradation,
          ...(relaxedRetrieval.specializedRouteObservability !== undefined
            ? { specializedRouteObservability: relaxedRetrieval.specializedRouteObservability }
            : {}),
          // Prefer the relaxed-retrieval fusion trace (it reflects the actual
          // candidates returned), falling back to the original retrieval trace
          // if the relaxed path produced none.
          ...(relaxedRetrieval.retrievalFusionTrace !== undefined
            ? { retrievalFusionTrace: relaxedRetrieval.retrievalFusionTrace }
            : retrieval.retrievalFusionTrace !== undefined
              ? { retrievalFusionTrace: retrieval.retrievalFusionTrace }
              : {}),
          // E4: Prefer the relaxed-retrieval drop log; fall back to original.
          ...(relaxedRetrieval.hardFilterDropLog !== undefined && relaxedRetrieval.hardFilterDropLog.length > 0
            ? { hardFilterDropLog: relaxedRetrieval.hardFilterDropLog }
            : retrieval.hardFilterDropLog !== undefined && retrieval.hardFilterDropLog.length > 0
              ? { hardFilterDropLog: retrieval.hardFilterDropLog }
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
      const remainingLatencyBudgetMs = resolveRemainingLatencyBudgetMs(plan, requestContext);
      const budgetExhaustedDuringRelaxation =
        remainingLatencyBudgetMs !== undefined && remainingLatencyBudgetMs <= 0;
      const exhaustionDegradation: RankingDegradationSignal = {
        executionMode: 'degraded',
        degradationReasons: budgetExhaustedDuringRelaxation
          ? ['constraint_relaxation_budget_exhausted']
          : [`constraint_relaxation_exhausted:${stepsToTry.length}_steps`],
      };
      const mergedWithExhaustion = mergeRouteDegradation(ranked.routeDegradation, exhaustionDegradation);
      return {
        ...ranked,
        ...buildHybridExecutionFactsFromRetrieval(plan, compiled, retrieval),
        routeDegradation: mergedWithExhaustion,
        ...(retrieval.specializedRouteObservability !== undefined
          ? { specializedRouteObservability: retrieval.specializedRouteObservability }
          : {}),
        ...(retrieval.retrievalFusionTrace !== undefined
          ? { retrievalFusionTrace: retrieval.retrievalFusionTrace }
          : {}),
        ...(retrieval.hardFilterDropLog !== undefined && retrieval.hardFilterDropLog.length > 0
          ? { hardFilterDropLog: retrieval.hardFilterDropLog }
          : {}),
      };
    }
  }

  // Normal (non-relaxation) path — merge retrieval + ranking degradations.
  if (retrieval.routeDegradation === undefined) {
    return {
      ...ranked,
      ...buildHybridExecutionFactsFromRetrieval(plan, compiled, retrieval),
      ...(retrieval.specializedRouteObservability !== undefined
        ? { specializedRouteObservability: retrieval.specializedRouteObservability }
        : {}),
      ...(retrieval.retrievalFusionTrace !== undefined
        ? { retrievalFusionTrace: retrieval.retrievalFusionTrace }
        : {}),
      ...(retrieval.hardFilterDropLog !== undefined && retrieval.hardFilterDropLog.length > 0
        ? { hardFilterDropLog: retrieval.hardFilterDropLog }
        : {}),
    };
  }

  return {
    ...ranked,
    ...buildHybridExecutionFactsFromRetrieval(plan, compiled, retrieval),
    routeDegradation: mergeRouteDegradation(ranked.routeDegradation, retrieval.routeDegradation),
    ...(retrieval.specializedRouteObservability !== undefined
      ? { specializedRouteObservability: retrieval.specializedRouteObservability }
      : {}),
    ...(retrieval.retrievalFusionTrace !== undefined
      ? { retrievalFusionTrace: retrieval.retrievalFusionTrace }
      : {}),
    ...(retrieval.hardFilterDropLog !== undefined && retrieval.hardFilterDropLog.length > 0
      ? { hardFilterDropLog: retrieval.hardFilterDropLog }
      : {}),
    // ADR-015 Axis 2: surface the executor-internal critic rewrites
    // (and exhaustion signal) so the post-route phase can thread them
    // into the decision-input contract.
    ...(retrieval.criticObservability !== undefined
      && retrieval.criticObservability.rewrites.length > 0
      ? {
          criticRewrites: projectRewritesForDecisionInput(
            retrieval.criticObservability.rewrites,
          ),
        }
      : {}),
    ...(retrieval.criticObservability?.retriesExhausted === true
      ? { criticRetriesExhausted: true }
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
  compiled: CompiledWineQuery,
): Promise<SearchRouteExecutionResult> {
  return executeHybridRouteRankingPipeline(
    plan,
    deps,
    createRankedRouteEntityResolver(deps, compiled),
    compiled,
  );
}
