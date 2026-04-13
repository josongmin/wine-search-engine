import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { AuditExtension, PolicyOutcome } from '../../domain/audit/model/audit-extension.js';
import type { CandidateDropRecord } from '../../domain/retrieval/model/candidate-envelope.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { RankingMetadata } from '../../domain/ranking/port/ranker.port.js';
import type { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import type { RrfFusionTrace } from '../../domain/retrieval/model/candidate-envelope.js';
import type { TypedAbstainDecision } from '../../domain/query/model/abstain-decision.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { DecisionEnginePort, ResponseBuilderPort } from './port/search-pipeline-deps.port.js';
import type { SearchRequest } from './search-request.dto.js';
import type { SearchRouteDecisionContext } from './search-usecase-route-dispatch.js';
import { buildEntropyAbstainResponseParams } from './search-usecase-execute-builders.js';
import { buildSearchCacheRequestContext } from './search-usecase-cache-context.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { isCorruptedSnapshot } from '../../domain/shared/types/index.js';
import { ConstraintReasoner } from '../../domain/query/service/constraint-reasoner.js';
import type { ConstraintReasonerOutput } from '../../domain/query/service/constraint-reasoner.js';
import type { ChannelDegradationSummary } from '../../domain/query/model/abstain-decision.js';
import { buildAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import { DomainError, EvidenceObligationError } from '../../domain/shared/error/domain-error.js';
import { buildSearchCounterfactuals } from './search-usecase-counterfactuals.js';
import { getExplanationObligation } from '../../domain/response/service/explanation-obligation.js';
import { deriveQueryFamily } from '../../domain/query/model/query-observability-vocab.js';
import { buildSearchDecisionInput } from './search-usecase-decision-input.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { rankedResultsToEvalProvenanceSlices } from './search-usecase-eval-provenance.js';
import { mapRankedResultsToResultItems } from './search-usecase-map-result-items.js';
import {
  extractSensoryPriorsFromConstraints,
  extractSensoryPriorsFromRetrievalPlan,
} from './extract-sensory-priors.js';
import { topKFinalScores } from './search-usecase-ranking-scores.js';
import type { SnapshotVersionInjection } from './search-usecase-cache-lookup.js';
import type { DeterminismFingerprintParams } from '../../domain/shared/utils/determinism-fingerprint.js';
import { deterministicHash } from '../../domain/shared/utils/hash.js';
import { RRF_DEFAULT_K } from '../../domain/shared/utils/rrf.js';
import {
  getFusionConfig,
  mapDomainQueryClassToFusionQueryClass,
} from '../../domain/retrieval/service/per-class-fusion-config.js';
import { RetrievalProfileService } from '../../domain/retrieval/service/retrieval-profile.js';
import { retrievalPlanVersion } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import { getModeWeights, MODE_WEIGHT_OVERLAY_MAP } from '../../domain/ranking/model/mode-weights.js';
import { RANKING_POLICY_VERSION } from '../../domain/ranking/service/ranker.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import { logSearchEvent } from '../../observability/log-search-event.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import {
  toSpecializedRouteMeta,
  type SpecializedRouteObservability,
} from './specialized-route-observability.js';
/** Number of top-ranked entity IDs captured in pre/post-rerank audit snapshots. */
const AUDIT_RERANK_SNAPSHOT_COUNT = 5;
const retrievalProfileService = new RetrievalProfileService();

/**
 * Derives AuditExtension from planner/ranking runtime state and optional
 * retrieval/abstain traces.
 * Returns undefined when no gated trace payload is available.
 *
 * Gating policy (from AuditExtension field documentation):
 *  - planner_policy_trace      explain=true OR debug header (sourced from compiled.plannerTrace)
 *  - retrieval_fusion_trace    explain=true OR debug header (sourced from RRF fusion)
 *  - ranking_delta_trace       LTR applied + explain=true (sourced from scoreDriftRecord)
 *  - abstain_policy_trace      always when abstain occurs (sourced from TypedAbstainDecision)
 */
/** Maximum drop records included in hard_filter_drop_log to keep payload lean. */
const AUDIT_DROP_LOG_MAX = 5;

function deriveAuditExtension(
  compiled: CompiledWineQuery | undefined,
  rankingMetadata: RankingMetadata | undefined,
  rankedResults: readonly RankedResult[],
  retrievalFusionTrace?: RrfFusionTrace,
  constraintResolutionTrace?: AuditExtension['constraint_resolution_trace'],
  abstainDecision?: TypedAbstainDecision | false,
  channelDegradation?: ChannelDegradationSummary,
  hardFilterDropLog?: readonly CandidateDropRecord[],
  correctiveRetryCalibration?: number,
  resolverProvenanceTrace?: AuditExtension['resolver_provenance_trace'],
): AuditExtension | undefined {
  const plannerTrace = compiled?.plannerTrace;
  // E1-T4: Read scoreDriftRecord from rerankDecision (structured contract).
  // The top-level RankingMetadata.scoreDriftRecord field is @deprecated —
  // all new reads must go through rerankDecision.scoreDriftRecord.
  const rerankDecision = rankingMetadata?.rerankDecision;
  const scoreDriftRecord = rerankDecision?.scoreDriftRecord;

  // Abstain policy trace is emitted whenever abstain evaluation ran (abstainDecision !== undefined).
  const hasAbstainTrace = abstainDecision !== undefined;
  // Retrieval fusion trace present when hybrid RRF path was used.
  const hasFusionTrace = retrievalFusionTrace !== undefined;
  const hasRerankDecisionTrace =
    rerankDecision !== undefined
    && (scoreDriftRecord !== undefined || (plannerTrace?.length ?? 0) > 0);
  // E4: Drop log present when at least one candidate was hard-filtered out.
  const hasDropLog = hardFilterDropLog !== undefined && hardFilterDropLog.length > 0;
  // TA5: Corrective retry calibration present when retry was accepted.
  const hasRetryCalibration = correctiveRetryCalibration !== undefined && Number.isFinite(correctiveRetryCalibration);

  if (
    (plannerTrace == null || plannerTrace.length === 0)
    && scoreDriftRecord === undefined
    && !hasFusionTrace
    && constraintResolutionTrace === undefined
    && !hasAbstainTrace
    && !hasDropLog
    && !hasRetryCalibration
    && resolverProvenanceTrace === undefined
  ) {
    return undefined;
  }

  // Normalize topKEntropy: only emit when it's a finite number.
  const topKEntropy = (() => {
    if (abstainDecision !== false && abstainDecision?.reason === 'low_confidence' && abstainDecision.entropy !== undefined) {
      return abstainDecision.entropy;
    }
    // Compute from topKScores when abstain decision doesn't carry entropy directly.
    // This is the case for no_match / semantic_conflict / insufficient_evidence.
    // We don't recompute entropy here — rely on what AbstainPolicy returned.
    return undefined;
  })();

  return {
    ...(plannerTrace != null && plannerTrace.length > 0
      ? { planner_policy_trace: plannerTrace }
      : {}),
    ...(constraintResolutionTrace !== undefined
      ? { constraint_resolution_trace: constraintResolutionTrace }
      : {}),
    ...(hasFusionTrace
      ? { retrieval_fusion_trace: retrievalFusionTrace }
      : {}),
    ...(scoreDriftRecord !== undefined
      ? {
          ranking_delta_trace: {
            preRerankTop5: rankingMetadata?.preRerankTop5 ?? [],
            postRerankTop5: rankedResults.slice(0, AUDIT_RERANK_SNAPSHOT_COUNT).map((result) => String(result.entityId)),
            safetyEnvelopeBlocks: scoreDriftRecord.safetyEnvelopeBlocks,
            drift: scoreDriftRecord,
          },
        }
      : {}),
    ...(hasRerankDecisionTrace
      ? {
          rerank_decision_trace: {
            gateDecision: rerankDecision.decision,
            ...(rerankDecision.modelId !== undefined ? { appliedModel: rerankDecision.modelId } : {}),
            ...(rerankDecision.applied ? { scoreContract: 'bounded_normalized_0_1' as const } : {}),
          },
        }
      : {}),
    ...(hasAbstainTrace
      ? {
          abstain_policy_trace: {
            evaluated: true,
            decision: abstainDecision,
            ...(topKEntropy !== undefined ? { topKEntropy } : {}),
            ...(abstainDecision !== false && abstainDecision.conflictingRelations !== undefined
              ? { constraintConflicts: abstainDecision.conflictingRelations }
              : {}),
            ...(channelDegradation !== undefined ? { channelDegradation } : {}),
          },
        }
      : {}),
    ...(hasDropLog
      ? {
          // E4: Sample top-AUDIT_DROP_LOG_MAX drops by lastKnownScore desc to keep payload lean.
          hard_filter_drop_log: [...hardFilterDropLog]
            .sort((a, b) => {
              const aFinite = Number.isFinite(a.lastKnownScore);
              const bFinite = Number.isFinite(b.lastKnownScore);
              if (!aFinite && !bFinite) return 0;
              if (!aFinite) return 1;
              if (!bFinite) return -1;
              return b.lastKnownScore - a.lastKnownScore;
            })
            .slice(0, AUDIT_DROP_LOG_MAX),
        }
      : {}),
    ...(hasRetryCalibration
      ? { corrective_retry_calibrated_confidence: correctiveRetryCalibration }
      : {}),
    ...(resolverProvenanceTrace !== undefined
      ? { resolver_provenance_trace: resolverProvenanceTrace }
      : {}),
  };
}

function shouldEmitConstraintResolutionTrace(
  compiled: CompiledWineQuery | undefined,
  requestExplain?: boolean,
): boolean {
  return requestExplain === true || (compiled?.plannerTrace?.length ?? 0) > 0;
}

function buildConstraintPolicyOutcomes(
  reasonerOutput: ConstraintReasonerOutput,
): readonly PolicyOutcome[] {
  const relationsByAtom = new Map<number, typeof reasonerOutput.relations>();
  for (let index = 0; index < reasonerOutput.atoms.length; index++) {
    relationsByAtom.set(index, []);
  }
  for (const relation of reasonerOutput.relations) {
    relationsByAtom.set(relation.atomIndexA, [...(relationsByAtom.get(relation.atomIndexA) ?? []), relation]);
    relationsByAtom.set(relation.atomIndexB, [...(relationsByAtom.get(relation.atomIndexB) ?? []), relation]);
  }

  return reasonerOutput.atoms.map((_atom, atomIndex) => {
    const relations = relationsByAtom.get(atomIndex) ?? [];
    const losingRelation = relations.find((relation) => {
      if (
        relation.type !== 'contradiction'
        && relation.type !== 'redundancy'
        && relation.type !== 'overshadow'
      ) {
        return false;
      }
      const loserIndex =
        relation.winner === 'a'
          ? relation.atomIndexB
          : relation.atomIndexA;
      return loserIndex === atomIndex;
    });
    if (losingRelation !== undefined) {
      return {
        atomIndex,
        outcome: losingRelation.type === 'overshadow' ? 'shadowed' : 'dropped',
        reason: losingRelation.explanation,
      } satisfies PolicyOutcome;
    }

    const winningOrInformative = relations
      .map((relation) => relation.explanation)
      .filter((explanation, index, all) => all.indexOf(explanation) === index);

    return {
      atomIndex,
      outcome: 'kept',
      reason: winningOrInformative.length > 0
        ? winningOrInformative.join('; ')
        : 'No conflict detected',
    } satisfies PolicyOutcome;
  });
}

function buildConstraintResolutionTrace(
  reasonerOutput: ConstraintReasonerOutput,
): NonNullable<AuditExtension['constraint_resolution_trace']> {
  return {
    atoms: reasonerOutput.atoms,
    relations: reasonerOutput.relations,
    policy_outcomes: buildConstraintPolicyOutcomes(reasonerOutput),
  };
}

/**
 * E1-T5: Build DeterminismFingerprintParams from the execution context snapshot.
 *
 * The fingerprint covers engine configuration (planner version, primary model ID,
 * fusion k constant, ranking config hash) so that two executions with the same
 * configuration always produce the same fingerprint regardless of query content.
 *
 * modelVersionsHash and indexVersionsHash are canonical hashes over the full
 * snapshot version maps, avoiding insertion-order dependence and capturing
 * full execution-snapshot drift rather than a single "primary" model.
 *
 * E1-T5 extended fields:
 *   - responseContractVersion: from snapshot.response_contract_version
 *   - rerankApplied: from rankingMetadata.rerankExecuted
 *   - rerankModelId: from model_versions['reranker_model'] or rerankDecision.modelId
 */
function buildDeterminismFingerprintParams(
  snapshot: DecisionSnapshot,
  snapshotVersions: SnapshotVersionInjection,
  plan: QueryPlanV1,
  compiled: CompiledWineQuery | undefined,
  rankingMetadata?: RankingMetadata,
): DeterminismFingerprintParams {
  const modelVersions = snapshotVersions?.modelVersions ?? {};
  const primaryModelId =
    modelVersions['query_understanding'] ??
    modelVersions['rerank'] ??
    'unknown';

  const modelVersionsHash = deterministicHash(
    ...Object.keys(modelVersions).sort().map((key) => `${key}:${modelVersions[key] ?? ''}`),
  );

  const featureFlagsHash = deterministicHash(
    ...Object.keys(snapshot.feature_flags).sort().map((key) => `${key}:${JSON.stringify(snapshot.feature_flags[key])}`),
  );

  // Stable hash of ranking config — index versions act as a proxy for the
  // feature schema version that drives LTR scoring.
  const indexVersions = snapshotVersions?.indexVersions ?? {};
  const indexVersionsHash = deterministicHash(
    ...Object.keys(indexVersions).sort().map((key) => `${key}:${indexVersions[key] ?? ''}`),
  );
  const queryFamily = deriveQueryFamily(plan, compiled);
  const effectiveRetrievalMode = compiled?.execution.effectiveRetrievalMode ?? plan.retrievalMode;
  const effectiveRoute = compiled?.execution.effectiveRoute ?? 'hybrid';
  const fusionQueryClass = mapDomainQueryClassToFusionQueryClass(plan.queryClass, effectiveRetrievalMode);
  const fusionConfig = getFusionConfig(fusionQueryClass);
  const retrievalProfile = retrievalProfileService.getProfile(
    plan.queryClass,
    effectiveRoute,
    effectiveRetrievalMode,
    queryFamily,
  );
  const modeWeights = getModeWeights(effectiveRetrievalMode);
  const fusionConfigHash = deterministicHash(
    String(RRF_DEFAULT_K),
    fusionQueryClass,
    String(fusionConfig.rrfK),
    String(fusionConfig.sparseWeight),
    String(fusionConfig.denseWeight),
    String(fusionConfig.anchorWeight),
    String(fusionConfig.learnedSparseWeight),
    retrievalProfile.name,
    retrievalProfile.channelMix.join(','),
    String(retrievalProfile.sparseWeight),
    String(retrievalProfile.denseWeight),
    String(retrievalProfile.anchorWeight),
    String(retrievalProfile.sparseTopN),
    String(retrievalProfile.denseTopN),
    String(retrievalProfile.fusionK),
    String(retrievalProfile.finalTopK),
  );
  // Iterate the SSoT overlay map so a new mode-weights field automatically
  // participates in the hash and a removed field cannot drift the cache key.
  const rankingConfigHash = deterministicHash(
    indexVersionsHash,
    RANKING_POLICY_VERSION,
    effectiveRetrievalMode,
    ...MODE_WEIGHT_OVERLAY_MAP.map(({ modeField }) => String(modeWeights[modeField])),
  );

  // E1-T5: extended fields — reranker model ID prefers the explicit rerankDecision
  // record (E1-T4 typed contract), falling back to model_versions['reranker_model'].
  const rerankApplied = rankingMetadata?.rerankExecuted;
  const rerankModelId =
    rankingMetadata?.rerankDecision?.modelId
    ?? (rerankApplied === true ? (modelVersions['reranker_model'] ?? modelVersions['dense_model']) : undefined);

  return {
    plannerVersion: snapshot.planner_version,
    modelId: primaryModelId,
    modelVersionsHash,
    featureFlagsHash,
    fusionConfigHash,
    indexVersionsHash,
    rankingConfigHash,
    retrievalPlanVersion: retrievalPlanVersion(),
    rankingPolicyVersion: RANKING_POLICY_VERSION,
    policyRuleVersion: snapshot.policy_rule_version,
    thresholdProfileId: snapshot.threshold_profile_id,
    responseContractVersion: snapshot.response_contract_version,
    ...(rerankApplied !== undefined ? { rerankApplied } : {}),
    ...(rerankModelId !== undefined ? { rerankModelId } : {}),
  };
}

function buildResolverProvenanceTrace(
  resolveResult: EntityResolveResult,
): AuditExtension['resolver_provenance_trace'] {
  const provenance = resolveResult.decisionTrace.queryProvenance;
  if (provenance === undefined) {
    return undefined;
  }
  const candidateSourceBreakdown = provenance.candidateSourceBreakdown?.map((entry) => ({
    source: entry.source,
    entity_ids: entry.entityIds,
    count: entry.count,
  }));
  if (
    (candidateSourceBreakdown?.length ?? 0) === 0
    && provenance.blockerSeedEntityIds === undefined
    && provenance.blockerSeedCount === undefined
  ) {
    return undefined;
  }
  return {
    ...(candidateSourceBreakdown !== undefined && candidateSourceBreakdown.length > 0
      ? { candidate_source_breakdown: candidateSourceBreakdown }
      : {}),
    ...(provenance.blockerSeedEntityIds !== undefined
      ? { blocker_seed_entity_ids: provenance.blockerSeedEntityIds }
      : {}),
    ...(provenance.blockerSeedCount !== undefined
      ? { blocker_seed_count: provenance.blockerSeedCount }
      : {}),
  };
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
  readonly rankingMetadata?: RankingMetadata | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
  /** E4: RRF fusion trace from CandidatePoolService, when hybrid path was used. */
  readonly retrievalFusionTrace?: RrfFusionTrace | undefined;
  /** E4: Hard-filter drop log from CandidatePoolService.getLastDropLog(). */
  readonly hardFilterDropLog?: readonly CandidateDropRecord[] | undefined;
  /** TA5: Calibrated posterior confidence from corrective retry, when accepted. */
  readonly correctiveRetryCalibration?: number | undefined;
  /** When true (options.explain=true), counterfactuals are always included. */
  readonly includeCounterfactuals?: boolean | undefined;
}

export interface RankedRouteDecisionPhaseContext {
  readonly plan: QueryPlanV1;
  /** Compiled execution contract (E1-U3 carrier). When present, passed to ResponseBuilder for effectiveRetrievalMode. */
  readonly compiled?: CompiledWineQuery | undefined;
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
  readonly plannerSuggestedMode?: string | undefined;
  readonly includeCounterfactuals?: boolean | undefined;
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly rankingMetadata?: RankingMetadata | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
  /** E4: RRF fusion trace from the candidate pool, forwarded from the calling context. */
  readonly retrievalFusionTrace?: RrfFusionTrace | undefined;
  /** E4: Hard-filter drop log from CandidatePoolService.getLastDropLog(). */
  readonly hardFilterDropLog?: readonly CandidateDropRecord[] | undefined;
  /** TA5: Calibrated posterior confidence from corrective retry, when accepted. */
  readonly correctiveRetryCalibration?: number | undefined;
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
function resolveTargetYear(ctx: { readonly startTime: number; readonly nowYear?: number | undefined }): number {
  if (ctx.nowYear !== undefined && Number.isFinite(ctx.nowYear)) {
    return ctx.nowYear;
  }
  return new Date(ctx.startTime).getFullYear();
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
  const constraintReasonerOutput = new ConstraintReasoner().reason(ctx.plan.constraints);
  const mergedRouteDegradation = mergeRouteDegradation(
    snapshot,
    ctx.effectiveRoute,
    ctx.routeDegradation,
    ctx.resolveResult,
  );
  const decisionInputBase = buildSearchDecisionInput(
    ctx.plan,
    ctx.resolveResult,
    ctx.rankedResults,
    ctx.effectiveRoute,
    ctx.decisionContext,
    toAdmissionHonestyContract(mergedRouteDegradation),
    ctx.compiled?.execution.effectiveRetrievalMode,
  );
  // Propagate LTR saturation to decision engine so it can bypass
  // conformal prediction gating (calibrated on LTR, meaningless for heuristic).
  const decisionInput = ctx.rankingMetadata?.ltrSaturated === true
    ? { ...decisionInputBase, ltrSaturated: true }
    : decisionInputBase;
  pipelineDebug(
    {
      step: 'decision.engine.request',
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
  // RFC-019 Phase 7: Extract query-level sensory priors from compositional
  // inference so wines with sparse indexed sensory attributes can still
  // trigger drinking window prediction.
  const sensoryPriors =
    extractSensoryPriorsFromRetrievalPlan(ctx.compiled?.query.retrievalPlan)
    ?? extractSensoryPriorsFromConstraints(ctx.plan.constraints);
  const results = await mapRankedResultsToResultItems(
    ctx.rankedResults,
    ctx.drinkingWindow,
    resolveTargetYear(ctx),
    sensoryPriors,
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
  const queryFamily = deriveQueryFamily(ctx.plan, ctx.compiled);
  const obligation = getExplanationObligation(queryFamily);
  const shouldIncludeCounterfactuals =
    obligation.requiresCounterfactual || ctx.includeCounterfactuals !== false;
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
  // E4/TA5: hard_filter_drop_log and corrective_retry_calibrated_confidence are
  // forwarded from ctx when available (entity-only route with corrective retry).
  const auditExtension = deriveAuditExtension(
    ctx.compiled,
    ctx.rankingMetadata,
    ctx.fullRankedResults,
    ctx.retrievalFusionTrace,
    shouldEmitConstraintResolutionTrace(ctx.compiled)
      ? buildConstraintResolutionTrace(constraintReasonerOutput)
      : undefined,
    undefined,          // abstainDecision — no abstain in ranked path
    undefined,          // channelDegradation — not available in ranked phase context
    ctx.hardFilterDropLog,
    ctx.correctiveRetryCalibration,
    buildResolverProvenanceTrace(ctx.resolveResult),
  );
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
      ...(auditExtension !== undefined ? { auditExtension } : {}),
      determinismFingerprintParams: buildDeterminismFingerprintParams(
        snapshot,
        ctx.snapshotVersions,
        ctx.plan,
        ctx.compiled,
        ctx.rankingMetadata,
      ),
    });
  } catch (buildErr) {
    if (buildErr instanceof EvidenceObligationError) {
      throw buildErr;
    }
    // MUST NOT fabricate a 200 OK response for unexpected infrastructure failures
    // (Redis down, OOM, nil dereference, etc.). Per CLAUDE.md schema quality bar:
    // "Catch blocks in use-case code MUST NOT fabricate success-shaped (200 OK)
    // responses from unexpected errors."  Re-throw as DomainError so the HTTP
    // error handler maps it to 500 + RFC-014 envelope (mirrors hybrid.usecase.ts).
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
      step: 'post_route.enter',
      effective_route: ctx.effectiveRoute,
      resolve_status: ctx.resolveResult.status,
      ranked_count: ctx.rankedResults.length,
    },
    'pipeline post-route',
  );

  const cacheRequestContext = buildSearchCacheRequestContext(ctx.request);

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
  // returned zero lexical matches. Every candidate is dense-only.
  const sparseChannelHealthy = !degradationReasons.some((reason) => reason.startsWith('sparse_'));
  // Entity route doesn't use Vespa search (alias → resolver → PG), so
  // sparseRank is never populated. sparseZeroHits only applies to hybrid/
  // mixed routes where sparse BM25 was actually executed.
  const sparseZeroHits = ctx.effectiveRoute !== 'entity'
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
  // - LTR model loaded but saturated (all scores clamped to same value)
  // Heuristic scores cluster in [0.2, 0.6] → entropy ≈ 0.999 always.
  // Bypassing the entropy gate prevents 83%+ false-ambiguous rate.
  const ltrAvailable =
    snapshot.feature_flags['killSwitchLearning'] !== true
    && ctx.rankingMetadata?.ltrSaturated !== true;

  const abstainDecision = ctx.abstainPolicy.evaluate(
    topScores,
    reasonerOutput.relations,
    channelDegradation,
    { ltrAvailable },
    reasonerOutput.atoms,
  );

  // E4/E6/TA5: Derive AuditExtension after abstain evaluation so all traces
  // (retrieval_fusion_trace, abstain_policy_trace, hard_filter_drop_log,
  // corrective_retry_calibrated_confidence) can be populated in a single pass.
  const auditExtension = deriveAuditExtension(
    ctx.compiled,
    ctx.rankingMetadata,
    ctx.rankedResults,
    ctx.retrievalFusionTrace,
    shouldEmitConstraintResolutionTrace(ctx.compiled, ctx.request.options?.explain)
      ? buildConstraintResolutionTrace(reasonerOutput)
      : undefined,
    abstainDecision,
    channelDegradation,
    ctx.hardFilterDropLog,
    ctx.correctiveRetryCalibration,
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

  if (abstainDecision !== false) {
    const abstainEntropy = abstainDecision.entropy;
    pipelineDebug(
      {
        step: 'post_route.entropy_abstain',
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
      extractSensoryPriorsFromRetrievalPlan(ctx.compiled?.query.retrievalPlan)
      ?? extractSensoryPriorsFromConstraints(ctx.plan.constraints);
    const results = await mapRankedResultsToResultItems(
      limitedRankedResults,
      ctx.drinkingWindow,
      resolveTargetYear(ctx),
      sensoryPriorsAbstain,
    );
    // Provenance slices and counterfactuals use the FULL ranked results, not
    // the limited display set — eval analytics need every candidate's channel
    // mix, and counterfactuals need to surface entities BEYOND the visible
    // window (which is exactly the value of "why was this picked over X").
    const retrievalProvenanceSlices = rankedResultsToEvalProvenanceSlices(
      ctx.requestId,
      ctx.rankedResults,
    );
    const abstainCounterfactuals = ctx.includeCounterfactuals === true
      ? buildSearchCounterfactuals(ctx.resolveResult, ctx.rankedResults, { abstainContext: true })
      : [];
    try {
      // Fix D: buildEntropyAbstainResponseParams already includes compiled conditionally —
      // do not spread it again outside to avoid silent override if the builder ever transforms it.
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
          ...(auditExtension !== undefined ? { auditExtension } : {}),
          determinismFingerprintParams: buildDeterminismFingerprintParams(
            snapshot,
            ctx.snapshotVersions,
            ctx.plan,
            ctx.compiled,
            ctx.rankingMetadata,
          ),
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
  } else {
    response = await runRankedRouteDecisionPhase({
      plan: ctx.plan,
      ...(ctx.compiled !== undefined ? { compiled: ctx.compiled } : {}),
      requestId: ctx.requestId,
      startTime: ctx.startTime,
      resolveResult: ctx.resolveResult,
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
      ...(ctx.retrievalFusionTrace !== undefined ? { retrievalFusionTrace: ctx.retrievalFusionTrace } : {}),
      ...(ctx.hardFilterDropLog !== undefined && ctx.hardFilterDropLog.length > 0
        ? { hardFilterDropLog: ctx.hardFilterDropLog }
        : {}),
      ...(ctx.correctiveRetryCalibration !== undefined ? { correctiveRetryCalibration: ctx.correctiveRetryCalibration } : {}),
    });
  }

  // Shared structured log + cache write for both paths.
  const engineDecision = response.engineDecision as
    | SearchResponseV1['engineDecision']
    | undefined;
  const responseSnapshot = engineDecision?.decisionSnapshot;
  if (responseSnapshot !== undefined) {
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
          { step: 'cache.set_skipped', reason: abstainDecision !== false ? 'entropy_abstain' : 'ineligible_or_breaker' },
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
