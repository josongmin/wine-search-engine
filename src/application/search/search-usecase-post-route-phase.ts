import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type {
  ExecutionLaneTrace,
  ExecutionRetrievalMode,
  ExecutionTopology,
} from '../../domain/query/model/engine-execution-contract.js';
import type { CandidateDropRecord } from '../../domain/retrieval/model/candidate-envelope.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { RankingMetadata } from '../../domain/ranking/port/ranker.port.js';
import type { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import type { RrfFusionTrace } from '../../domain/retrieval/model/candidate-envelope.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { DecisionEnginePort, ResponseBuilderPort } from './port/search-pipeline-deps.port.js';
import type { SearchRequest } from './search-request.dto.js';
import type { SearchRouteDecisionContext } from './search-usecase-route-dispatch.js';
import type {
  SearchExecutionLaneArtifacts,
  SearchRouteRetrievalKind,
} from './search-usecase-route-dispatch.js';
import { buildEntropyAbstainResponseParams } from './search-usecase-execute-builders.js';
import { buildSearchCacheRequestContext } from './search-usecase-cache-context.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { isCorruptedSnapshot } from '../../domain/shared/types/index.js';
import { ConstraintReasoner } from '../../domain/query/service/constraint-reasoner.js';
import type { ChannelDegradationSummary } from '../../domain/query/model/abstain-decision.js';
import { buildAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import { deriveDecisionConfidenceSemantics } from '../../domain/shared/types/index.js';
import { evaluateAdmissionClosure } from '../../domain/decision/service/admission-gate.js';
import { DomainError, EvidenceObligationError } from '../../domain/shared/error/domain-error.js';
import { buildSearchCounterfactuals } from './search-usecase-counterfactuals.js';
import {
  planToObservabilitySlice,
} from '../../domain/query/model/query-observability-vocab.js';
import { buildSearchDecisionInput } from './search-usecase-decision-input.js';
import type {
  DecisionInputCriticRewrite,
} from '../../domain/decision/model/decision-input.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { rankedResultsToEvalProvenanceSlices } from './search-usecase-eval-provenance.js';
import { mapRankedResultsToResultItems } from './search-usecase-map-result-items.js';
import {
  extractSensoryPriorsFromConstraints,
  extractSensoryPriorsFromRetrievalPlan,
} from './extract-sensory-priors.js';
import { topKFinalScores } from './search-usecase-ranking-scores.js';
import type { SnapshotVersionInjection } from './search-usecase-cache-lookup.js';
import { pipelineDebug } from '../../domain/observability/request-pipeline-debug.js';
import { PipelineDebugStep } from '../../domain/observability/pipeline-debug-steps.js';
import { logSearchEvent } from '../../domain/observability/log-search-event.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import {
  toSpecializedRouteMeta,
  type SpecializedRouteObservability,
} from './specialized-route-observability.js';
import { classifyShortfallLayer } from '../../domain/shared/types/provenance-shortfall-taxonomy.js';
import {
  selectDisplayRankedResultsForDecision,
  resolveResultItemMappingOptions,
  resolveTargetYear,
  shouldIncludeCounterfactualsForRequest,
  toAdmissionHonestyContract,
  buildResponseExecutionContract,
} from './post-route-phase-helpers.js';
import {
  deriveAuditExtension,
  buildExecutionAuditTrace,
  shouldEmitConstraintResolutionTrace,
  buildConstraintResolutionTrace,
  buildDeterminismFingerprintParams,
  buildResolverProvenanceTrace,
  mergeRouteDegradation,
} from './post-route-phase-audit-extension.js';
import {
  resolveWinnerAlignedDualLaneArtifact,
  resolveWinnerAlignedIdentityArtifact,
} from './post-route-phase-lane-artifacts.js';

// Re-exported so existing importers (and tests) keep the original module path.
export { selectDisplayRankedResultsForDecision };

/**
 * Context for Steps 3b–7: entropy abstain → DecisionEngine → ResponseBuilder → optional cache write.
 */
interface SearchPostRouteExecutionContext {
  readonly plan: QueryPlanV1;
  /** Compiled execution contract from ExecutionCompiler (E1-U3 carrier).
   *  T-E2-01: Required in production — downstream phases read route/mode from compiled only. */
  readonly compiled: CompiledWineQuery;
  readonly request: SearchRequest;
  readonly requestId: string;
  readonly startTime: number;
  readonly resolveResult: EntityResolveResult;
  readonly identityResolveResult: EntityResolveResult | null;
  readonly rankedResults: readonly RankedResult[];
  readonly decisionContext?: SearchRouteDecisionContext | undefined;
  readonly effectiveRoute: QueryRoute;
  readonly plannerSuggestedMode: ExecutionRetrievalMode;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly abstainPolicy: AbstainPolicy;
  readonly snapshotVersions: SnapshotVersionInjection;
  readonly drinkingWindow?: DrinkingWindowUseCasePort | undefined;
  readonly decisionEngine: DecisionEnginePort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly cacheService?: SearchResponseCachePort | undefined;
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly rankingMetadata?: RankingMetadata | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
  readonly executionTopology: ExecutionTopology;
  readonly laneTrace: ExecutionLaneTrace;
  readonly laneArtifacts: SearchExecutionLaneArtifacts;
  /** Route-execution facts propagated from dispatch/ranking. */
  readonly effectiveRetrievalMode: ExecutionRetrievalMode;
  readonly retrievalKind: SearchRouteRetrievalKind;
  readonly sparseExecuted: boolean;
  readonly specializedRouteExecuted: SpecializedRouteObservability['specializedRouteExecuted'];
  readonly usedCompiledExecution: boolean;
  /** E4: RRF fusion trace from CandidatePoolService, when hybrid path was used. */
  readonly retrievalFusionTrace?: RrfFusionTrace | undefined;
  /** E4: Hard-filter drop log from CandidatePoolService.getLastDropLog(). */
  readonly hardFilterDropLog?: readonly CandidateDropRecord[] | undefined;
  /** When true (options.explain=true), counterfactuals are always included. */
  readonly includeCounterfactuals?: boolean | undefined;
  /**
   * ADR-015 Axis 2: critic rewrite trace forwarded from the ranking
   * pipeline. Threaded into `buildSearchDecisionInput.executionContext`
   * so the decision input carries the full critic-loop history.
   */
  readonly criticRewrites?: readonly DecisionInputCriticRewrite[] | undefined;
  readonly criticRetriesExhausted?: boolean | undefined;
  /**
   * Per-stage latency snapshot from the request-scoped StageTimer.
   * Threaded to ResponseBuilder so it can be included in SearchResponseV1.
   */
  readonly stageTimings?: Readonly<Record<string, number>> | undefined;
}

export interface RankedRouteDecisionPhaseContext {
  readonly plan: QueryPlanV1;
  /** Compiled execution contract (E1-U3 carrier). T-E2-01: Required — passed to ResponseBuilder. */
  readonly compiled: CompiledWineQuery;
  readonly requestId: string;
  readonly startTime: number;
  /**
   * Deterministic "current year" used for drinking-window currentlyDrinkable
   * computation. When omitted, defaults to `new Date(startTime).getFullYear()`
   * — a SINGLE wall-clock read per request, at the request boundary. Replay
   * harnesses MUST provide this field (e.g. from the pinned snapshot) to
   * guarantee byte-identical responses across replay runs; otherwise a query
   * replayed across a year boundary would silently produce different
   * `currentlyDrinkable` flags even with an identical decision snapshot.
   */
  readonly nowYear?: number | undefined;
  readonly resolveResult: EntityResolveResult;
  readonly identityResolveResult: EntityResolveResult | null;
  /**
   * Visible ranked results (after caller-specified limit). Used for the
   * `results` array shipped to the client.
   */
  readonly rankedResults: readonly RankedResult[];
  /**
   * Full unlimited ranked results — REQUIRED. Used for counterfactuals and
   * provenance slices that must reflect the entire retrieval pool, not the
   * visible limit. Pass the same array as `rankedResults` if no limit applied.
   *
   * Required (not optional) so callers cannot silently revert to the broken
   * pre-fix behavior where counterfactuals were trimmed to the visible limit.
   */
  readonly fullRankedResults: readonly RankedResult[];
  readonly decisionContext?: SearchRouteDecisionContext | undefined;
  readonly effectiveRoute: QueryRoute;
  readonly snapshotVersions: SnapshotVersionInjection;
  readonly drinkingWindow?: DrinkingWindowUseCasePort | undefined;
  readonly decisionEngine: DecisionEnginePort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly retrievalModeSource?: 'planner' | 'api_override' | undefined;
  readonly plannerSuggestedMode?: ExecutionRetrievalMode | undefined;
  readonly includeCounterfactuals?: boolean | undefined;
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly rankingMetadata?: RankingMetadata | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
  readonly executionTopology: ExecutionTopology;
  readonly laneTrace: ExecutionLaneTrace;
  readonly laneArtifacts: SearchExecutionLaneArtifacts;
  readonly effectiveRetrievalMode: ExecutionRetrievalMode;
  readonly retrievalKind: SearchRouteRetrievalKind;
  readonly sparseExecuted: boolean;
  readonly specializedRouteExecuted: SpecializedRouteObservability['specializedRouteExecuted'];
  readonly usedCompiledExecution: boolean;
  /** E4: RRF fusion trace from the candidate pool, forwarded from the calling context. */
  readonly retrievalFusionTrace?: RrfFusionTrace | undefined;
  /** E4: Hard-filter drop log from CandidatePoolService.getLastDropLog(). */
  readonly hardFilterDropLog?: readonly CandidateDropRecord[] | undefined;
  /**
   * ADR-015 Axis 2: critic rewrite trace forwarded from the ranking
   * pipeline through the route execution result. Optional; absent when
   * the critic loop did not engage.
   */
  readonly criticRewrites?: readonly DecisionInputCriticRewrite[] | undefined;
  readonly criticRetriesExhausted?: boolean | undefined;
  /**
   * Per-stage latency snapshot from the request-scoped StageTimer.
   * Threaded to ResponseBuilder so it can be included in SearchResponseV1.
   */
  readonly stageTimings?: Readonly<Record<string, number>> | undefined;
}

function assertSearchRouteExecutionFacts(
  ctx: SearchPostRouteExecutionContext,
): {
  readonly executionTopology: ExecutionTopology;
  readonly laneTrace: ExecutionLaneTrace;
  readonly effectiveRetrievalMode: ExecutionRetrievalMode;
  readonly retrievalKind: SearchRouteRetrievalKind;
  readonly sparseExecuted: boolean;
  readonly specializedRouteExecuted: SpecializedRouteObservability['specializedRouteExecuted'];
  readonly usedCompiledExecution: boolean;
} {
  return {
    executionTopology: ctx.executionTopology,
    laneTrace: ctx.laneTrace,
    effectiveRetrievalMode: ctx.effectiveRetrievalMode,
    retrievalKind: ctx.retrievalKind,
    sparseExecuted: ctx.sparseExecuted,
    specializedRouteExecuted: ctx.specializedRouteExecuted,
    usedCompiledExecution: ctx.usedCompiledExecution,
  };
}

/**
 * Shared ranked-route post-processing once route execution is finished:
 * decision input → DecisionEngine → result mapping → response assembly.
 */
export async function runRankedRouteDecisionPhase(
  ctx: RankedRouteDecisionPhaseContext,
): Promise<SearchResponseV1> {
  pipelineDebug(
    {
      step: PipelineDebugStep.DECISION_PHASE_ENTER,
      effective_route: ctx.effectiveRoute,
      resolve_status: ctx.resolveResult.status,
      ranked_count: ctx.rankedResults.length,
    },
    'pipeline decision phase',
  );

  const snapshot = buildDecisionSnapshotFromPlan(ctx.plan, ctx.snapshotVersions);
  const constraintReasonerOutput = new ConstraintReasoner().reason(ctx.plan.constraints);
  const mergedRouteDegradation = mergeRouteDegradation(
    snapshot,
    ctx.effectiveRoute,
    ctx.routeDegradation,
    ctx.resolveResult,
  );
  const winnerDualLaneArtifact = resolveWinnerAlignedDualLaneArtifact({
    executionTopology: ctx.executionTopology,
    identityResolveResult: ctx.identityResolveResult,
    resolveResult: ctx.resolveResult,
    fusedArtifacts: ctx.laneArtifacts.fused,
  });
  const winnerIdentityArtifact = resolveWinnerAlignedIdentityArtifact({
    executionTopology: ctx.executionTopology,
    identityResolveResult: ctx.identityResolveResult,
    resolveResult: ctx.resolveResult,
    identityArtifacts: ctx.laneArtifacts.identity,
  });
  const compiledCategoriesCovered =
    ctx.compiled.query.constraintExtraction?.categoriesCovered;
  const decisionInputBase = buildSearchDecisionInput({
    plan: ctx.plan,
    resolveResult: ctx.resolveResult,
    identityResolveResult: ctx.identityResolveResult ?? undefined,
    rankedResults: ctx.rankedResults,
    effectiveRoute: ctx.effectiveRoute,
    decisionContext: ctx.decisionContext,
    executionContext: {
      effectiveRetrievalMode: ctx.effectiveRetrievalMode,
      retrievalKind: ctx.retrievalKind,
      provenancePolicy: ctx.compiled.execution.provenancePolicy,
      ...(winnerDualLaneArtifact !== undefined ? { winnerDualLaneArtifact } : {}),
      ...(winnerIdentityArtifact !== undefined ? { winnerIdentityArtifact } : {}),
      ...(ctx.compiled.constraintGraph !== undefined
        ? { constraintGraph: ctx.compiled.constraintGraph }
        : {}),
      ...(ctx.criticRewrites !== undefined && ctx.criticRewrites.length > 0
        ? { criticRewrites: ctx.criticRewrites }
        : {}),
      // PlannerV1Adapter strips constraintExtraction from V1; surface
      // categoriesCovered from the compiled query so the decision-engine's
      // preference-mode unlock + CalibrationTrustGate exploratory bypass
      // can see the constraint extractor's semantic signal. Empty list
      // dropped to keep diffs minimal on noise queries.
      ...(compiledCategoriesCovered !== undefined && compiledCategoriesCovered.length > 0
        ? { categoriesCovered: compiledCategoriesCovered }
        : {}),
    },
    honestyContract: toAdmissionHonestyContract(mergedRouteDegradation),
  });
  // Propagate LTR saturation to decision engine so it can bypass
  // conformal prediction gating (calibrated on LTR, meaningless for heuristic).
  const decisionInput = ctx.rankingMetadata?.ltrSaturated === true
    ? { ...decisionInputBase, ltrSaturated: true }
    : decisionInputBase;
  const admissionClosure = evaluateAdmissionClosure(decisionInput, snapshot);
  pipelineDebug(
    {
      step: PipelineDebugStep.DECISION_ENGINE_REQUEST,
      query_class: ctx.plan.queryClass,
    },
    'pipeline decision engine request',
  );

  // Decision engine failures are pipeline defects — the "final authority"
  // crashed. Propagate to the HTTP error handler as a 500, not a fabricated
  // 200 with decisionStatus:'failed'. The prior code here built a hand-rolled
  // "degraded" SearchResponseV1 that the route emitted as 200, blinding
  // monitoring, SLOs, and client retry logic.
  const decisionOutput = await ctx.decisionEngine.decide(decisionInput, snapshot);

  pipelineDebug(
    {
      step: PipelineDebugStep.DECISION_ENGINE_RESPONSE,
      decision_status: decisionOutput.decisionStatus,
      next_action: decisionOutput.nextAction,
      decision_confidence: decisionOutput.decisionConfidence,
      ...(decisionOutput.failureReason !== undefined
        ? { failure_reason: decisionOutput.failureReason }
        : {}),
    },
    'pipeline decision engine response',
  );

  const queryTimeMs = Date.now() - ctx.startTime;
  // RFC-019 Phase 7: Extract query-level sensory priors from compositional
  // inference so wines with sparse indexed sensory attributes can still
  // trigger drinking window prediction.
  const sensoryPriors =
    extractSensoryPriorsFromRetrievalPlan(ctx.compiled.query.retrievalPlan)
    ?? extractSensoryPriorsFromConstraints(ctx.plan.constraints);
  const displayRankedResults = selectDisplayRankedResultsForDecision(
    ctx.rankedResults,
    decisionOutput,
    ctx.retrievalKind,
  );
  const results = await mapRankedResultsToResultItems(
    displayRankedResults,
    ctx.drinkingWindow,
    resolveTargetYear(ctx),
    sensoryPriors,
    resolveResultItemMappingOptions(ctx.effectiveRetrievalMode),
  );
  // Provenance slices and counterfactuals MUST use the full retrieval pool,
  // not the limited result set. Otherwise:
  // - eval analytics see only top-N channels (silent narrowing of provenance);
  // - counterfactuals beyond the visible window disappear (E4-U5 transparency
  //   regression on small `limit` values).
  const retrievalProvenanceSlices = rankedResultsToEvalProvenanceSlices(
    ctx.requestId,
    ctx.fullRankedResults,
  );
  // E4-U5: Consult explanation obligation map for the query family.
  // - If obligation.requiresCounterfactual: counterfactuals MUST be included
  //   (override even if ctx.includeCounterfactuals is false).
  // - Otherwise respect ctx.includeCounterfactuals (default true —
  //   backward-compatible; caller can explicitly suppress with `false`).
  // Symmetric across query families: the prior comparison-only `=== true`
  // special case was an undocumented asymmetry and has been removed.
  const shouldIncludeCounterfactuals = shouldIncludeCounterfactualsForRequest(
    ctx.plan,
    ctx.compiled,
    ctx.includeCounterfactuals,
  );
  const MAX_COUNTERFACTUALS = 100;
  const counterfactuals = shouldIncludeCounterfactuals
    ? buildSearchCounterfactuals(ctx.resolveResult, ctx.fullRankedResults).slice(0, MAX_COUNTERFACTUALS)
    : [];

  /**
   * E6-U2: Quality Gate Wiring — compiled fields forwarded to quality gate
   * Fields from SearchPostRouteExecutionContext forwarded to EvidenceGate:
   *   - evidenceQuality (from decision input)
   *   - rerank suppression flag (from typed rerank decision code)
   * Do NOT pass raw scores or internal ranker state to the quality gate.
   * compiled.execution.effectiveRoute/effectiveRetrievalMode are forwarded via ResponseBuildParams.
   */
  // In the non-abstain ranked path, fusion trace is forwarded from ctx; abstain
  // decision is false (not abstaining), so abstain_policy_trace is omitted here.
  // E4: hard_filter_drop_log is forwarded from ctx when available (hybrid path).
  const auditExtension = deriveAuditExtension(
    ctx.compiled,
    ctx.rankingMetadata,
    ctx.fullRankedResults,
    buildExecutionAuditTrace(
      ctx.effectiveRoute,
      ctx.retrievalModeSource ?? 'planner',
      {
        executionTopology: ctx.executionTopology,
        laneTrace: ctx.laneTrace,
        effectiveRetrievalMode: ctx.effectiveRetrievalMode,
        retrievalKind: ctx.retrievalKind,
        sparseExecuted: ctx.sparseExecuted,
        specializedRouteExecuted: ctx.specializedRouteExecuted,
        usedCompiledExecution: ctx.usedCompiledExecution,
      },
      ctx.rankingMetadata,
      ctx.compiled,
    ),
    ctx.retrievalFusionTrace,
    shouldEmitConstraintResolutionTrace(ctx.compiled)
      ? buildConstraintResolutionTrace(constraintReasonerOutput)
      : undefined,
    undefined,          // abstainDecision — no abstain in ranked path
    undefined,          // channelDegradation — not available in ranked phase context
    ctx.hardFilterDropLog,
    buildResolverProvenanceTrace(ctx.resolveResult),
  );
  let built: SearchResponseV1;
  try {
    built = ctx.responseBuilder.build({
      queryPlan: ctx.plan,
      compiled: ctx.compiled,
      decisionOutput,
      results,
      ...(counterfactuals.length > 0 ? { counterfactuals } : {}),
      ...(retrievalProvenanceSlices.length > 0 ? { retrievalProvenanceSlices } : {}),
      requestId: ctx.requestId,
      queryTimeMs,
      route: ctx.effectiveRoute,
      ...(ctx.retrievalModeSource !== undefined
        ? { retrievalModeSource: ctx.retrievalModeSource }
        : {}),
      ...(ctx.plannerSuggestedMode !== undefined
        ? { plannerSuggestedMode: ctx.plannerSuggestedMode }
        : {}),
      ...(mergedRouteDegradation !== undefined ? { contract: mergedRouteDegradation } : {}),
      ...(ctx.specializedRouteObservability !== undefined
        ? { specializedRouteObservability: ctx.specializedRouteObservability }
        : {}),
      executionContract: buildResponseExecutionContract(
        {
          executionTopology: ctx.executionTopology,
          laneTrace: ctx.laneTrace,
          effectiveRetrievalMode: ctx.effectiveRetrievalMode,
          retrievalKind: ctx.retrievalKind,
          sparseExecuted: ctx.sparseExecuted,
          specializedRouteExecuted: ctx.specializedRouteExecuted,
          usedCompiledExecution: ctx.usedCompiledExecution,
        },
        ctx.rankingMetadata,
        admissionClosure,
      ),
      ...(auditExtension !== undefined ? { auditExtension } : {}),
      determinismFingerprintParams: buildDeterminismFingerprintParams(
        snapshot,
        ctx.snapshotVersions,
        ctx.plan,
        ctx.compiled,
        ctx.rankingMetadata,
      ),
      ...(ctx.stageTimings !== undefined ? { stageTimings: ctx.stageTimings } : {}),
    });
  } catch (buildErr) {
    if (buildErr instanceof EvidenceObligationError) {
      throw buildErr;
    }
    // MUST NOT fabricate a 200 OK response for unexpected infrastructure failures
    // (Redis down, OOM, nil dereference, etc.). Per CLAUDE.md schema quality bar:
    // "Catch blocks in use-case code MUST NOT fabricate success-shaped (200 OK)
    // responses from unexpected errors."  Re-throw as DomainError so the HTTP
    // error handler maps it to 500 + RFC-014 envelope (mirrors search.usecase.ts).
    const errorMessage = buildErr instanceof Error ? buildErr.message : String(buildErr);
    bootstrapLogger.error(
      { requestId: ctx.requestId, err: buildErr },
      '[runRankedRouteDecisionPhase] responseBuilder.build() threw unexpectedly — propagating as 500',
    );
    throw new DomainError(
      'INTERNAL_INCONSISTENCY',
      `Response building failed unexpectedly: ${errorMessage}`,
    );
  }
  /* Unit tests may stub partial SearchResponseV1; skip structured log when snapshot missing. */
  const engineDecision = built.engineDecision as SearchResponseV1['engineDecision'] | undefined;
  const decisionSnapshot = engineDecision?.decisionSnapshot;
  if (decisionSnapshot !== undefined && !isCorruptedSnapshot(decisionSnapshot)) {
    logSearchEvent({
      ...(built.meta.authorityTraceRef !== undefined
        ? { authority_trace_ref: built.meta.authorityTraceRef }
        : {}),
      runtime_correlation_ref: built.meta.runtimeCorrelationRef ?? ctx.requestId,
      ...(built.meta.executionMode !== undefined ? { execution_mode: built.meta.executionMode } : {}),
      ...(built.meta.degradationReasons !== undefined
        ? { degradation_reasons: built.meta.degradationReasons }
        : {}),
      ...toSpecializedRouteMeta(ctx.specializedRouteObservability),
      route_name: ctx.effectiveRoute,
      model_versions: { ...decisionSnapshot.model_versions },
      kill_switch_state: { ...decisionSnapshot.feature_flags },
    });
  }
  return built;
}

/**
 * After route execution: RFC-013 entropy gate, then decision + response + Wave 4 cache populate.
 */
export async function runSearchPostRoutePhase(
  ctx: SearchPostRouteExecutionContext,
): Promise<SearchResponseV1> {
  pipelineDebug(
    {
      step: PipelineDebugStep.POST_ROUTE_ENTER,
      effective_route: ctx.effectiveRoute,
      resolve_status: ctx.resolveResult.status,
      ranked_count: ctx.rankedResults.length,
    },
    'pipeline post-route',
  );

  const cacheRequestContext = buildSearchCacheRequestContext(ctx.request);
  const routeExecutionFacts = assertSearchRouteExecutionFacts(ctx);
  const executionAuditTrace = buildExecutionAuditTrace(
    ctx.effectiveRoute,
    ctx.retrievalModeSource,
    routeExecutionFacts,
    ctx.rankingMetadata,
    ctx.compiled,
  );

  // Compute snapshot and degradation once — shared by both abstain and ranked paths.
  const snapshot = buildDecisionSnapshotFromPlan(ctx.plan, ctx.snapshotVersions);
  const mergedRouteDegradation = mergeRouteDegradation(
    snapshot,
    ctx.effectiveRoute,
    ctx.routeDegradation,
    ctx.resolveResult,
  );

  // Entity route now synthesizes RankedResults from resolver-backed entity
  // documents, but keep the resolver-score fallback for legacy tests and any
  // partial call sites that still pass rankedResults=[].
  const topScoreSource = ctx.rankedResults.length > 0 ? 'ranked_results' : 'resolver_candidates';
  const topScores = ctx.rankedResults.length > 0
    ? topKFinalScores(ctx.rankedResults)
    : ctx.resolveResult.candidates
        .map((c) => c.calibratedScore)
        .filter(Number.isFinite)
        .sort((a, b) => b - a);

  // E6: Run ConstraintReasoner inline to detect soft_tension / contradiction for
  // the typed evaluate() gate. Pure CPU operation — no I/O, negligible overhead.
  const reasoner = new ConstraintReasoner();
  const reasonerOutput = reasoner.reason(ctx.plan.constraints);

  // Derive channel degradation from routeDegradation signals populated upstream
  // by the candidate-pool retrieval phase. The routeDegradation.degradationReasons
  // array is the authoritative signal set for channel health in this request.
  const degradationReasons = mergedRouteDegradation?.degradationReasons ?? [];
  // sparseZeroHits: sparse channel executed normally (not degraded) but
  // returned zero lexical matches. Specialized browse/compare routes bypass
  // sparse BM25 entirely, so they must not be interpreted as sparse-zero-hit.
  const sparseChannelHealthy = !degradationReasons.some((reason) => reason.startsWith('sparse_'));
  const sparseZeroHits = routeExecutionFacts.retrievalKind === 'generic_hybrid'
    && routeExecutionFacts.sparseExecuted
    && sparseChannelHealthy
    && ctx.rankedResults.length > 0
    && ctx.rankedResults.every((r) => r.sparseRank === undefined);
  const channelDegradation: ChannelDegradationSummary = {
    denseDegraded: degradationReasons.includes('dense_retrieval_disabled'),
    anchorDegraded:
      degradationReasons.includes('entity_resolver_unavailable')
      || degradationReasons.some((reason) => reason.startsWith('anchor_')),
    sparseDegraded: !sparseChannelHealthy,
    sparseZeroHits,
  };

  // ltrAvailable is false when:
  // - kill switch forces heuristic-only mode
  // - no learned LTR model actually ran (cross-encoder-only rerank is NOT an
  //   LTR confidence substrate for RFC-013 entropy gating)
  // - LTR model loaded but saturated (all scores clamped to same value)
  // Heuristic / cross-encoder-only scores can still cluster tightly and are
  // not the calibrated LTR logit distribution the entropy gate was designed
  // around. Use scoreDriftRecord presence as the authoritative witness that
  // learned LTR actually executed.
  const rerankDecision = ctx.rankingMetadata?.rerankDecision;
  const learnedLtrApplied =
    ctx.rankingMetadata?.rerankExecuted === true
    && rerankDecision?.decision === 'applied'
    && rerankDecision.scoreDriftRecord !== undefined;
  const ltrAvailable =
    snapshot.feature_flags['killSwitchLearning'] !== true
    && learnedLtrApplied
    && ctx.rankingMetadata.ltrSaturated !== true;

  const abstainDecision = ctx.abstainPolicy.evaluate(
    topScores,
    reasonerOutput.relations,
    channelDegradation,
    { ltrAvailable },
    reasonerOutput.atoms,
  );

  // E4/E6: Derive AuditExtension after abstain evaluation so all traces
  // (retrieval_fusion_trace, abstain_policy_trace, hard_filter_drop_log)
  // can be populated in a single pass.
  const auditExtension = deriveAuditExtension(
    ctx.compiled,
    ctx.rankingMetadata,
    ctx.rankedResults,
    executionAuditTrace,
    ctx.retrievalFusionTrace,
    shouldEmitConstraintResolutionTrace(ctx.compiled, ctx.request.options?.explain)
      ? buildConstraintResolutionTrace(reasonerOutput)
      : undefined,
    abstainDecision,
    channelDegradation,
    ctx.hardFilterDropLog,
    buildResolverProvenanceTrace(ctx.resolveResult),
  );

  // Apply caller-specified result limit after ranking + abstain check (both need the full set).
  // Defensive bounds: clamp to [1, 1000] and reject NaN/negative/non-integer
  // values silently to prevent slice() oddities (slice(0,-1) drops last,
  // slice(0,NaN) → empty) from corrupting responses.
  const limitedRankedResults = (() => {
    const raw = ctx.request.limit;
    if (raw === undefined || !Number.isFinite(raw) || raw < 1) return ctx.rankedResults;
    const safeLimit = Math.min(1000, Math.floor(raw));
    return ctx.rankedResults.slice(0, safeLimit);
  })();

  let response: SearchResponseV1;

  // entity_lookup contract: when the caller passes options.clarification=false
  // (forced by retained internal lookup adapters), suppress the
  // entropy-abstain deflection branch and route through the normal ranked
  // decision path. The abstain decision is still emitted in auditExtension
  // so the trace is honest, but the response carries top-1 + appropriate
  // decisionStatus instead of a clarification payload — matching the
  // documented lookup intent ("direct answer, not a 'did you mean?'").
  // Requires at least one ranked result so the response is not vacuous.
  const honorClarificationOptOut =
    ctx.retrievalKind === 'entity_lookup'
    && ctx.request.options?.clarification === false
    && ctx.rankedResults.length > 0;

  if (abstainDecision !== false && honorClarificationOptOut) {
    pipelineDebug(
      {
        step: PipelineDebugStep.POST_ROUTE_ENTROPY_ABSTAIN_BYPASSED,
        effective_route: ctx.effectiveRoute,
        abstain_reason: abstainDecision.reason,
        retrieval_kind: ctx.retrievalKind,
        ranked_count: ctx.rankedResults.length,
      },
      'pipeline entity_lookup clarification opt-out — abstain bypass',
    );
  }

  if (abstainDecision !== false && !honorClarificationOptOut) {
    const abstainEntropy = abstainDecision.entropy;
    pipelineDebug(
      {
        step: PipelineDebugStep.POST_ROUTE_ENTROPY_ABSTAIN,
        effective_route: ctx.effectiveRoute,
        abstain_reason: abstainDecision.reason,
        ...(abstainEntropy !== undefined ? { entropy: abstainEntropy } : {}),
        score_count: topScores.length,
        top_score_source: topScoreSource,
      },
      'pipeline entropy abstain',
    );
    // RFC-019 Phase 7: query-level sensory priors for drinking window fallback.
    const sensoryPriorsAbstain =
      extractSensoryPriorsFromRetrievalPlan(ctx.compiled.query.retrievalPlan)
      ?? extractSensoryPriorsFromConstraints(ctx.plan.constraints);
    const results = await mapRankedResultsToResultItems(
      limitedRankedResults,
      ctx.drinkingWindow,
      resolveTargetYear(ctx),
      sensoryPriorsAbstain,
      resolveResultItemMappingOptions(ctx.effectiveRetrievalMode),
    );
    // Provenance slices and counterfactuals use the FULL ranked results, not
    // the limited display set — eval analytics need every candidate's channel
    // mix, and counterfactuals need to surface entities BEYOND the visible
    // window (which is exactly the value of "why was this picked over X").
    const retrievalProvenanceSlices = rankedResultsToEvalProvenanceSlices(
      ctx.requestId,
      ctx.rankedResults,
    );
    const abstainCounterfactuals = shouldIncludeCounterfactualsForRequest(
      ctx.plan,
      ctx.compiled,
      ctx.includeCounterfactuals,
    )
      ? buildSearchCounterfactuals(ctx.resolveResult, ctx.rankedResults, { abstainContext: true })
      : [];
    const winnerDualLaneArtifact = resolveWinnerAlignedDualLaneArtifact({
      executionTopology: ctx.executionTopology,
      identityResolveResult: ctx.identityResolveResult,
      resolveResult: ctx.resolveResult,
      fusedArtifacts: ctx.laneArtifacts.fused,
    });
    const winnerIdentityArtifact = resolveWinnerAlignedIdentityArtifact({
      executionTopology: ctx.executionTopology,
      identityResolveResult: ctx.identityResolveResult,
      resolveResult: ctx.resolveResult,
      identityArtifacts: ctx.laneArtifacts.identity,
    });
    const abstainCompiledCategoriesCovered =
      ctx.compiled.query.constraintExtraction?.categoriesCovered;
    const abstainDecisionInput = buildSearchDecisionInput({
      plan: ctx.plan,
      resolveResult: ctx.resolveResult,
      identityResolveResult: ctx.identityResolveResult ?? undefined,
      rankedResults: limitedRankedResults,
      effectiveRoute: ctx.effectiveRoute,
      decisionContext: ctx.decisionContext,
      executionContext: {
        effectiveRetrievalMode: ctx.effectiveRetrievalMode,
        retrievalKind: ctx.retrievalKind,
        provenancePolicy: ctx.compiled.execution.provenancePolicy,
        ...(winnerDualLaneArtifact !== undefined ? { winnerDualLaneArtifact } : {}),
        ...(winnerIdentityArtifact !== undefined ? { winnerIdentityArtifact } : {}),
        ...(ctx.compiled.constraintGraph !== undefined
          ? { constraintGraph: ctx.compiled.constraintGraph }
          : {}),
        ...(ctx.criticRewrites !== undefined && ctx.criticRewrites.length > 0
          ? { criticRewrites: ctx.criticRewrites }
          : {}),
        ...(abstainCompiledCategoriesCovered !== undefined
          && abstainCompiledCategoriesCovered.length > 0
          ? { categoriesCovered: abstainCompiledCategoriesCovered }
          : {}),
      },
      honestyContract: toAdmissionHonestyContract(mergedRouteDegradation),
    });
    const abstainAdmissionClosure = evaluateAdmissionClosure(abstainDecisionInput, snapshot);
    try {
      // buildEntropyAbstainResponseParams includes compiled (required) — do not spread
      // it again outside to avoid silent override if the builder ever transforms it.
      response = ctx.responseBuilder.build(
        {
          ...buildEntropyAbstainResponseParams({
            plan: ctx.plan,
            compiled: ctx.compiled,
            snapshot,
            requestId: ctx.requestId,
            startTime: ctx.startTime,
            effectiveRoute: ctx.effectiveRoute,
            retrievalModeSource: ctx.retrievalModeSource,
            plannerSuggestedMode: ctx.plannerSuggestedMode,
            abstainDecision,
            // entropy is only present for low_confidence abstains; use NaN as
            // sentinel for other reasons (no_match, semantic_conflict, etc.) —
            // buildEntropyAbstainResponseParams guards with Number.isFinite().
            entropy: abstainDecision.entropy ?? Number.NaN,
            results,
            rankedResults: limitedRankedResults,
            ...(retrievalProvenanceSlices.length > 0 ? { retrievalProvenanceSlices } : {}),
          }),
          ...(abstainCounterfactuals.length > 0 ? { counterfactuals: abstainCounterfactuals } : {}),
          ...(mergedRouteDegradation !== undefined ? { contract: mergedRouteDegradation } : {}),
          ...(ctx.specializedRouteObservability !== undefined
            ? { specializedRouteObservability: ctx.specializedRouteObservability }
            : {}),
          executionContract: buildResponseExecutionContract(
            routeExecutionFacts,
            ctx.rankingMetadata,
            abstainAdmissionClosure,
          ),
          ...(auditExtension !== undefined ? { auditExtension } : {}),
          determinismFingerprintParams: buildDeterminismFingerprintParams(
            snapshot,
            ctx.snapshotVersions,
            ctx.plan,
            ctx.compiled,
            ctx.rankingMetadata,
          ),
          ...(ctx.stageTimings !== undefined ? { stageTimings: ctx.stageTimings } : {}),
        },
      );
    } catch (buildErr) {
      if (buildErr instanceof EvidenceObligationError) {
        throw buildErr;
      }
      bootstrapLogger.error(
        { requestId: ctx.requestId, err: buildErr },
        '[runSearchPostRoutePhase] responseBuilder.build() threw in entropy-abstain path; returning bare safe response',
      );
      const queryTimeMs = Date.now() - ctx.startTime;
      const safeTraceRef = buildAuthorityTraceRef({
        queryPlan: ctx.plan,
        snapshot,
        route: ctx.effectiveRoute,
        retrievalMode: ctx.compiled.execution.effectiveRetrievalMode,
        decisionStatus: 'failed',
        nextAction: 'fail',
        failureReason: 'INTERNAL_INCONSISTENCY',
      });
      return {
        queryType: 'search',
        engineDecision: {
          decisionStatus: 'failed',
          nextAction: 'fail',
          route: ctx.effectiveRoute,
          decisionConfidence: 0,
          confidenceSemantics: deriveDecisionConfidenceSemantics(false),
          calibrationTrusted: false,
          decisionTraceRef: safeTraceRef,
          authorityTraceRef: safeTraceRef,
          decisionSnapshot: snapshot,
        },
        results: [],
        meta: {
          requestId: ctx.requestId,
          queryTimeMs,
          route: ctx.effectiveRoute,
          version: '1',
          engine_schema_version: 'search_response_v1',
          authorityTraceRef: safeTraceRef,
          runtimeCorrelationRef: ctx.requestId,
          executionMode: 'degraded',
          blockingEligible: false,
        },
      };
    }
  } else {
    response = await runRankedRouteDecisionPhase({
      plan: ctx.plan,
      compiled: ctx.compiled,
      requestId: ctx.requestId,
      startTime: ctx.startTime,
      resolveResult: ctx.resolveResult,
      identityResolveResult: ctx.identityResolveResult,
      rankedResults: limitedRankedResults,
      fullRankedResults: ctx.rankedResults,
      decisionContext: ctx.decisionContext,
      effectiveRoute: ctx.effectiveRoute,
      snapshotVersions: ctx.snapshotVersions,
      drinkingWindow: ctx.drinkingWindow,
      decisionEngine: ctx.decisionEngine,
      responseBuilder: ctx.responseBuilder,
      ...(ctx.includeCounterfactuals !== undefined ? { includeCounterfactuals: ctx.includeCounterfactuals } : {}),
      retrievalModeSource: ctx.retrievalModeSource,
      plannerSuggestedMode: ctx.plannerSuggestedMode,
      routeDegradation: mergedRouteDegradation,
      ...(ctx.rankingMetadata !== undefined ? { rankingMetadata: ctx.rankingMetadata } : {}),
      specializedRouteObservability: ctx.specializedRouteObservability,
      executionTopology: ctx.executionTopology,
      laneTrace: ctx.laneTrace,
      laneArtifacts: ctx.laneArtifacts,
      effectiveRetrievalMode: ctx.effectiveRetrievalMode,
      retrievalKind: ctx.retrievalKind,
      sparseExecuted: ctx.sparseExecuted,
      specializedRouteExecuted: ctx.specializedRouteExecuted,
      usedCompiledExecution: ctx.usedCompiledExecution,
      ...(ctx.retrievalFusionTrace !== undefined ? { retrievalFusionTrace: ctx.retrievalFusionTrace } : {}),
      ...(ctx.hardFilterDropLog !== undefined && ctx.hardFilterDropLog.length > 0
        ? { hardFilterDropLog: ctx.hardFilterDropLog }
        : {}),

      ...(ctx.criticRewrites !== undefined && ctx.criticRewrites.length > 0
        ? { criticRewrites: ctx.criticRewrites }
        : {}),
      ...(ctx.criticRetriesExhausted === true ? { criticRetriesExhausted: true } : {}),
      ...(ctx.stageTimings !== undefined ? { stageTimings: ctx.stageTimings } : {}),
    });
  }

  // Shared structured log + cache write for both paths.
  const engineDecision = response.engineDecision as
    | SearchResponseV1['engineDecision']
    | undefined;
  const responseSnapshot = engineDecision?.decisionSnapshot;
  if (responseSnapshot !== undefined) {
    const provenanceTrace = response.meta.provenanceTrace;
    const shortfallTimeline = provenanceTrace?.shortfalls.map((reasonCode) => ({
      reason_code: reasonCode,
      layer: classifyShortfallLayer(reasonCode),
    }));
    logSearchEvent({
      ...(response.meta.authorityTraceRef !== undefined
        ? { authority_trace_ref: response.meta.authorityTraceRef }
        : {}),
      runtime_correlation_ref: response.meta.runtimeCorrelationRef ?? ctx.requestId,
      ...(response.meta.executionMode !== undefined
        ? { execution_mode: response.meta.executionMode }
        : {}),
      ...(response.meta.degradationReasons !== undefined
        ? { degradation_reasons: response.meta.degradationReasons }
        : {}),
      ...(provenanceTrace !== undefined
        ? {
            provenance_missing: provenanceTrace.missing,
            provenance_shortfalls: provenanceTrace.shortfalls,
            admission_gate_decision: provenanceTrace.gateDecisions.admission,
            decision_gate_decision: provenanceTrace.gateDecisions.decision,
            shortfall_timeline: shortfallTimeline,
          }
        : {}),
      ...toSpecializedRouteMeta(ctx.specializedRouteObservability),
      route_name: ctx.effectiveRoute,
      executed_query_observability: planToObservabilitySlice(
        ctx.requestId,
        ctx.plan,
        ctx.compiled,
      ),
      model_versions: { ...responseSnapshot.model_versions },
      kill_switch_state: { ...responseSnapshot.feature_flags },
    });
  }

  if (ctx.cacheService) {
    try {
      const stored = await ctx.cacheService.setSearchResponse(
        ctx.plan,
        cacheRequestContext,
        response,
        ctx.compiled,
      );
      if (!stored) {
        pipelineDebug(
          { step: PipelineDebugStep.CACHE_SET_SKIPPED, reason: abstainDecision !== false ? 'entropy_abstain' : 'ineligible_or_breaker' },
          '[Search] setSearchResponse skipped',
        );
      }
    } catch (cacheErr) {
      bootstrapLogger.warn(
        { requestId: ctx.requestId, err: cacheErr },
        '[runSearchPostRoutePhase] cacheService.setSearchResponse() threw; continuing without cache write',
      );
    }
  }

  return response;
}
