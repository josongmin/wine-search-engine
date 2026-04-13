import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult, ComponentScores } from '../../domain/ranking/model/ranked-result.js';
import { WineAttributeEncoders } from '../../domain/ranking/service/wine-attribute-encoder.js';
import { projectHybridCandidateToRankedResultAttributes } from '../../domain/ranking/service/ranked-result-attribute-projection.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { ResolverCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import type { EvidenceItem } from '../../domain/shared/types/index.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import { annotateCandidateConstraintEvidenceBatch } from '../../domain/retrieval/service/candidate-constraint-evidence.js';
import { applyAttributeHintsToSyntheticHybridCandidate } from './search-usecase-entity-attribute-projection.js';

const SYNTHETIC_ENTITY_RETRIEVAL_PROFILE = 'entity_route_synthetic';
const IDENTITY_EVIDENCE_SOURCE = 'entity_resolver';
const CONSTRAINT_EVIDENCE_SOURCE = 'entity_route_constraint_projection';
const POSITIVE_CONSTRAINT_CONTRIBUTION = '+pass';
const NEGATIVE_CONSTRAINT_CONTRIBUTION = '-fail';
const ENTITY_ROUTE_RANKED_RESULTS_COMPONENT = 'entity_route_ranked_results';
const ENTITY_ROUTE_INVARIANT_ERROR_PREFIX = 'Entity route ranked results invariant violated';
const MATCH_TYPE_EXACT = 'exact';
const MATCH_TYPE_ALIAS_EXACT = 'alias_exact';
const MATCH_TYPE_ALIAS_FUZZY = 'alias_fuzzy';

const log = bootstrapLogger.child({ component: ENTITY_ROUTE_RANKED_RESULTS_COMPONENT });

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function buildSyntheticHybridCandidate(
  resolvedCandidate: EntityResolveResult['candidates'][number],
  rawCandidate: ResolverCandidate | undefined,
): HybridCandidate {
  return applyAttributeHintsToSyntheticHybridCandidate(
    {
      entityId: resolvedCandidate.entityId,
      canonicalLabel: resolvedCandidate.canonicalLabel,
      matchedConstraints: [],
      retrievalTrace: {
        retrievalProfile: SYNTHETIC_ENTITY_RETRIEVAL_PROFILE,
        lexicalQueriesUsed: [],
        semanticQueriesUsed: [],
        filtersApplied: [],
        candidateSources: [IDENTITY_EVIDENCE_SOURCE],
      },
      ...(rawCandidate?.sourceRecordRefs !== undefined && rawCandidate.sourceRecordRefs.length > 0
        ? { sourceRecordRefs: rawCandidate.sourceRecordRefs }
        : {}),
    },
    rawCandidate?.attributeHints,
  );
}

function buildConstraintEvidenceItems(
  plan: QueryPlanV1,
  matchedSet: ReadonlySet<string>,
  unmetHardConstraints: readonly string[],
): readonly EvidenceItem[] {
  const hardConstraintAttributes = unique(
    plan.constraints.hard.map((constraint) => constraint.attribute),
  );
  const evidenceItems: EvidenceItem[] = [];

  for (const attribute of hardConstraintAttributes) {
    if (matchedSet.has(attribute)) {
      evidenceItems.push({
        type: 'constraint_pass',
        source: CONSTRAINT_EVIDENCE_SOURCE,
        contribution: POSITIVE_CONSTRAINT_CONTRIBUTION,
        strength: 'high',
        provenance: `Matched hard constraint ${attribute}`,
      });
      continue;
    }

    if (unmetHardConstraints.includes(attribute)) {
      evidenceItems.push({
        type: 'constraint_fail',
        source: CONSTRAINT_EVIDENCE_SOURCE,
        contribution: NEGATIVE_CONSTRAINT_CONTRIBUTION,
        strength: 'high',
        provenance: `Failed hard constraint ${attribute}`,
      });
    }
  }

  return evidenceItems;
}

function buildEntityRouteEvidenceItems(
  resolvedCandidate: EntityResolveResult['candidates'][number],
  plan: QueryPlanV1,
  rawCandidate: ResolverCandidate | undefined,
  matchedSet: ReadonlySet<string>,
  unmetHardConstraints: readonly string[],
): readonly EvidenceItem[] {
  const aliasSignals = rawCandidate?.sourceSignals;
  const aliasMatchType =
    aliasSignals?.canonicalExactMatch === 1
      ? MATCH_TYPE_EXACT
      : (aliasSignals?.aliasExactMatch ?? 0) > 0
          ? MATCH_TYPE_ALIAS_EXACT
          : (aliasSignals?.aliasFuzzyMatch ?? 0) > 0 || (aliasSignals?.editDistanceScore ?? 0) > 0
              ? MATCH_TYPE_ALIAS_FUZZY
              : undefined;
  const strongestAliasMatch = rawCandidate?.aliasMatches.reduce<typeof rawCandidate.aliasMatches[number] | undefined>(
    (best, candidate) =>
      best === undefined || candidate.matchScore > best.matchScore ? candidate : best,
    undefined,
  );

  return [
    {
      type: 'identity',
      source: IDENTITY_EVIDENCE_SOURCE,
      contribution: `+${resolvedCandidate.calibratedScore.toFixed(2)}`,
      strength: 'high',
      provenance: `Entity resolved via alias match (${String(resolvedCandidate.entityId)})`,
      ...(aliasMatchType !== undefined || strongestAliasMatch !== undefined
        ? {
            metadata: {
              ...(aliasMatchType !== undefined ? { matchType: aliasMatchType } : {}),
              ...(strongestAliasMatch !== undefined
                ? {
                    matchedAlias: strongestAliasMatch.aliasValue,
                    aliasType: strongestAliasMatch.aliasType,
                    aliasScore: strongestAliasMatch.matchScore,
                  }
                : {}),
            },
          }
        : {}),
    },
    ...buildConstraintEvidenceItems(plan, matchedSet, unmetHardConstraints),
  ];
}

function buildComponentScores(
  semanticScore: number,
  hardConstraintPass: boolean,
): ComponentScores {
  return {
    entityIntegrity: 1,
    semantic: semanticScore,
    hardConstraintPass,
    softConstraint: 0,
    attributeAlignment: 0,
    preferenceAlignment: 0,
    popularity: 0,
    availability: 0,
    uncertaintyPenalty: 0,
  };
}

function invariantError(message: string): Error {
  return new Error(`${ENTITY_ROUTE_INVARIANT_ERROR_PREFIX}: ${message}`);
}

function collectDuplicateEntityIds(
  entityIds: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entityId of entityIds) {
    if (seen.has(entityId)) {
      duplicates.add(entityId);
      continue;
    }
    seen.add(entityId);
  }
  return [...duplicates];
}

function assertUniqueEntityIds(
  entityIds: readonly string[],
  source: 'resolver_result' | 'annotated_candidates',
): void {
  const duplicates = collectDuplicateEntityIds(entityIds);
  if (duplicates.length === 0) {
    return;
  }
  log.error(
    { source, duplicate_entity_ids: duplicates },
    '[EntityRouteRankedResults] duplicate entity IDs detected',
  );
  throw invariantError(`${source} contains duplicate entity IDs`);
}

function logTopConstraintProjectionGap(
  plan: QueryPlanV1,
  resolvedCandidate: EntityResolveResult['candidates'][number],
  rawCandidate: ResolverCandidate | undefined,
  matchedConstraints: readonly string[],
  unmetHardConstraints: readonly string[],
): void {
  if (
    resolvedCandidate.rank !== 1 ||
    plan.constraints.hard.length === 0 ||
    unmetHardConstraints.length === 0
  ) {
    return;
  }

  log.warn(
    {
      entity_id: resolvedCandidate.entityId,
      canonical_label: resolvedCandidate.canonicalLabel,
      required_hard_constraint_attributes: unique(
        plan.constraints.hard.map((constraint) => constraint.attribute),
      ),
      matched_constraints: matchedConstraints,
      unmet_hard_constraints: unmetHardConstraints,
      projected_hint_keys: Object.keys(rawCandidate?.attributeHints ?? {}),
      candidate_source: rawCandidate?.source,
      candidate_sources: rawCandidate?.sources,
    },
    '[EntityRouteRankedResults] top entity still violates hard constraints after synthetic projection',
  );
}

export function buildEntityRouteRankedResults(
  plan: QueryPlanV1,
  resolveResult: EntityResolveResult,
  resolverCandidates: readonly ResolverCandidate[],
): readonly RankedResult[] {
  if (resolveResult.candidates.length === 0) {
    return [];
  }

  const resolverCandidateById = new Map(
    resolverCandidates.map((candidate) => [String(candidate.entityId), candidate] as const),
  );

  const syntheticCandidates = resolveResult.candidates.map((resolvedCandidate) =>
    buildSyntheticHybridCandidate(
      resolvedCandidate,
      resolverCandidateById.get(String(resolvedCandidate.entityId)),
    ));
  const annotatedCandidates = annotateCandidateConstraintEvidenceBatch(
    syntheticCandidates,
    plan.constraints,
  );
  const resolveEntityIds = resolveResult.candidates.map((candidate) => String(candidate.entityId));
  const annotatedEntityIds = annotatedCandidates.map((candidate) => String(candidate.entityId));
  assertUniqueEntityIds(resolveEntityIds, 'resolver_result');
  assertUniqueEntityIds(annotatedEntityIds, 'annotated_candidates');
  const annotatedCandidateById = new Map(
    annotatedCandidates.map((candidate) => [String(candidate.entityId), candidate] as const),
  );
  const inferredConstraintAttributes = unique(
    plan.constraints.inferred.map((constraint) => constraint.attribute),
  );

  return resolveResult.candidates.map((resolvedCandidate) => {
    const annotatedCandidate = annotatedCandidateById.get(String(resolvedCandidate.entityId));
    if (annotatedCandidate === undefined) {
      log.error(
        {
          entity_id: resolvedCandidate.entityId,
          canonical_label: resolvedCandidate.canonicalLabel,
        },
        '[EntityRouteRankedResults] missing annotated candidate for resolved entity',
      );
      throw invariantError('resolved entity is missing from annotated synthetic candidates');
    }
    const matchedSet = new Set(annotatedCandidate.matchedConstraints);
    const unmetHardConstraints = annotatedCandidate.unmetHardConstraints ?? [];
    const hardConstraintPass =
      unmetHardConstraints.length === 0 &&
      plan.constraints.hard.every((constraint) => matchedSet.has(constraint.attribute));
    const rawCandidate = resolverCandidateById.get(String(resolvedCandidate.entityId));

    logTopConstraintProjectionGap(
      plan,
      resolvedCandidate,
      rawCandidate,
      annotatedCandidate.matchedConstraints,
      unmetHardConstraints,
    );

    return {
      entityId: resolvedCandidate.entityId,
      canonicalLabel: resolvedCandidate.canonicalLabel,
      finalScore: resolvedCandidate.calibratedScore,
      rank: resolvedCandidate.rank,
      componentScores: buildComponentScores(resolvedCandidate.calibratedScore, hardConstraintPass),
      evidenceItems: buildEntityRouteEvidenceItems(
        resolvedCandidate,
        plan,
        rawCandidate,
        matchedSet,
        unmetHardConstraints,
      ),
      matchedConstraints: annotatedCandidate.matchedConstraints,
      unmetConstraints: [...unmetHardConstraints],
      inferredConstraints: inferredConstraintAttributes,
      ...projectHybridCandidateToRankedResultAttributes(
        annotatedCandidate,
        WineAttributeEncoders,
      ),
    };
  });
}
