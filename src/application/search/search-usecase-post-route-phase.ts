import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { DecisionEnginePort, ResponseBuilderPort } from './port/search-pipeline-deps.port.js';
import type { SearchRequest } from './search-request.dto.js';
import type { SearchRouteDecisionContext } from './search-usecase-route-dispatch.js';
import { buildEntropyAbstainResponseParams } from './search-usecase-execute-builders.js';
import { buildSearchCacheRequestContext } from './search-usecase-cache-context.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { buildAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import { buildSearchCounterfactuals } from './search-usecase-counterfactuals.js';
import { getExplanationObligation } from '../../domain/response/service/explanation-obligation.js';
import { deriveQueryFamily } from '../../domain/query/model/query-observability-vocab.js';
import { buildSearchDecisionInput } from './search-usecase-decision-input.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { rankedResultsToEvalProvenanceSlices } from './search-usecase-eval-provenance.js';
import { mapRankedResultsToResultItems } from './search-usecase-map-result-items.js';
import { topKFinalScores } from './search-usecase-ranking-scores.js';
import type { SnapshotVersionInjection } from './search-usecase-cache-lookup.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import { logSearchEvent } from '../../observability/log-search-event.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { DecisionSnapshot, EvidenceItem } from '../../domain/shared/types/index.js';
import {
  toSpecializedRouteMeta,
  type SpecializedRouteObservability,
} from './specialized-route-observability.js';

function deriveDecisionEvidenceItems(
  rankedResults: readonly RankedResult[],
): readonly EvidenceItem[] {
  return rankedResults[0]?.evidenceItems ?? [];
}

function mergeRouteDegradation(
  snapshot: DecisionSnapshot,
  effectiveRoute: QueryRoute,
  routeDegradation?: RankingDegradationSignal,
  resolveResult?: EntityResolveResult,
): RankingDegradationSignal | undefined {
  const reasons = new Set([
    ...(routeDegradation?.degradationReasons ?? []),
    ...(resolveResult?.degradation?.reasons ?? []),
  ]);
  if (snapshot.feature_flags['killSwitchLearning'] === true) {
    reasons.add('learning_kill_switch');
  }
  if (
    snapshot.feature_flags['killSwitchDenseRetrieval'] === true
    && effectiveRoute !== 'entity'
  ) {
    reasons.add('dense_retrieval_disabled');
  }
  if (reasons.size === 0) {
    return undefined;
  }
  return {
    executionMode: 'degraded',
    degradationReasons: [...reasons],
  };
}

/**
 * Context for Steps 3b–7: entropy abstain → DecisionEngine → ResponseBuilder → optional cache write.
 */
export interface SearchPostRouteExecutionContext {
  readonly plan: QueryPlanV1;
  /** Compiled execution contract from ExecutionCompiler (E1-U3 carrier). When present,
   *  downstream phases read route/mode decisions from here rather than re-deriving from V1. */
  readonly compiled?: CompiledWineQuery | undefined;
  readonly request: SearchRequest;
  readonly requestId: string;
  readonly startTime: number;
  readonly resolveResult: EntityResolveResult;
  readonly rankedResults: readonly RankedResult[];
  readonly decisionContext?: SearchRouteDecisionContext | undefined;
  readonly effectiveRoute: QueryRoute;
  readonly plannerSuggestedMode: string;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly abstainPolicy: AbstainPolicy;
  readonly snapshotVersions: SnapshotVersionInjection;
  readonly drinkingWindow?: DrinkingWindowUseCasePort | undefined;
  readonly decisionEngine: DecisionEnginePort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly cacheService?: SearchResponseCachePort | undefined;
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
}

export interface RankedRouteDecisionPhaseContext {
  readonly plan: QueryPlanV1;
  /** Compiled execution contract (E1-U3 carrier). When present, passed to ResponseBuilder for effectiveRetrievalMode. */
  readonly compiled?: CompiledWineQuery | undefined;
  readonly requestId: string;
  readonly startTime: number;
  readonly resolveResult: EntityResolveResult;
  readonly rankedResults: readonly RankedResult[];
  readonly decisionContext?: SearchRouteDecisionContext | undefined;
  readonly effectiveRoute: QueryRoute;
  readonly snapshotVersions: SnapshotVersionInjection;
  readonly drinkingWindow?: DrinkingWindowUseCasePort | undefined;
  readonly decisionEngine: DecisionEnginePort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly retrievalModeSource?: 'planner' | 'api_override' | undefined;
  readonly plannerSuggestedMode?: string | undefined;
  readonly includeCounterfactuals?: boolean | undefined;
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
}

function toAdmissionHonestyContract(
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

  return {
    executionMode: routeDegradation.executionMode,
    routeHealthy: false,
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
      step: 'decision.phase.enter',
      effective_route: ctx.effectiveRoute,
      resolve_status: ctx.resolveResult.status,
      ranked_count: ctx.rankedResults.length,
    },
    'pipeline decision phase',
  );

  const snapshot = buildDecisionSnapshotFromPlan(ctx.plan, ctx.snapshotVersions);
  const mergedRouteDegradation = mergeRouteDegradation(
    snapshot,
    ctx.effectiveRoute,
    ctx.routeDegradation,
    ctx.resolveResult,
  );
  const decisionInput = buildSearchDecisionInput(
    ctx.plan,
    ctx.resolveResult,
    ctx.rankedResults,
    ctx.effectiveRoute,
    ctx.decisionContext,
    toAdmissionHonestyContract(mergedRouteDegradation),
    ctx.compiled?.execution.effectiveRetrievalMode,
  );
  pipelineDebug(
    {
      step: 'decision.engine.request',
      query_class: ctx.plan.queryClass,
    },
    'pipeline decision engine request',
  );

  let decisionOutput: Awaited<ReturnType<typeof ctx.decisionEngine.decide>>;
  try {
    decisionOutput = await ctx.decisionEngine.decide(decisionInput, snapshot);
  } catch (err) {
    bootstrapLogger.error(
      { requestId: ctx.requestId, err },
      '[runRankedRouteDecisionPhase] decisionEngine.decide() threw unexpectedly; returning degraded failed response',
    );
    const failedDecisionOutput = {
      decisionStatus: 'failed' as const,
      nextAction: 'fail' as const,
      decisionConfidence: 0,
      confidenceSemantics: 'calibrated_decision_confidence' as const,
      signalSet: {
        entity_integrity_score: 0,
        hard_constraint_pass: 0,
        soft_constraint_score: 0,
        semantic_relevance_score: 0,
        preference_alignment_score: 0,
        popularity_score: 0,
        availability_score: 0,
        uncertainty_penalty: 0,
      },
      evidenceItems: deriveDecisionEvidenceItems(ctx.rankedResults),
      decisionTraceRef: buildAuthorityTraceRef({
        queryPlan: ctx.plan,
        snapshot,
        route: ctx.effectiveRoute,
        ...(ctx.compiled !== undefined
          ? { retrievalMode: ctx.compiled.execution.effectiveRetrievalMode }
          : {}),
        decisionStatus: 'failed',
        nextAction: 'fail',
        failureReason: 'INTERNAL_INCONSISTENCY',
      }),
      decisionSnapshot: snapshot,
      failureReason: 'INTERNAL_INCONSISTENCY' as const,
      decisionTrace: {
        decisionStatus: 'failed',
        nextAction: 'fail',
        inputs: {
          queryClass: ctx.plan.queryClass,
          policy: ctx.plan.policy,
        },
        signals: {
          decisionConfidence: 0,
          calibratedGap: 0,
          ambiguity: false,
        },
        thresholds: {
          resolveThreshold: 0,
          gapThreshold: 0,
        },
        versions: {
          plannerVersion: ctx.plan.plannerVersion,
          policyRuleVersion: ctx.plan.policyRuleVersion,
          thresholdProfileId: ctx.plan.thresholdProfileId,
        },
        rulesApplied: ['INTERNAL_INCONSISTENCY'],
        finalReason: `Decision engine threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      },
      candidates: [],
    };
    const queryTimeMs = Date.now() - ctx.startTime;
    try {
      return ctx.responseBuilder.build({
        queryPlan: ctx.plan,
        ...(ctx.compiled !== undefined ? { compiled: ctx.compiled } : {}),
        decisionOutput: failedDecisionOutput,
        results: [],
        requestId: ctx.requestId,
        queryTimeMs,
        route: ctx.effectiveRoute,
        ...(ctx.retrievalModeSource !== undefined
          ? { retrievalModeSource: ctx.retrievalModeSource }
          : {}),
        ...(ctx.plannerSuggestedMode !== undefined
          ? { plannerSuggestedMode: ctx.plannerSuggestedMode }
          : {}),
      });
    } catch (buildErr) {
      bootstrapLogger.error(
        { requestId: ctx.requestId, err: buildErr },
        '[runRankedRouteDecisionPhase] responseBuilder.build() threw in decision-failed fallback; returning bare safe response',
      );
      const safeTraceRef = buildAuthorityTraceRef({
        queryPlan: ctx.plan,
        snapshot,
        route: ctx.effectiveRoute,
        ...(ctx.compiled !== undefined
          ? { retrievalMode: ctx.compiled.execution.effectiveRetrievalMode }
          : {}),
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
          confidenceSemantics: 'calibrated_decision_confidence',
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
  }

  pipelineDebug(
    {
      step: 'decision.engine.response',
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
  const results = await mapRankedResultsToResultItems(
    ctx.rankedResults,
    ctx.drinkingWindow,
  );
  const retrievalProvenanceSlices = rankedResultsToEvalProvenanceSlices(
    ctx.requestId,
    ctx.rankedResults,
  );
  // E4-U5: Consult explanation obligation map for the query family.
  // - If obligation.requiresCounterfactual: counterfactuals MUST be included
  //   (override even if ctx.includeCounterfactuals is false).
  // - If !obligation.requiresCounterfactual: respect ctx.includeCounterfactuals
  //   (default true — backward compatible; caller can explicitly suppress with false).
  const queryFamily = deriveQueryFamily(ctx.plan, ctx.compiled);
  const obligation = getExplanationObligation(queryFamily);
  const shouldIncludeCounterfactuals =
    queryFamily === 'comparison'
      ? ctx.includeCounterfactuals === true
      : obligation.requiresCounterfactual || ctx.includeCounterfactuals !== false;
  const counterfactuals = shouldIncludeCounterfactuals
    ? buildSearchCounterfactuals(ctx.resolveResult, ctx.rankedResults)
    : [];

  /**
   * E6-U2: Quality Gate Wiring — compiled fields forwarded to quality gate
   * Fields from SearchPostRouteExecutionContext forwarded to EvidenceGate:
   *   - evidenceQuality (from decision input)
   *   - rerank suppression flag (from RerankGateDecision)
   * Do NOT pass raw scores or internal ranker state to the quality gate.
   * compiled.execution.effectiveRoute/effectiveRetrievalMode are forwarded via ResponseBuildParams.
   */
  let built: SearchResponseV1;
  try {
    built = ctx.responseBuilder.build({
      queryPlan: ctx.plan,
      ...(ctx.compiled !== undefined ? { compiled: ctx.compiled } : {}),
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
    });
  } catch (buildErr) {
    bootstrapLogger.error(
      { requestId: ctx.requestId, err: buildErr },
      '[runRankedRouteDecisionPhase] responseBuilder.build() threw; returning bare safe response',
    );
    const safeTraceRef = buildAuthorityTraceRef({
      queryPlan: ctx.plan,
      snapshot,
      route: ctx.effectiveRoute,
      ...(ctx.compiled !== undefined
        ? { retrievalMode: ctx.compiled.execution.effectiveRetrievalMode }
        : {}),
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
        confidenceSemantics: 'calibrated_decision_confidence',
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
  /* Unit tests may stub partial SearchResponseV1; skip structured log when snapshot missing. */
  const engineDecision = built.engineDecision as SearchResponseV1['engineDecision'] | undefined;
  const decisionSnapshot = engineDecision?.decisionSnapshot;
  if (decisionSnapshot !== undefined) {
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
      step: 'post_route.enter',
      effective_route: ctx.effectiveRoute,
      resolve_status: ctx.resolveResult.status,
      ranked_count: ctx.rankedResults.length,
    },
    'pipeline post-route',
  );

  const cacheRequestContext = buildSearchCacheRequestContext(ctx.request);
  const topScores = topKFinalScores(ctx.rankedResults);
  const abstainDecision = ctx.abstainPolicy.shouldAbstain(topScores);

  if (abstainDecision.abstain) {
    pipelineDebug(
      {
        step: 'post_route.entropy_abstain',
        effective_route: ctx.effectiveRoute,
        entropy: abstainDecision.entropy,
        score_count: topScores.length,
      },
      'pipeline entropy abstain',
    );
    const snapshot = buildDecisionSnapshotFromPlan(ctx.plan, ctx.snapshotVersions);
    const mergedRouteDegradation = mergeRouteDegradation(
      snapshot,
      ctx.effectiveRoute,
      ctx.routeDegradation,
      ctx.resolveResult,
    );
    const results = await mapRankedResultsToResultItems(
      ctx.rankedResults,
      ctx.drinkingWindow,
    );
    const retrievalProvenanceSlices = rankedResultsToEvalProvenanceSlices(
      ctx.requestId,
      ctx.rankedResults,
    );
    let response: SearchResponseV1;
    try {
      response = ctx.responseBuilder.build(
        {
          ...buildEntropyAbstainResponseParams({
            plan: ctx.plan,
            ...(ctx.compiled !== undefined ? { compiled: ctx.compiled } : {}),
            snapshot,
            requestId: ctx.requestId,
            startTime: ctx.startTime,
            effectiveRoute: ctx.effectiveRoute,
            retrievalModeSource: ctx.retrievalModeSource,
            plannerSuggestedMode: ctx.plannerSuggestedMode,
            entropy: abstainDecision.entropy,
            results,
            rankedResults: ctx.rankedResults,
            ...(retrievalProvenanceSlices.length > 0 ? { retrievalProvenanceSlices } : {}),
          }),
          ...(ctx.compiled !== undefined ? { compiled: ctx.compiled } : {}),
          ...(mergedRouteDegradation !== undefined ? { contract: mergedRouteDegradation } : {}),
          ...(ctx.specializedRouteObservability !== undefined
            ? { specializedRouteObservability: ctx.specializedRouteObservability }
            : {}),
        },
      );
    } catch (buildErr) {
      bootstrapLogger.error(
        { requestId: ctx.requestId, err: buildErr },
        '[runSearchPostRoutePhase] responseBuilder.build() threw in entropy-abstain path; returning bare safe response',
      );
      const queryTimeMs = Date.now() - ctx.startTime;
      const safeTraceRef = buildAuthorityTraceRef({
        queryPlan: ctx.plan,
        snapshot,
        route: ctx.effectiveRoute,
        ...(ctx.compiled !== undefined
          ? { retrievalMode: ctx.compiled.execution.effectiveRetrievalMode }
          : {}),
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
          confidenceSemantics: 'calibrated_decision_confidence',
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
    const entropyEngineDecision = response.engineDecision as
      | SearchResponseV1['engineDecision']
      | undefined;
    const entropySnapshot = entropyEngineDecision?.decisionSnapshot;
    if (entropySnapshot !== undefined) {
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
        ...toSpecializedRouteMeta(ctx.specializedRouteObservability),
        route_name: ctx.effectiveRoute,
        model_versions: { ...entropySnapshot.model_versions },
        kill_switch_state: { ...entropySnapshot.feature_flags },
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
            { step: 'cache.set_skipped', reason: 'entropy_abstain' },
            '[Search] setSearchResponse skipped for entropy abstain response',
          );
        }
      } catch (cacheErr) {
        bootstrapLogger.warn(
          { requestId: ctx.requestId, err: cacheErr },
          '[runSearchPostRoutePhase] cacheService.setSearchResponse() threw in entropy-abstain path; continuing without cache write',
        );
      }
    }
    return response;
  }

  const rankedSnapshot = buildDecisionSnapshotFromPlan(ctx.plan, ctx.snapshotVersions);
  const mergedRouteDegradation = mergeRouteDegradation(
    rankedSnapshot,
    ctx.effectiveRoute,
    ctx.routeDegradation,
    ctx.resolveResult,
  );
  const response = await runRankedRouteDecisionPhase({
    plan: ctx.plan,
    ...(ctx.compiled !== undefined ? { compiled: ctx.compiled } : {}),
    requestId: ctx.requestId,
    startTime: ctx.startTime,
      resolveResult: ctx.resolveResult,
      rankedResults: ctx.rankedResults,
      decisionContext: ctx.decisionContext,
      effectiveRoute: ctx.effectiveRoute,
    snapshotVersions: ctx.snapshotVersions,
    drinkingWindow: ctx.drinkingWindow,
    decisionEngine: ctx.decisionEngine,
    responseBuilder: ctx.responseBuilder,
    retrievalModeSource: ctx.retrievalModeSource,
    plannerSuggestedMode: ctx.plannerSuggestedMode,
    routeDegradation: mergedRouteDegradation,
    specializedRouteObservability: ctx.specializedRouteObservability,
  });

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
          { step: 'cache.set_skipped', reason: 'ineligible_or_breaker' },
          '[Search] setSearchResponse skipped (ineligible mode, circuit breaker, or policy)',
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
