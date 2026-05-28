import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type {
  ExecutionProvenanceClosure,
  MissingProvenanceObligation,
  ProvenanceCoverageStage,
  ProvenancePolicy,
} from '../../domain/query/model/engine-execution-contract.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { ConstraintGraph } from '../../domain/query/model/constraint-graph.js';
import { resolveRequiredAttributes } from '../../domain/query/service/graph-required-attributes.js';
import { isConstraintGraphEmitEnabled } from '../../domain/query/service/constraint-graph-flags.js';
import { RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY } from '../../domain/retrieval/model/retrieval-channel.js';
import {
  classifyGraphPresence,
  recordGraphPathDecision,
} from '../../domain/observability/graph-path-telemetry.js';

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Wave G2: shared outcome-derivation so each reader stays one-liner. */
function recordGraphPath(
  reader: 'provenance_closure' | 'decision_input' | 'ranker_hard_gate'
    | 'ranker_soft_weight' | 'pre_rank_coverage' | 'graph_executor' | 'bundle_selector',
  graph: ConstraintGraph | undefined,
): void {
  const outcome = classifyGraphPresence({
    graphPresent: graph !== undefined,
    ...(graph !== undefined ? { graphOrigin: graph.origin } : {}),
    graphEmitFlagOn: isConstraintGraphEmitEnabled(),
  });
  recordGraphPathDecision({ reader, outcome });
}

/**
 * ADR-011 Phase 1b.3a: coverage extraction now delegates to
 * {@link resolveRequiredAttributes} so this reader shares its graph-vs-flat
 * contract with `search-usecase-decision-input.ts`. The
 * `ProvenanceCoverageStage` response shape is unchanged — graph-aware logic
 * is an internal implementation detail; callers see the same flat
 * `matched/unmetConstraintAttributes: readonly string[]` contract.
 */

export function buildHybridCandidateCoverageStage(
  plan: QueryPlanV1,
  candidates: readonly HybridCandidate[],
  policy: ProvenancePolicy,
  graph?: ConstraintGraph,
): ProvenanceCoverageStage {
  recordGraphPath('provenance_closure', graph);
  const satisfied = candidates.flatMap((candidate) => candidate.matchedConstraints);
  const resolution = resolveRequiredAttributes({
    plan,
    ...(graph !== undefined ? { graph } : {}),
    satisfiedAttributes: satisfied,
  });
  const anchorSignalTypes = unique(
    candidates.flatMap((candidate) =>
      candidate.anchorRank !== undefined ||
      candidate.retrievalProvenance?.channels.includes(RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY) === true
        ? [RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY]
        : []),
  );
  const hasIdentityEvidence = candidates.some((candidate) => {
    const protectedReason = candidate.retrievalProvenance?.protectedInclusionReason;
    return protectedReason === 'exact_alias_match' || protectedReason === 'known_item_lookup';
  });

  return {
    candidateCount: candidates.length,
    identityEvidenceSatisfied: !policy.requireIdentitySeal || hasIdentityEvidence,
    constraintEvidenceSatisfied:
      !policy.requireConstraintEvidence || resolution.satisfied,
    anchorEvidenceSatisfied:
      !policy.requireAnchorEvidence ||
      anchorSignalTypes.length > 0,
    matchedConstraintAttributes: resolution.matched,
    unmetConstraintAttributes: resolution.unmet,
    anchorSignalTypes,
  };
}

export function buildRankedResultCoverageStage(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  policy: ProvenancePolicy,
  graph?: ConstraintGraph,
): ProvenanceCoverageStage {
  recordGraphPath('provenance_closure', graph);
  const topResult = rankedResults[0];
  const satisfied = topResult === undefined ? [] : topResult.matchedConstraints;
  const resolution = resolveRequiredAttributes({
    plan,
    ...(graph !== undefined ? { graph } : {}),
    satisfiedAttributes: satisfied,
  });

  const anchorSignalTypes = topResult === undefined
    ? []
    : unique(
        topResult.evidenceItems.flatMap((item) =>
          item.type === RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY || (topResult.componentScores.anchorSimilarity ?? 0) > 0
            ? [RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY]
            : [],
        ),
      );
  const protectedReason = topResult?.retrievalProvenance?.protectedInclusionReason;
  const hasIdentityEvidence =
    protectedReason === 'exact_alias_match' ||
    protectedReason === 'known_item_lookup' ||
    topResult?.evidenceItems.some((item) => item.type === 'identity') === true;

  return {
    candidateCount: rankedResults.length,
    identityEvidenceSatisfied: !policy.requireIdentitySeal || hasIdentityEvidence,
    constraintEvidenceSatisfied:
      !policy.requireConstraintEvidence || resolution.satisfied,
    anchorEvidenceSatisfied:
      !policy.requireAnchorEvidence ||
      anchorSignalTypes.length > 0,
    matchedConstraintAttributes: resolution.matched,
    unmetConstraintAttributes: resolution.unmet,
    anchorSignalTypes,
  };
}

export function buildMissingProvenanceObligations(
  policy: ProvenancePolicy,
  stage: ProvenanceCoverageStage,
): readonly MissingProvenanceObligation[] {
  return [
    ...(policy.requireIdentitySeal && !stage.identityEvidenceSatisfied
      ? ['identity_evidence' as const]
      : []),
    ...(policy.requireConstraintEvidence && !stage.constraintEvidenceSatisfied
      ? ['constraint_evidence' as const]
      : []),
    ...(policy.requireAnchorEvidence && !stage.anchorEvidenceSatisfied
      ? ['anchor_evidence' as const]
      : []),
  ];
}

export function buildExecutionProvenanceClosureFromStages(
  policy: ProvenancePolicy,
  preRank: ProvenanceCoverageStage,
  postRank: ProvenanceCoverageStage,
): ExecutionProvenanceClosure {
  const missing = buildMissingProvenanceObligations(policy, postRank);
  return {
    policy,
    preRank,
    postRank,
    missing,
    satisfied: missing.length === 0,
  };
}
