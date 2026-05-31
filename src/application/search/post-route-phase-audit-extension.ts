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
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { RankingMetadata } from '../../domain/ranking/port/ranker.port.js';
import type { RrfFusionTrace } from '../../domain/retrieval/model/candidate-envelope.js';
import type { TypedAbstainDecision } from '../../domain/query/model/abstain-decision.js';
import type { ConstraintReasonerOutput } from '../../domain/query/service/constraint-reasoner.js';
import type { ChannelDegradationSummary } from '../../domain/query/model/abstain-decision.js';
import {
  deriveQueryFamily,
} from '../../domain/query/model/query-observability-vocab.js';
import type { SearchRouteRetrievalKind } from './search-usecase-route-dispatch.js';
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
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import { SOFT_INTENT_STRATEGY_VERSION } from '../../domain/query/service/soft-intent-strategy-table.js';
import type { SpecializedRouteObservability } from './specialized-route-observability.js';

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

export function deriveAuditExtension(
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

export function buildExecutionAuditTrace(
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

export function shouldEmitConstraintResolutionTrace(
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

export function buildConstraintResolutionTrace(
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
export function buildDeterminismFingerprintParams(
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

export function buildResolverProvenanceTrace(
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

export function mergeRouteDegradation(
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
