import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type {
  ExecutionRetrievalMode,
  ProvenancePolicy,
} from '../../domain/query/model/engine-execution-contract.js';
import { isExploratoryRetrievalMode } from '../../domain/query/model/retrieval-mode-classification.js';
import type { ConstraintGraph } from '../../domain/query/model/constraint-graph.js';
import { resolveRequiredAttributes } from '../../domain/query/service/graph-required-attributes.js';
import { isConstraintGraphEmitEnabled } from '../../domain/query/service/constraint-graph-flags.js';
import type {
  DualLanePresence,
  DualLaneArtifact,
  EntityLaneCandidateArtifact,
} from '../../domain/retrieval/model/dual-lane-artifact.js';
import {
  classifyGraphPresence,
  recordGraphPathDecision,
} from '../../domain/observability/graph-path-telemetry.js';
import {
  type AmbiguitySummary,
  type DecisionInput,
  type DecisionInputCriticRewrite,
  type EvidenceSummary,
  hasAnchorEvidence,
  hasConstraintEvidence,
  hasIdentityEvidence,
} from '../../domain/decision/model/decision-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import {
  extractSingleTokenNormalizedQuery,
  resolveAmbiguousBranchLabel,
  shouldApplyCanonicalFamilyBranchPrior,
} from '../../domain/ranking/service/ambiguous-branch.js';
import type { EvidenceItem, SignalSet } from '../../domain/shared/types/index.js';
import type { SearchRouteDecisionContext } from './search-usecase-route-dispatch.js';
import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY
} from '../../domain/retrieval/model/retrieval-channel.js';

interface BuildSearchDecisionInputParams {
  readonly plan: QueryPlanV1;
  readonly resolveResult: EntityResolveResult;
  readonly identityResolveResult?: EntityResolveResult | null | undefined;
  readonly rankedResults?: readonly RankedResult[];
  readonly effectiveRoute?: QueryRoute | undefined;
  readonly decisionContext?: SearchRouteDecisionContext | undefined;
  readonly executionContext?: {
    readonly effectiveRetrievalMode?: ExecutionRetrievalMode | undefined;
    readonly retrievalKind?:
      | 'entity_lookup'
      | 'generic_hybrid'
      | 'specialized_hybrid'
      | 'mixed_similarity'
      | undefined;
    readonly provenancePolicy?: ProvenancePolicy | undefined;
    readonly constraintGraph?: ConstraintGraph | undefined;
    readonly criticRewrites?: readonly DecisionInputCriticRewrite[] | undefined;
    readonly winnerDualLaneArtifact?: DualLaneArtifact | undefined;
    readonly winnerIdentityArtifact?: EntityLaneCandidateArtifact | undefined;
    /**
     * Constraint-extraction categories pulled from the compiled query
     * (`CompiledWineQuery.query.constraintExtraction.categoriesCovered`).
     * The V1 plan strips this in `PlannerV1Adapter`; callers thread it
     * through `executionContext` so the decision-engine's preference-mode
     * unlock + CalibrationTrustGate exploratory bypass can see the
     * extractor's semantic signal.
     */
    readonly categoriesCovered?: readonly string[] | undefined;
  };
  readonly honestyContract?: {
    readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory' | undefined;
    readonly routeHealthy?: boolean | undefined;
    readonly blockingRequested?: boolean | undefined;
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isPositiveEvidenceItem(item: EvidenceItem): boolean {
  return item.contribution.startsWith('+');
}

function hasWinnerAlignedIdentityResolveTopEntity(
  identityResolveResult: EntityResolveResult | null | undefined,
  winnerEntityId: string,
): boolean {
  if (identityResolveResult == null) {
    return true;
  }

  return identityResolveResult.topEntity?.entityId === winnerEntityId;
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

function buildWinnerIdentityEvidence(params: {
  readonly resolveResult: EntityResolveResult;
  readonly identityResolveResult?: EntityResolveResult | null | undefined;
  readonly winnerDualLaneArtifact?: DualLaneArtifact | undefined;
  readonly winnerIdentityArtifact?: EntityLaneCandidateArtifact | undefined;
  readonly allowIdentityArtifactTrust: boolean;
}): NonNullable<EvidenceSummary['identityEvidence']> {
  const resolveTopEntity = params.resolveResult.topEntity;
  if (!params.allowIdentityArtifactTrust) {
    return {
      source: 'identity_artifact',
      resolveTopEntityPresent: resolveTopEntity !== undefined,
      winnerIdentityArtifactPresent: false,
      winnerIdentityArtifactMatchesResolveResult: false,
      exactnessTier: 'none',
      identityEvidenceRefCount: 0,
    };
  }

  const winnerEntityId = resolveTopEntity?.entityId;
  const winnerInIdentityResolveResult =
    winnerEntityId !== undefined
    && hasWinnerAlignedIdentityResolveTopEntity(params.identityResolveResult, winnerEntityId);
  const winnerDualLaneArtifact =
    winnerEntityId !== undefined
    && winnerInIdentityResolveResult
    && isWinnerAlignedDualLaneArtifact(params.winnerDualLaneArtifact, winnerEntityId)
      ? params.winnerDualLaneArtifact
      : undefined;
  const winnerIdentityLaneArtifact =
    winnerDualLaneArtifact === undefined
    && winnerEntityId !== undefined
    && winnerInIdentityResolveResult
    && isWinnerAlignedEntityLaneArtifact(params.winnerIdentityArtifact, winnerEntityId)
      ? params.winnerIdentityArtifact
      : undefined;
  const winnerIdentityArtifactPresent =
    winnerDualLaneArtifact !== undefined || winnerIdentityLaneArtifact !== undefined;
  const identityEvidenceRefCount =
    winnerDualLaneArtifact?.identityProvenance.evidenceRefs.length
    ?? winnerIdentityLaneArtifact?.identityProvenance.evidenceRefs.length
    ?? 0;
  const lanePresence: DualLanePresence | undefined =
    winnerDualLaneArtifact?.lanePresence ?? winnerIdentityLaneArtifact?.candidate.lanePresence;
  const exactnessTier =
    winnerDualLaneArtifact?.identityProvenance.exactnessTier
    ?? winnerIdentityLaneArtifact?.identityProvenance.exactnessTier
    ?? 'none';

  return {
    source: 'identity_artifact',
    resolveTopEntityPresent: resolveTopEntity !== undefined,
    winnerIdentityArtifactPresent,
    winnerIdentityArtifactMatchesResolveResult:
      winnerIdentityArtifactPresent && winnerInIdentityResolveResult,
    exactnessTier,
    identityEvidenceRefCount,
    ...(lanePresence !== undefined ? { lanePresence } : {}),
  };
}

function shouldProjectIdentityArtifactTrust(params: {
  readonly effectiveRoute: QueryRoute;
  readonly effectiveRetrievalMode?: ExecutionRetrievalMode | undefined;
  readonly retrievalKind?:
    | 'entity_lookup'
    | 'generic_hybrid'
    | 'specialized_hybrid'
    | 'mixed_similarity'
    | undefined;
}): boolean {
  if (params.retrievalKind === 'entity_lookup') {
    return true;
  }
  if (
    params.effectiveRetrievalMode === undefined
    && params.retrievalKind === undefined
  ) {
    return true;
  }
  return params.effectiveRoute === 'entity'
    || params.effectiveRetrievalMode === 'entity_lookup'
    || params.effectiveRetrievalMode === 'entity_resolution';
}

function buildRankingBranchGroups(
  plan: QueryPlanV1,
): readonly { label: string; matchValues: readonly string[] }[] {
  return plan.expansions.ambiguousEntityHints?.flatMap((hint) =>
    hint.explorationBranches.map((branch) => ({
      label: branch.label,
      matchValues: branch.matchValues,
    })),
  ) ?? [];
}

function buildRankingAmbiguitySummary(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[] | undefined,
): AmbiguitySummary | undefined {
  if (rankedResults === undefined || rankedResults.length < 2) {
    return undefined;
  }
  if (!shouldApplyCanonicalFamilyBranchPrior(plan.queryClass)) {
    return undefined;
  }
  if (extractSingleTokenNormalizedQuery(plan.normalizedQuery) === undefined) {
    return undefined;
  }
  const branchGroups = buildRankingBranchGroups(plan);
  if (branchGroups.length === 0) {
    return undefined;
  }

  const representedBranches = rankedResults
    .slice(0, 3)
    .map((result) => resolveAmbiguousBranchLabel(result, branchGroups))
    .filter((label): label is string => label !== undefined);
  const uniqueBranches = unique(representedBranches);
  if (uniqueBranches.length < 2) {
    return undefined;
  }

  const topTwoDifferentBranches =
    representedBranches[0] !== undefined &&
    representedBranches[1] !== undefined &&
    representedBranches[0] !== representedBranches[1];

  return {
    types: ['ranking_family_branch_collision'],
    severity: topTwoDifferentBranches ? 'high' : 'medium',
    sources: ['ranking'],
    decisionEffect: topTwoDifferentBranches ? 'force_clarify' : 'raise_threshold',
  };
}

/**
 * Assembles {@link DecisionInput} from planner output, resolver output, and optional ranking.
 * RFC-007 §4 — ranking signals and evidence wiring for the Decision Engine.
 *
 * doc_guard E3-U6: Calibrator insertion point is NOT here.
 * Score calibration for ranked routes must be applied in
 * search-usecase-ranked-route-resolve.ts (buildRankedRouteResolveResult),
 * before decisionTrace/confidence scores are emitted. This function receives
 * already-calibrated resolver output and must not re-calibrate or adjust scores.
 */
export function buildSearchDecisionInput(
  params: BuildSearchDecisionInputParams,
): DecisionInput {
  const {
    plan,
    resolveResult,
    identityResolveResult,
    rankedResults,
    effectiveRoute = plan.route,
    decisionContext,
    executionContext,
    honestyContract,
  } = params;
  const topResult = rankedResults?.[0];
  const topEntity = resolveResult.topEntity;
  const allowIdentityArtifactTrust = shouldProjectIdentityArtifactTrust({
    effectiveRoute,
    effectiveRetrievalMode: executionContext?.effectiveRetrievalMode,
    retrievalKind: executionContext?.retrievalKind,
  });
  const identityEvidence = buildWinnerIdentityEvidence({
    resolveResult,
    identityResolveResult,
    winnerDualLaneArtifact: executionContext?.winnerDualLaneArtifact,
    winnerIdentityArtifact: executionContext?.winnerIdentityArtifact,
    allowIdentityArtifactTrust,
  });
  const identityEvidenceRefCount = identityEvidence.identityEvidenceRefCount;

  const rankingSignals: SignalSet | undefined =
    topResult !== undefined
      ? {
          entity_integrity_score: topResult.componentScores.entityIntegrity,
          hard_constraint_pass: topResult.componentScores.hardConstraintPass ? 1 : 0,
          soft_constraint_score: topResult.componentScores.softConstraint,
          ...(topResult.componentScores.semantic !== undefined
            ? { semantic_relevance_score: topResult.componentScores.semantic }
            : {}),
          ...(topResult.componentScores.preferenceAlignment !== undefined
            ? { preference_alignment_score: topResult.componentScores.preferenceAlignment }
            : {}),
          ...(topResult.componentScores.popularity !== undefined
            ? { popularity_score: topResult.componentScores.popularity }
            : {}),
          ...(topResult.componentScores.availability !== undefined
            ? { availability_score: topResult.componentScores.availability }
            : {}),
          uncertainty_penalty: topResult.componentScores.uncertaintyPenalty,
        }
      : undefined;

  const rankedTopResultMatchesTopEntity =
    topResult !== undefined &&
    topEntity !== undefined &&
    topResult.entityId === topEntity.entityId;
  // ADR-011 Phase 1b.3a: when a ConstraintGraph is threaded through
  // `executionContext.constraintGraph`, matched/unmet attributes are resolved
  // via the shared helper under AND / OR / XOR group semantics so
  // provenance-closure and decision-input stay in lockstep. In the flat path
  // the computation is unchanged from pre-Phase-1b.3a behaviour.
  const requiredConstraintAttributes = unique(
    plan.constraints.hard.map((constraint) => constraint.attribute),
  );
  const constraintGraph = executionContext?.constraintGraph;
  // Wave G2: emit unified graph-path telemetry for the decision reader.
  recordGraphPathDecision({
    reader: 'decision_input',
    outcome: classifyGraphPresence({
      graphPresent: constraintGraph !== undefined,
      ...(constraintGraph !== undefined ? { graphOrigin: constraintGraph.origin } : {}),
      graphEmitFlagOn: isConstraintGraphEmitEnabled(),
    }),
  });
  const graphResolution =
    constraintGraph !== undefined && topResult !== undefined
      ? resolveRequiredAttributes({
          plan,
          graph: constraintGraph,
          satisfiedAttributes: topResult.matchedConstraints,
        })
      : undefined;
  const matchedRequiredAttributes =
    graphResolution !== undefined
      ? graphResolution.matched
      : topResult !== undefined
      ? unique(
          topResult.matchedConstraints.filter((attribute) =>
            requiredConstraintAttributes.includes(attribute),
          ),
        )
      : [];
  const unmetRequiredAttributes =
    graphResolution !== undefined
      ? graphResolution.unmet
      : topResult !== undefined
      ? unique(
          topResult.unmetConstraints.filter((attribute) =>
            requiredConstraintAttributes.includes(attribute),
          ),
        )
      : [];
  const anchorSignalItems =
    topResult !== undefined && rankedTopResultMatchesTopEntity
      ? topResult.evidenceItems.filter(
          (item) => item.type === RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY && isPositiveEvidenceItem(item),
        )
      : [];
  const anchorSignalTypes =
    anchorSignalItems.length > 0
      ? unique(anchorSignalItems.map((item) => item.type))
      : [];

  const constraintEvidence =
    topResult !== undefined
      ? {
          requiredAttributes: requiredConstraintAttributes,
          matchedRequiredAttributes,
          unmetRequiredAttributes,
          inferredAttributes: unique(topResult.inferredConstraints),
          matchedRequiredAttributeCount: matchedRequiredAttributes.length,
          unmetRequiredAttributeCount: unmetRequiredAttributes.length,
        }
      : undefined;

  const anchorEvidenceRequired = effectiveRoute === 'mixed' && plan.anchors.length > 0;
  const mixedAnchor = decisionContext?.mixedAnchor;
  const anchorEvidence = anchorEvidenceRequired
    ? {
        topEntityPresent: topEntity !== undefined,
        ...(topResult !== undefined ? { rankedTopResultPresent: true } : {}),
        ...(topResult !== undefined && topEntity !== undefined
          ? { rankedTopResultMatchesTopEntity }
          : {}),
        ...(topResult !== undefined
          ? {
              rankedSignalPresent:
                (topResult.componentScores.anchorSimilarity ?? 0) > 0 ||
                anchorSignalTypes.length > 0,
              ...(anchorSignalTypes.length > 0
                ? {
                    rankedSignalItemCount: anchorSignalItems.length,
                    rankedSignalTypes: anchorSignalTypes,
                  }
                : {}),
            }
          : {}),
      }
    : undefined;
  const anchorResolution = anchorEvidenceRequired
    ? {
        anchorEntityPresent: mixedAnchor !== undefined,
        ...(mixedAnchor !== undefined
          ? {
              anchorEntityId: mixedAnchor.entityId,
              anchorCanonicalLabel: mixedAnchor.canonicalLabel,
              anchorConfidence: mixedAnchor.confidence,
            }
          : {}),
      }
    : undefined;

  // SSoT for the `effectiveRoute === 'mixed'` identity-seal default: a mixed
  // route only needs an identity seal when the executed retrieval MODE is
  // identity-bearing (entity_lookup / entity_resolution). Exploratory modes
  // — similarity, recommendation, browsing — under mixed route are list-shaped
  // by construction (`마고 비슷한 레드` = "red wines similar to Margaux"),
  // and identity_seal makes no semantic claim there. See
  // `domain/query/model/retrieval-mode-classification.ts` (the same set is
  // consumed by `decision-engine.applyPolicyOverlay` for require-approximate
  // gating, so the policy and the gate cannot drift).
  const mixedRouteIdentityRequired =
    effectiveRoute === 'mixed' &&
    !isExploratoryRetrievalMode(executionContext?.effectiveRetrievalMode);
  const provenancePolicy = executionContext?.provenancePolicy ?? {
    requireIdentitySeal:
      plan.admission_context?.requires_identity_seal === true ||
      mixedRouteIdentityRequired,
    requireConstraintEvidence:
      plan.admission_context?.requires_constraint_evidence === true ||
      plan.constraints.hard.length > 0,
    requireAnchorEvidence:
      plan.admission_context?.requires_anchor_evidence === true ||
      anchorEvidenceRequired,
  };
  const evidenceSummaryBase: EvidenceSummary = {
    identityEvidencePresent: false,
    identityEvidence,
    ...(constraintEvidence !== undefined ? { constraintEvidence } : {}),
    ...(anchorResolution !== undefined ? { anchorResolution } : {}),
    ...(anchorEvidence !== undefined ? { anchorEvidence } : {}),
    ...((identityEvidenceRefCount > 0 || topResult !== undefined)
      ? {
          evidenceRefCount:
            identityEvidenceRefCount +
            (topResult !== undefined ? topResult.evidenceItems.length : 0),
        }
      : {}),
  };
  const evidenceSummary: EvidenceSummary = {
    ...evidenceSummaryBase,
    identityEvidencePresent: hasIdentityEvidence(evidenceSummaryBase),
    ...(constraintEvidence !== undefined
      ? { constraintEvidencePresent: hasConstraintEvidence(evidenceSummaryBase) }
      : {}),
    ...(anchorEvidence !== undefined
      ? { anchorEvidencePresent: hasAnchorEvidence(evidenceSummaryBase) }
      : {}),
  };
  const provenanceContract = {
    policy: provenancePolicy,
    observed: {
      identityEvidenceSatisfied: hasIdentityEvidence(evidenceSummary),
      constraintEvidenceSatisfied: hasConstraintEvidence(evidenceSummary),
      anchorEvidenceSatisfied: hasAnchorEvidence(evidenceSummary),
      topEntityPresent: topEntity !== undefined,
      rankedTopResultPresent: topResult !== undefined,
      ...(topResult !== undefined && topEntity !== undefined
        ? { rankedTopResultMatchesTopEntity }
        : {}),
      matchedConstraintAttributes: matchedRequiredAttributes,
      unmetConstraintAttributes: unmetRequiredAttributes,
      anchorSignalTypes,
    },
    missing: [
      ...(provenancePolicy.requireIdentitySeal && !hasIdentityEvidence(evidenceSummary)
        ? ['identity_evidence' as const]
        : []),
      ...(provenancePolicy.requireConstraintEvidence && !hasConstraintEvidence(evidenceSummary)
        ? ['constraint_evidence' as const]
        : []),
      ...(provenancePolicy.requireAnchorEvidence && !hasAnchorEvidence(evidenceSummary)
        ? ['anchor_evidence' as const]
        : []),
    ],
  } as const;
  const ambiguitySummary = buildRankingAmbiguitySummary(plan, rankedResults);

  return {
    queryPlan: plan,
    effectiveRoute,
    ...(executionContext?.effectiveRetrievalMode !== undefined
      ? { effectiveRetrievalMode: executionContext.effectiveRetrievalMode }
      : {}),
    ...(executionContext?.retrievalKind !== undefined
      ? { retrievalKind: executionContext.retrievalKind }
      : {}),
    resolveResult,
    ...(identityResolveResult != null
      ? { identityResolveResult }
      : { identityResolveResult: undefined }),
    policy: plan.policy,
    uncertainty: plan.uncertainty,
    provenanceContract,
    ...(honestyContract?.executionMode !== undefined
      ? { executionMode: honestyContract.executionMode }
      : {}),
    ...(honestyContract?.routeHealthy !== undefined
      ? { routeHealthy: honestyContract.routeHealthy }
      : {}),
    ...(honestyContract?.blockingRequested !== undefined
      ? { blockingRequested: honestyContract.blockingRequested }
      : {}),
    ...(rankingSignals !== undefined ? { rankingSignals } : {}),
    ...(ambiguitySummary !== undefined ? { ambiguitySummary } : {}),
    evidenceSummary,
    ...(topResult !== undefined ? { evidenceItems: topResult.evidenceItems } : {}),
    conformalSetSize: resolveResult.conformalSetSize,
    ...(executionContext?.criticRewrites !== undefined
      && executionContext.criticRewrites.length > 0
      ? { criticRewrites: executionContext.criticRewrites }
      : {}),
    // T1.2 plan-V1 strips constraintExtraction; the post-route phase
    // supplies categoriesCovered from `compiled.query.constraintExtraction
    // .categoriesCovered` via executionContext. Empty list is dropped to
    // keep DecisionInput diffs minimal when no semantic vocabulary matched
    // (gibberish / pure-noise queries).
    ...(executionContext?.categoriesCovered !== undefined
      && executionContext.categoriesCovered.length > 0
      ? { categoriesCovered: executionContext.categoriesCovered }
      : {}),
  };
}
