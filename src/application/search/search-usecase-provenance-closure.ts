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
import { computeGraphCoverage } from '../../domain/query/service/compute-graph-coverage.js';

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function requiredConstraintAttributes(plan: QueryPlanV1): readonly string[] {
  return unique(plan.constraints.hard.map((constraint) => constraint.attribute));
}

/**
 * ADR-011 Phase 1b.1: when a `ConstraintGraph` is present, coverage is
 * computed under AND / OR / XOR group semantics via
 * {@link computeGraphCoverage}. The flat fallback (pre-Phase-1b.1
 * behaviour) is taken when the graph is absent — byte-identical to the
 * legacy code path. The `ProvenanceCoverageStage` response shape does not
 * change at this phase.
 */
interface CoverageComputationInput {
  readonly plan: QueryPlanV1;
  readonly graph?: ConstraintGraph | undefined;
  readonly satisfiedAttributes: readonly string[];
}

interface CoverageComputationOutput {
  readonly matchedConstraintAttributes: readonly string[];
  readonly unmetConstraintAttributes: readonly string[];
}

function computeMatchedAndUnmet(
  input: CoverageComputationInput,
): CoverageComputationOutput {
  const { plan, graph, satisfiedAttributes } = input;
  const satisfiedSet = new Set(satisfiedAttributes);
  if (graph !== undefined) {
    const coverage = computeGraphCoverage(graph, satisfiedSet);
    return {
      matchedConstraintAttributes: coverage.matchedAttributes,
      unmetConstraintAttributes: coverage.unmetAttributes,
    };
  }
  const required = requiredConstraintAttributes(plan);
  const matchedConstraintAttributes = unique(
    satisfiedAttributes.filter((attribute) => required.includes(attribute)),
  );
  const unmetConstraintAttributes = required.filter(
    (attribute) => !matchedConstraintAttributes.includes(attribute),
  );
  return { matchedConstraintAttributes, unmetConstraintAttributes };
}

export function buildHybridCandidateCoverageStage(
  plan: QueryPlanV1,
  candidates: readonly HybridCandidate[],
  policy: ProvenancePolicy,
  graph?: ConstraintGraph,
): ProvenanceCoverageStage {
  const satisfied = candidates.flatMap((candidate) => candidate.matchedConstraints);
  const { matchedConstraintAttributes, unmetConstraintAttributes } =
    computeMatchedAndUnmet({ plan, graph, satisfiedAttributes: satisfied });
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

  const required = graph !== undefined
    ? matchedConstraintAttributes.length + unmetConstraintAttributes.length
    : requiredConstraintAttributes(plan).length;

  return {
    candidateCount: candidates.length,
    identityEvidenceSatisfied: !policy.requireIdentitySeal || hasIdentityEvidence,
    constraintEvidenceSatisfied:
      !policy.requireConstraintEvidence ||
      (required > 0 && unmetConstraintAttributes.length === 0),
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
  graph?: ConstraintGraph,
): ProvenanceCoverageStage {
  const topResult = rankedResults[0];
  const satisfied = topResult === undefined ? [] : topResult.matchedConstraints;
  const { matchedConstraintAttributes, unmetConstraintAttributes } =
    topResult === undefined && graph === undefined
      ? {
          matchedConstraintAttributes: [] as readonly string[],
          unmetConstraintAttributes: requiredConstraintAttributes(plan),
        }
      : computeMatchedAndUnmet({ plan, graph, satisfiedAttributes: satisfied });

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

  const required = graph !== undefined
    ? matchedConstraintAttributes.length + unmetConstraintAttributes.length
    : requiredConstraintAttributes(plan).length;

  return {
    candidateCount: rankedResults.length,
    identityEvidenceSatisfied: !policy.requireIdentitySeal || hasIdentityEvidence,
    constraintEvidenceSatisfied:
      !policy.requireConstraintEvidence ||
      (required > 0 && unmetConstraintAttributes.length === 0),
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
