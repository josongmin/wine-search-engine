import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type {
  ExecutionLaneTrace,
  ExecutionRetrievalMode,
  ExecutionTopology,
} from '../../domain/query/model/engine-execution-contract.js';
import type { AuditExtension, PolicyOutcome } from '../../domain/audit/model/audit-extension.js';
import type { CandidateDropRecord } from '../../domain/retrieval/model/candidate-envelope.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { ResolvedCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { RankingMetadata } from '../../domain/ranking/port/ranker.port.js';
import type { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import type { RrfFusionTrace } from '../../domain/retrieval/model/candidate-envelope.js';
import type { TypedAbstainDecision } from '../../domain/query/model/abstain-decision.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { DecisionEnginePort, ResponseBuilderPort } from './port/search-pipeline-deps.port.js';
import type { DecisionOutput } from '../../domain/decision/model/decision-output.js';
import type { SearchRequest } from './search-request.dto.js';
import type { SearchRouteDecisionContext } from './search-usecase-route-dispatch.js';
import type {
  SearchExecutionLaneArtifacts,
  SearchExecutionLaneArtifactRef,
  SearchRouteRetrievalKind,
} from './search-usecase-route-dispatch.js';
import type {
  DualLaneArtifact,
  EntityLaneCandidateArtifact,
} from '../../domain/retrieval/model/dual-lane-artifact.js';
import { buildEntropyAbstainResponseParams } from './search-usecase-execute-builders.js';
import { buildSearchCacheRequestContext } from './search-usecase-cache-context.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { isCorruptedSnapshot } from '../../domain/shared/types/index.js';
import { ConstraintReasoner } from '../../domain/query/service/constraint-reasoner.js';
import type { ConstraintReasonerOutput } from '../../domain/query/service/constraint-reasoner.js';
import type { ChannelDegradationSummary } from '../../domain/query/model/abstain-decision.js';
import { buildAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import { deriveDecisionConfidenceSemantics } from '../../domain/shared/types/index.js';
import { evaluateAdmissionClosure } from '../../domain/decision/service/admission-gate.js';
import { DomainError, EvidenceObligationError } from '../../domain/shared/error/domain-error.js';
import { buildSearchCounterfactuals } from './search-usecase-counterfactuals.js';
import { getExplanationObligation } from '../../domain/response/service/explanation-obligation.js';
import {
  deriveQueryFamily,
  planToObservabilitySlice,
} from '../../domain/query/model/query-observability-vocab.js';
import { buildSearchDecisionInput } from './search-usecase-decision-input.js';
import type {
  AdmissionClosureSummary,
  DecisionInputCriticRewrite,
} from '../../domain/decision/model/decision-input.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { rankedResultsToEvalProvenanceSlices } from './search-usecase-eval-provenance.js';
import { mapRankedResultsToResultItems } from './search-usecase-map-result-items.js';
import type { ResultItemMappingOptions } from './search-usecase-map-result-items.js';
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
  LIVE_RETRIEVAL_POLICY_CONFIG_HASH,
  LIVE_RETRIEVAL_POLICY_VERSION,
} from '../../domain/retrieval/service/live-retrieval-policy-registry.js';
import {
  getFusionConfig,
  mapDomainQueryClassToFusionQueryClass,
} from '../../domain/retrieval/service/per-class-fusion-config.js';
import { RetrievalProfileService } from '../../domain/retrieval/service/retrieval-profile.js';
import { retrievalPlanVersion } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import { getModeWeights, MODE_WEIGHT_OVERLAY_MAP } from '../../domain/ranking/model/mode-weights.js';
import { RANKING_POLICY_VERSION } from '../../domain/ranking/service/ranker.js';
import { pipelineDebug } from '../../domain/observability/request-pipeline-debug.js';
import { PipelineDebugStep } from '../../domain/observability/pipeline-debug-steps.js';
import { logSearchEvent } from '../../domain/observability/log-search-event.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';

const ADMISSION_HEALTHY_DEGRADATION_REASONS = new Set([
  'mixed_constraint_guided_hybrid_fallback',
]);
import { SOFT_INTENT_STRATEGY_VERSION } from '../../domain/query/service/soft-intent-strategy-table.js';
import {
  toSpecializedRouteMeta,
  type SpecializedRouteObservability,
} from './specialized-route-observability.js';
import { classifyShortfallLayer } from '../../domain/shared/types/provenance-shortfall-taxonomy.js';
/** Number of top-ranked entity IDs captured in pre/post-rerank audit snapshots. */
const AUDIT_RERANK_SNAPSHOT_COUNT = 5;
const retrievalProfileService = new RetrievalProfileService();
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

function isDualLaneArtifact(
  artifact: SearchExecutionLaneArtifactRef,
): artifact is DualLaneArtifact {
  return (
    'lanePresence' in artifact &&
    'fusedCandidate' in artifact
  );
}

function findWinnerDualLaneArtifact(
  resolveResult: EntityResolveResult,
  fusedArtifacts: SearchExecutionLaneArtifacts['fused'],
): DualLaneArtifact | undefined {
  const winnerEntityId = resolveResult.topEntity?.entityId;
  if (winnerEntityId === undefined) {
    return undefined;
  }

  return fusedArtifacts.find(
    (artifact): artifact is DualLaneArtifact =>
      isDualLaneArtifact(artifact) && artifact.entityId === winnerEntityId,
  );
}

function isEntityLaneArtifact(
  artifact: SearchExecutionLaneArtifactRef,
): artifact is EntityLaneCandidateArtifact {
  return (
    'identityProvenance' in artifact &&
    'candidate' in artifact &&
    'resolvedCandidate' in artifact
  );
}

function hasWinnerAlignedIdentityResolveCandidate(
  identityResolveResult: EntityResolveResult | null | undefined,
  winnerEntityId: string,
): boolean {
  if (identityResolveResult == null) {
    return false;
  }
  const { candidates } = identityResolveResult;
  if (!Array.isArray(candidates)) {
    return false;
  }
  return candidates.some(
    (candidate: ResolvedCandidate) => candidate.entityId === winnerEntityId,
  );
}

function isWinnerAlignedEntityLaneArtifact(
  artifact: EntityLaneCandidateArtifact | undefined,
  winnerEntityId: string,
): artifact is EntityLaneCandidateArtifact {
  return artifact !== undefined
    && artifact.entityId === winnerEntityId
    && artifact.identityProvenance.entityId === winnerEntityId
    && artifact.candidate.entityId === winnerEntityId
    && artifact.resolvedCandidate.entityId === winnerEntityId;
}

function isWinnerAlignedDualLaneArtifact(
  artifact: DualLaneArtifact | undefined,
  winnerEntityId: string,
): artifact is DualLaneArtifact & { readonly identityProvenance: NonNullable<DualLaneArtifact['identityProvenance']> } {
  if (
    artifact === undefined
    || artifact.entityId !== winnerEntityId
    || artifact.fusedCandidate.entityId !== winnerEntityId
    || artifact.identityProvenance?.entityId !== winnerEntityId
  ) {
    return false;
  }

  if (
    artifact.entityLane !== undefined
    && !isWinnerAlignedEntityLaneArtifact(artifact.entityLane, winnerEntityId)
  ) {
    return false;
  }

  return artifact.generalLane === undefined
    || (
      artifact.generalLane.entityId === winnerEntityId
      && artifact.generalLane.candidate.entityId === winnerEntityId
    );
}

function findWinnerIdentityLaneArtifact(
  resolveResult: EntityResolveResult,
  identityArtifacts: SearchExecutionLaneArtifacts['identity'],
): EntityLaneCandidateArtifact | undefined {
  const winnerEntityId = resolveResult.topEntity?.entityId;
  if (winnerEntityId === undefined) {
    return undefined;
  }

  return identityArtifacts.find(
    (artifact): artifact is EntityLaneCandidateArtifact =>
      isEntityLaneArtifact(artifact) && artifact.entityId === winnerEntityId,
  );
}

function resolveWinnerAlignedDualLaneArtifact(params: {
  readonly executionTopology: ExecutionTopology;
  readonly identityResolveResult: EntityResolveResult | null;
  readonly resolveResult: EntityResolveResult;
  readonly fusedArtifacts: SearchExecutionLaneArtifacts['fused'];
}): DualLaneArtifact | undefined {
  if (
    params.executionTopology !== 'dual_lane'
    || params.identityResolveResult === null
  ) {
    return undefined;
  }

  const winnerDualLaneArtifact = findWinnerDualLaneArtifact(
    params.resolveResult,
    params.fusedArtifacts,
  );
  const winnerEntityId = params.resolveResult.topEntity?.entityId;
  if (
    winnerEntityId === undefined
    || !hasWinnerAlignedIdentityResolveCandidate(params.identityResolveResult, winnerEntityId)
    || !isWinnerAlignedDualLaneArtifact(winnerDualLaneArtifact, winnerEntityId)
  ) {
    return undefined;
  }

  return winnerDualLaneArtifact;
}

function resolveWinnerAlignedIdentityArtifact(params: {
  readonly executionTopology: ExecutionTopology;
  readonly identityResolveResult: EntityResolveResult | null;
  readonly resolveResult: EntityResolveResult;
  readonly identityArtifacts: SearchExecutionLaneArtifacts['identity'];
}): EntityLaneCandidateArtifact | undefined {
  if (params.identityResolveResult === null) {
    return undefined;
  }

  const winnerIdentityArtifact = findWinnerIdentityLaneArtifact(
    params.resolveResult,
    params.identityArtifacts,
  );
  const winnerEntityId = params.resolveResult.topEntity?.entityId;
  if (
    winnerEntityId === undefined
    || !hasWinnerAlignedIdentityResolveCandidate(params.identityResolveResult, winnerEntityId)
    || !isWinnerAlignedEntityLaneArtifact(winnerIdentityArtifact, winnerEntityId)
  ) {
    return undefined;
  }

  return winnerIdentityArtifact;
}

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
  compiled: CompiledWineQuery,
  rankingMetadata: RankingMetadata | undefined,
  rankedResults: readonly RankedResult[],
  executionTrace: AuditExtension['execution_trace'] | undefined,
  retrievalFusionTrace?: RrfFusionTrace,
  constraintResolutionTrace?: AuditExtension['constraint_resolution_trace'],
  abstainDecision?: TypedAbstainDecision | false,
  channelDegradation?: ChannelDegradationSummary,
  hardFilterDropLog?: readonly CandidateDropRecord[],
  correctiveRetryCalibration?: number,
  resolverProvenanceTrace?: AuditExtension['resolver_provenance_trace'],
): AuditExtension | undefined {
  const plannerTrace = compiled.plannerTrace;
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
    executionTrace === undefined
    && (plannerTrace == null || plannerTrace.length === 0)
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
    ...(executionTrace !== undefined
      ? { execution_trace: executionTrace }
      : {}),
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

function resolveResultItemMappingOptions(
  effectiveRetrievalMode: ExecutionRetrievalMode,
): ResultItemMappingOptions | undefined {
  return effectiveRetrievalMode === 'recommendation'
    ? { maxPredictions: RECOMMENDATION_DRINKING_WINDOW_PREDICTION_LIMIT }
    : undefined;
}

function buildExecutionAuditTrace(
  effectiveRoute: QueryRoute,
  retrievalModeSource: 'planner' | 'api_override',
  routeExecutionFacts: {
    readonly executionTopology: ExecutionTopology;
    readonly laneTrace: ExecutionLaneTrace;
    readonly effectiveRetrievalMode: ExecutionRetrievalMode;
    readonly retrievalKind: SearchRouteRetrievalKind;
    readonly sparseExecuted: boolean;
    readonly specializedRouteExecuted: SpecializedRouteObservability['specializedRouteExecuted'] | undefined;
    readonly usedCompiledExecution: boolean;
  },
  rankingMetadata: RankingMetadata | undefined,
  compiled: CompiledWineQuery,
): NonNullable<AuditExtension['execution_trace']> {
  const executionBudget = compiled.execution.budget;
  const provenancePolicy = compiled.execution.provenancePolicy;
  const provenanceClosure = rankingMetadata?.provenanceClosure;
  const rerankLimit = Number.isFinite(executionBudget.rerankLimit)
    ? executionBudget.rerankLimit
    : 0;

  return {
    effective_route: effectiveRoute,
    execution_topology: routeExecutionFacts.executionTopology,
    retrieval_mode_source: retrievalModeSource,
    effective_retrieval_mode: routeExecutionFacts.effectiveRetrievalMode,
    retrieval_kind: routeExecutionFacts.retrievalKind,
    sparse_executed: routeExecutionFacts.sparseExecuted,
    ...(routeExecutionFacts.specializedRouteExecuted !== undefined
      ? { specialized_route_executed: routeExecutionFacts.specializedRouteExecuted }
      : {}),
    used_compiled_execution: routeExecutionFacts.usedCompiledExecution,
    compiled_budget: {
      max_candidates: executionBudget.maxCandidates,
      rerank_limit: rerankLimit,
      enable_precision_rerank: executionBudget.enablePrecisionRerank,
    },
    provenance_policy: {
      require_identity_seal: provenancePolicy.requireIdentitySeal,
      require_constraint_evidence: provenancePolicy.requireConstraintEvidence,
      require_anchor_evidence: provenancePolicy.requireAnchorEvidence,
    },
    lane_trace: routeExecutionFacts.laneTrace,
    ...(provenanceClosure !== undefined
      ? { provenance_closure: provenanceClosure }
      : {}),
  };
}

function shouldEmitConstraintResolutionTrace(
  compiled: CompiledWineQuery,
  requestExplain?: boolean,
): boolean {
  return requestExplain === true || (compiled.plannerTrace?.length ?? 0) > 0;
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
  compiled: CompiledWineQuery,
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
  const effectiveRetrievalMode = compiled.execution.effectiveRetrievalMode;
  const effectiveRoute = compiled.execution.effectiveRoute;
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
    LIVE_RETRIEVAL_POLICY_VERSION,
    LIVE_RETRIEVAL_POLICY_CONFIG_HASH,
    SOFT_INTENT_STRATEGY_VERSION,
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
    String(compiled.execution.budget.maxCandidates),
  );
  // Iterate the SSoT overlay map so a new mode-weights field automatically
  // participates in the hash and a removed field cannot drift the cache key.
  const rankingConfigHash = deterministicHash(
    indexVersionsHash,
    RANKING_POLICY_VERSION,
    effectiveRetrievalMode,
    String(compiled.execution.budget.enablePrecisionRerank),
    String(compiled.execution.budget.rerankLimit),
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
  fusedResolveResult: EntityResolveResult,
): AuditExtension['resolver_provenance_trace'] {
  const provenance = fusedResolveResult.decisionTrace.queryProvenance;
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
  fusedResolveResult?: EntityResolveResult,
): RankingDegradationSignal | undefined {
  const reasons = new Set([
    ...(routeDegradation?.degradationReasons ?? []),
    ...(fusedResolveResult?.degradation?.reasons ?? []),
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
  /** TA5: Calibrated posterior confidence from corrective retry, when accepted. */
  readonly correctiveRetryCalibration?: number | undefined;
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
  /** TA5: Calibrated posterior confidence from corrective retry, when accepted. */
  readonly correctiveRetryCalibration?: number | undefined;
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

function shouldIncludeCounterfactualsForRequest(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  includeCounterfactuals: boolean | undefined,
): boolean {
  const queryFamily = deriveQueryFamily(plan, compiled);
  const obligation = getExplanationObligation(queryFamily);
  return obligation.requiresCounterfactual || includeCounterfactuals !== false;
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
    routeHealthy: routeDegradation.degradationReasons.every((reason) =>
      ADMISSION_HEALTHY_DEGRADATION_REASONS.has(reason),
    ),
  };
}

function buildResponseExecutionContract(
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
  // E4/TA5: hard_filter_drop_log and corrective_retry_calibrated_confidence are
  // forwarded from ctx when available (entity-only route with corrective retry).
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
    ctx.correctiveRetryCalibration,
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

  // E4/E6/TA5: Derive AuditExtension after abstain evaluation so all traces
  // (retrieval_fusion_trace, abstain_policy_trace, hard_filter_drop_log,
  // corrective_retry_calibrated_confidence) can be populated in a single pass.
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

  // entity_lookup contract: when the caller passes options.clarification=false
  // (forced by toLookupRequest for /v1/search/lookup), suppress the
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
      ...(ctx.correctiveRetryCalibration !== undefined ? { correctiveRetryCalibration: ctx.correctiveRetryCalibration } : {}),
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
