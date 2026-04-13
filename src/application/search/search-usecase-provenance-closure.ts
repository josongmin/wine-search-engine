import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type {
  ExecutionProvenanceClosure,
  MissingProvenanceObligation,
  ProvenanceCoverageStage,
  ProvenancePolicy,
} from '../../domain/query/model/engine-execution-contract.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function requiredConstraintAttributes(plan: QueryPlanV1): readonly string[] {
  return unique(plan.constraints.hard.map((constraint) => constraint.attribute));
}

export function buildHybridCandidateCoverageStage(
  plan: QueryPlanV1,
  candidates: readonly HybridCandidate[],
  policy: ProvenancePolicy,
): ProvenanceCoverageStage {
  const required = requiredConstraintAttributes(plan);
  const matchedConstraintAttributes = unique(
    candidates.flatMap((candidate) =>
      (candidate.matchedConstraints ?? []).filter((attribute) =>
        required.includes(attribute),
      )),
  );
  const unmetConstraintAttributes = required.filter(
    (attribute) => !matchedConstraintAttributes.includes(attribute),
  );
  const anchorSignalTypes = unique(
    candidates.flatMap((candidate) =>
      candidate.anchorRank !== undefined ||
      candidate.retrievalProvenance?.channels.includes('anchor_similarity') === true
        ? ['anchor_similarity']
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
      !policy.requireConstraintEvidence ||
      (required.length > 0 && unmetConstraintAttributes.length === 0),
    anchorEvidenceSatisfied:
      !policy.requireAnchorEvidence ||
      anchorSignalTypes.length > 0,
    matchedConstraintAttributes,
    unmetConstraintAttributes,
    anchorSignalTypes,
  };
}

export function buildRankedResultCoverageStage(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  policy: ProvenancePolicy,
): ProvenanceCoverageStage {
  const topResult = rankedResults[0];
  const required = requiredConstraintAttributes(plan);
  const matchedConstraintAttributes = topResult === undefined
    ? []
    : unique(
        topResult.matchedConstraints.filter((attribute) => required.includes(attribute)),
      );
  const unmetConstraintAttributes = topResult === undefined
    ? required
    : unique(
        topResult.unmetConstraints.filter((attribute) => required.includes(attribute)),
      );
  const anchorSignalTypes = topResult === undefined
    ? []
    : unique(
        topResult.evidenceItems.flatMap((item) =>
          item.type === 'anchor_similarity' || (topResult.componentScores.anchorSimilarity ?? 0) > 0
            ? ['anchor_similarity']
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
      !policy.requireConstraintEvidence ||
      (required.length > 0 && unmetConstraintAttributes.length === 0),
    anchorEvidenceSatisfied:
      !policy.requireAnchorEvidence ||
      anchorSignalTypes.length > 0,
    matchedConstraintAttributes,
    unmetConstraintAttributes,
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
