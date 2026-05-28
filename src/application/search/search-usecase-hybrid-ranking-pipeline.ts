import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type {
  DualLaneArtifact,
  EntityLaneCandidateArtifact,
  GeneralLaneCandidateArtifact,
} from '../../domain/retrieval/model/dual-lane-artifact.js';
import type { RankingInput } from '../../domain/ranking/model/ranking-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { ResolverCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import type {
  BlockingUseCasePort,
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
  EntityDocumentLookupPort,
  EntityResolverPort,
  RankingPort,
} from './port/search-pipeline-deps.port.js';
import { pipelineDebug } from '../../domain/observability/request-pipeline-debug.js';
import { PipelineDebugStep } from '../../domain/observability/pipeline-debug-steps.js';
import { buildHybridRouteResolveResult } from './search-usecase-hybrid-route.js';
import {
  retrieveHybridCandidatesForPlan,
  projectRewritesForDecisionInput,
  type HybridCandidateRetrievalResult,
} from './search-usecase-hybrid-candidates.js';
import {
  buildEmptySearchExecutionLaneArtifacts,
  buildSearchExecutionLaneTrace,
  type DualLaneRouteResult,
  type GeneralOnlyRouteResult,
  type SearchExecutionLaneArtifacts,
  type SearchRouteExecutionResult,
} from './search-usecase-route-dispatch.js';
import { buildResolverCandidatesFromGenerator } from './search-usecase-resolver-candidates.js';
import { shouldSuppressBlockerSeedExpansion } from './search-usecase-blocker-seed-policy.js';
import { liftEntityResolveResultToLaneArtifacts } from './search-usecase-entity-ranked-results.js';
import type { MultiQueryGenerator } from '../../domain/retrieval/service/multi-query-generator.js';
import type { HydeGenerator } from '../../domain/retrieval/service/hyde-generator.js';
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
  /** Multi-Query Rewrite generator threaded through to
   *  {@link retrieveHybridCandidatesForPlan}. Optional — when absent the
   *  generic hybrid path runs the single-query baseline (current
   *  behaviour). Gated by `WINE_SEARCH_MULTI_QUERY_ENABLED`. */
  readonly multiQueryGenerator?: MultiQueryGenerator | undefined;
  /** HyDE generator — same wiring/gating semantics as
   *  {@link multiQueryGenerator}. */
  readonly hydeGenerator?: HydeGenerator | undefined;
}

export interface RankedRouteEntityResolutionDeps {
  readonly entityResolver?: EntityResolverPort | undefined;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
  /** TA2-4: Optional blocker for seeding candidates beyond alias anchors. */
  readonly blocker?: BlockingUseCasePort | undefined;
}

export interface HybridRankedRoutePipelineDeps
  extends HybridRankingRouteDeps, RankedRouteEntityResolutionDeps {}

export interface DualLaneRouteExecutionArtifacts {
  readonly attemptId: string;
  readonly executionTopology: 'dual_lane';
  readonly identityResolveResult: EntityResolveResult;
  readonly laneArtifacts: SearchExecutionLaneArtifacts<
    EntityLaneCandidateArtifact,
    GeneralLaneCandidateArtifact,
    DualLaneArtifact
  >;
}

export interface HybridRouteRetrievalResult extends HybridCandidateRetrievalResult {
  readonly executionArtifacts?: DualLaneRouteExecutionArtifacts | undefined;
}

export interface EntityRoutePlanResolutionExecution {
  readonly resolveResult: EntityResolveResult;
  readonly resolverCandidates: readonly ResolverCandidate[];
}

export type HybridRouteRetrievalExecutor = (
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
  anchorEntityId?: CanonicalEntityId,
) => Promise<HybridRouteRetrievalResult>;

function buildDualLaneRouteExecutionFacts(
  fusedResolveResult: EntityResolveResult,
  executionArtifacts: DualLaneRouteExecutionArtifacts,
): Pick<
  DualLaneRouteResult,
  'executionTopology'
  | 'identityResolveResult'
  | 'fusedResolveResult'
  | 'laneArtifacts'
  | 'laneTrace'
  | 'dualLaneExecutionAttemptId'
> {
  return {
    executionTopology: 'dual_lane',
    identityResolveResult: executionArtifacts.identityResolveResult,
    fusedResolveResult,
    laneArtifacts: executionArtifacts.laneArtifacts,
    laneTrace: buildSearchExecutionLaneTrace({
      executionTopology: 'dual_lane',
      identityResolveResult: executionArtifacts.identityResolveResult,
      fusedResolveResult,
      laneArtifacts: executionArtifacts.laneArtifacts,
    }),
    dualLaneExecutionAttemptId: executionArtifacts.attemptId,
  };
}

function buildGeneralOnlyRouteExecutionFacts(
  plan: QueryPlanV1,
  fusedResolveResult: EntityResolveResult,
  identityResolutionExecution?: EntityRoutePlanResolutionExecution,
): Pick<
  GeneralOnlyRouteResult,
  'executionTopology'
  | 'identityResolveResult'
  | 'fusedResolveResult'
  | 'laneArtifacts'
  | 'laneTrace'
  > {
  const identityArtifacts = identityResolutionExecution === undefined
    ? []
    : liftEntityResolveResultToLaneArtifacts(
        plan,
        identityResolutionExecution.resolveResult,
        identityResolutionExecution.resolverCandidates,
      );
  const laneArtifacts = {
    ...buildEmptySearchExecutionLaneArtifacts<
      EntityLaneCandidateArtifact,
      GeneralLaneCandidateArtifact,
      DualLaneArtifact
    >(),
    identity: identityArtifacts,
  };
  const identityResolveResult = identityResolutionExecution?.resolveResult ?? null;
  return {
    executionTopology: 'general_only',
    identityResolveResult,
    fusedResolveResult,
    laneArtifacts,
    laneTrace: buildSearchExecutionLaneTrace({
      executionTopology: 'general_only',
      identityResolveResult,
      fusedResolveResult,
      laneArtifacts,
    }),
  };
}

function bindHybridRankingExecutionContract(
  compiled: CompiledWineQuery,
  executionArtifacts?: DualLaneRouteExecutionArtifacts,
): (
  | {
      readonly executionTopology: 'general_only';
      readonly executionArtifacts?: undefined;
    }
  | {
      readonly executionTopology: 'dual_lane';
      readonly executionArtifacts: DualLaneRouteExecutionArtifacts;
    }
) {
  switch (compiled.execution.executionTopology) {
    case 'general_only':
      if (executionArtifacts !== undefined) {
        throw new Error(
          'General-only hybrid ranking pipeline cannot receive dual-lane execution artifacts',
        );
      }
      return { executionTopology: 'general_only' };
    case 'dual_lane':
      if (executionArtifacts === undefined) {
        throw new Error(
          'Dual-lane hybrid ranking pipeline requires dual-lane execution artifacts',
        );
      }
      return {
        executionTopology: 'dual_lane',
        executionArtifacts,
      };
    case 'entity_only':
      throw new Error('Hybrid ranking pipeline cannot execute with executionTopology=entity_only');
    default: {
      const _exhaustive: never = compiled.execution.executionTopology;
      throw new Error(`Unhandled hybrid ranking execution topology: ${String(_exhaustive)}`);
    }
  }
}

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
      // The missing-resolver fallback never invoked the trained Calibrator,
      // so `decisionConfidenceC=0` is a sentinel, not a calibrated
      // probability. Flag the trace as untrusted so the AdmissionGate's
      // confidence-refusal floor (RFC-016 §3, Epic 17.3) skips enforcement
      // instead of refusing the sentinel against a fixed threshold.
      calibrationTrusted: false,
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
  retrieval: HybridRouteRetrievalResult,
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
export async function resolveEntityRouteForPlanExecution(
  plan: QueryPlanV1,
  deps: RankedRouteEntityResolutionDeps,
  compiled: CompiledWineQuery,
): Promise<EntityRoutePlanResolutionExecution> {
  if (deps.entityResolver === undefined) {
    pipelineDebug(
      { step: PipelineDebugStep.RESOLVER_ANCHOR_MISSING, query_class: plan.queryClass },
      'pipeline hybrid anchor resolver unavailable',
    );
    return {
      resolveResult: buildMissingEntityResolverResult(plan),
      resolverCandidates: [],
    };
  }

  // TA2-4: Invoke blocker to surface entity IDs not covered by alias anchors.
  let blockerOnlyIds: readonly CanonicalEntityId[] = [];
  if (
    deps.blocker !== undefined
    && !shouldSuppressBlockerSeedExpansion(plan.anchors)
  ) {
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

  const resolveResult = await deps.entityResolver.resolve({
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
      resolve_status: resolveResult.status,
      candidate_count: resolveResult.candidates.length,
    },
    'pipeline hybrid anchor resolve',
  );

  return {
    resolveResult,
    resolverCandidates: candidateEntities,
  };
}

export async function resolveEntityRouteForPlan(
  plan: QueryPlanV1,
  deps: RankedRouteEntityResolutionDeps,
  compiled: CompiledWineQuery,
): Promise<EntityResolveResult> {
  const { resolveResult } = await resolveEntityRouteForPlanExecution(
    plan,
    deps,
    compiled,
  );
  return resolveResult;
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
  requestContext?: RequestExecutionContext,
  executionArtifacts?: DualLaneRouteExecutionArtifacts,
  generalOnlyIdentityExecution?: EntityRoutePlanResolutionExecution,
): Promise<GeneralOnlyRouteResult | DualLaneRouteResult> {
  const retrievalPlan = retrievalPlanOverride ?? compiled.query.retrievalPlan;
  const rankingInput: RankingInput = {
    queryPlan: plan,
    candidates,
    constraints: plan.constraints,
    retrievalPlan,
    compiled,
    ...(requestContext !== undefined ? { requestContext } : {}),
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

  const executionContract = bindHybridRankingExecutionContract(compiled, executionArtifacts);
  const generalOnlyIdentityArtifacts = generalOnlyIdentityExecution === undefined
    ? undefined
    : {
        ...buildEmptySearchExecutionLaneArtifacts<
          EntityLaneCandidateArtifact,
          GeneralLaneCandidateArtifact,
          DualLaneArtifact
        >(),
        identity: liftEntityResolveResultToLaneArtifacts(
          plan,
          generalOnlyIdentityExecution.resolveResult,
          generalOnlyIdentityExecution.resolverCandidates,
        ),
      };
  const fusedResolveResult: EntityResolveResult = buildHybridRouteResolveResult(
    plan,
    rankedResults,
    {
      executionTopology: executionContract.executionTopology,
      effectiveRetrievalMode: compiled.execution.effectiveRetrievalMode,
      ...(executionContract.executionArtifacts !== undefined
        ? {
            identityCalibration: {
              identityResolveResult: executionContract.executionArtifacts.identityResolveResult,
              laneArtifacts: executionContract.executionArtifacts.laneArtifacts,
            },
          }
        : generalOnlyIdentityArtifacts !== undefined
          ? {
              identityCalibration: {
                identityResolveResult: generalOnlyIdentityExecution!.resolveResult,
                laneArtifacts: generalOnlyIdentityArtifacts,
              },
            }
          : {}),
    },
  );
  const executionFacts = buildHybridExecutionFacts({
    plan,
    compiled,
    sparseExecuted: true,
  });

  if (executionContract.executionTopology === 'dual_lane') {
    const dualLaneExecutionArtifacts = executionContract.executionArtifacts;
    return {
      executedPlan: plan,
      executedCompiled: compiled,
      ...buildDualLaneRouteExecutionFacts(
        fusedResolveResult,
        dualLaneExecutionArtifacts,
      ),
      rankedResults,
      ...executionFacts,
      ...(rankerDegradation !== undefined ? { routeDegradation: rankerDegradation } : {}),
      ...(funnelMetrics !== undefined ? { funnelMetrics } : {}),
      rankingMetadata: enrichedRankingMetadata,
    };
  }
  return {
    executedPlan: plan,
    executedCompiled: compiled,
    ...buildGeneralOnlyRouteExecutionFacts(plan, fusedResolveResult, generalOnlyIdentityExecution),
    rankedResults,
    ...executionFacts,
    ...(rankerDegradation !== undefined ? { routeDegradation: rankerDegradation } : {}),
    ...(funnelMetrics !== undefined ? { funnelMetrics } : {}),
    rankingMetadata: enrichedRankingMetadata,
  };
}

function shouldBootstrapGeneralOnlyIdentityExecution(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
): boolean {
  return compiled.execution.executionTopology === 'general_only'
    && compiled.execution.provenancePolicy.requireIdentitySeal
    && plan.anchors.length > 0;
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
  deps: HybridRankedRoutePipelineDeps,
  resolveEntity: (plan: QueryPlanV1) => Promise<EntityResolveResult>,
  compiled: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
  anchorEntityId?: CanonicalEntityId,
  retrievalExecutor?: HybridRouteRetrievalExecutor,
): Promise<GeneralOnlyRouteResult | DualLaneRouteResult> {
  if (compiled.execution.executionTopology === 'entity_only') {
    throw new Error('Hybrid route ranking pipeline cannot execute with executionTopology=entity_only');
  }

  const generalOnlyIdentityExecution = shouldBootstrapGeneralOnlyIdentityExecution(plan, compiled)
    && deps.entityResolver !== undefined
    ? await resolveEntityRouteForPlanExecution(plan, deps, compiled)
    : undefined;
  const effectiveAnchorEntityId =
    anchorEntityId ?? generalOnlyIdentityExecution?.resolveResult.topEntity?.entityId;

  const executeRetrieval: HybridRouteRetrievalExecutor =
    retrievalExecutor
    ?? ((retrievalPlan, retrievalCompiled, retrievalRequestContext, retrievalAnchorEntityId) =>
      retrieveHybridCandidatesForPlan(
        retrievalPlan,
        {
          candidatePool: deps.candidatePool,
          browseRetriever: deps.browseRetriever,
          compareRetriever: deps.compareRetriever,
          ...(deps.multiQueryGenerator !== undefined
            ? { multiQueryGenerator: deps.multiQueryGenerator }
            : {}),
          ...(deps.hydeGenerator !== undefined
            ? { hydeGenerator: deps.hydeGenerator }
            : {}),
        },
        resolveEntity,
        retrievalCompiled,
        retrievalRequestContext,
        retrievalAnchorEntityId,
      ));
  const stageTimer = requestContext?.stageTimer;
  stageTimer?.start('hybrid.retrieval');
  const retrieval = await executeRetrieval(
    plan,
    compiled,
    requestContext,
    effectiveAnchorEntityId,
  );
  stageTimer?.end('hybrid.retrieval');

  stageTimer?.start('hybrid.ranking');
  const ranked = await runHybridRankingPipeline(
    plan,
    retrieval.candidates,
    deps.ranker,
    compiled,
    retrieval.retrievalProvenanceCoverage,
    undefined,
    requestContext,
    retrieval.executionArtifacts,
    generalOnlyIdentityExecution,
  );
  stageTimer?.end('hybrid.ranking');

  // No-result recovery: attempt progressive constraint relaxation.
  if (ranked.rankedResults.length === 0 && plan.constraints.hard.length > 0) {
    stageTimer?.start('hybrid.constraint_relaxation');
    const ladder = buildRelaxationLadder(plan.constraints);
    const stepsToTry = ladder.slice(0, MAX_RELAXATION_STEPS);
    let abortedDuringRelaxation = false;

    for (const step of stepsToTry) {
      const remainingLatencyBudgetMs = resolveRemainingLatencyBudgetMs(plan, requestContext);
      if (remainingLatencyBudgetMs !== undefined && remainingLatencyBudgetMs <= 0) {
        pipelineDebug(
          {
            step: PipelineDebugStep.RETRIEVAL_CONSTRAINT_RELAXATION_SKIPPED_BUDGET,
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
          { step: PipelineDebugStep.RETRIEVAL_CONSTRAINT_RELAXATION_ABORTED, relaxed_attributes: step.relaxedAttributes },
          'pipeline constraint relaxation aborted by request signal',
        );
        abortedDuringRelaxation = true;
        break;
      }

      pipelineDebug(
        {
          step: PipelineDebugStep.RETRIEVAL_CONSTRAINT_RELAXATION_ATTEMPT,
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
        const relaxedRetrieval = await executeRetrieval(
          relaxedPlan,
          relaxedCompiled,
          requestContext,
          effectiveAnchorEntityId,
        );
        const relaxedRanked = await runHybridRankingPipeline(
          relaxedPlan,
          relaxedRetrieval.candidates,
          deps.ranker,
        relaxedCompiled,
          relaxedRetrieval.retrievalProvenanceCoverage,
          undefined,
          requestContext,
          relaxedRetrieval.executionArtifacts,
          generalOnlyIdentityExecution,
        );

      if (relaxedRanked.rankedResults.length > 0) {
        stageTimer?.end('hybrid.constraint_relaxation');
        pipelineDebug(
          {
            step: PipelineDebugStep.RETRIEVAL_CONSTRAINT_RELAXATION_SUCCESS,
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
          executedPlan: relaxedPlan,
          executedCompiled: relaxedCompiled,
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
      stageTimer?.end('hybrid.constraint_relaxation');
      throwIfAborted(requestContext?.abortSignal, 'Hybrid route ranking pipeline aborted during constraint relaxation');
    }

    stageTimer?.end('hybrid.constraint_relaxation');
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
        executedPlan: plan,
        executedCompiled: compiled,
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

  // Note: stageTimer.end called here covers ALL exit paths from the relaxation block
  // (success-with-results, abort, and all-steps-exhausted all return above, so
  // this line only executes for the "entered the block but stepsToTry was empty"
  // edge case, which is fine — start/end are idempotent on missing names).
  stageTimer?.end('hybrid.constraint_relaxation');

  // Normal (non-relaxation) path — merge retrieval + ranking degradations.
  if (retrieval.routeDegradation === undefined) {
    return {
      ...ranked,
      executedPlan: plan,
      executedCompiled: compiled,
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
    executedPlan: plan,
    executedCompiled: compiled,
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
