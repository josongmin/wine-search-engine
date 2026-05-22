import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult, ComponentScores } from '../../domain/ranking/model/ranked-result.js';
import type { ScoreDecomposition } from '../../domain/ranking/model/score-decomposition.js';
import { WineAttributeEncoders } from '../../domain/ranking/service/wine-attribute-encoder.js';
import { projectHybridCandidateToRankedResultAttributes } from '../../domain/ranking/service/ranked-result-attribute-projection.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { ResolverCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import type { EntityLaneCandidateArtifact, IdentityExactnessTier, IdentityLaneProvenance } from '../../domain/retrieval/model/dual-lane-artifact.js';
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

const LEXICAL_CONTRIBUTION_EXACT = 1;
const LEXICAL_CONTRIBUTION_ALIAS_EXACT = 0.9;
const LEXICAL_CONTRIBUTION_ALIAS_FUZZY = 0.7;
const LEXICAL_CONTRIBUTION_UNKNOWN = 0;

const log = bootstrapLogger.child({ component: ENTITY_ROUTE_RANKED_RESULTS_COMPONENT });

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function deriveLexicalContributionFromAliasType(
  aliasMatchType: IdentityExactnessTier,
): number {
  switch (aliasMatchType) {
    case MATCH_TYPE_EXACT: return LEXICAL_CONTRIBUTION_EXACT;
    case MATCH_TYPE_ALIAS_EXACT: return LEXICAL_CONTRIBUTION_ALIAS_EXACT;
    case MATCH_TYPE_ALIAS_FUZZY: return LEXICAL_CONTRIBUTION_ALIAS_FUZZY;
    default: return LEXICAL_CONTRIBUTION_UNKNOWN;
  }
}

function buildEntityRouteScoreDecomposition(
  calibratedScore: number,
  aliasMatchType: IdentityExactnessTier,
): ScoreDecomposition {
  const lexicalContribution = deriveLexicalContributionFromAliasType(aliasMatchType);

  return {
    lexicalContribution,
    semanticContribution: calibratedScore,
    anchorContribution: 0,
    attributeSatisfaction: 0,
    popularityContribution: 0,
    preferenceAlignmentContribution: 0,
    heuristicScoreRaw: calibratedScore,
    heuristicScoreNormalized: calibratedScore,
    finalScore: calibratedScore,
  };
}

function buildIdentityProvenanceSignalSnapshot(
  rawCandidate: ResolverCandidate | undefined,
): IdentityLaneProvenance['sourceSignals'] {
  return {
    canonicalExactMatch: rawCandidate?.sourceSignals.canonicalExactMatch ?? 0,
    canonicalNormalizedMatch: rawCandidate?.sourceSignals.canonicalNormalizedMatch ?? 0,
    aliasExactMatch: rawCandidate?.sourceSignals.aliasExactMatch ?? 0,
    aliasFuzzyMatch: rawCandidate?.sourceSignals.aliasFuzzyMatch ?? 0,
    editDistanceScore: rawCandidate?.sourceSignals.editDistanceScore ?? 0,
  };
}

function resolveIdentityExactnessTier(
  rawCandidate: ResolverCandidate | undefined,
): IdentityExactnessTier {
  const aliasSignals = rawCandidate?.sourceSignals;
  if (aliasSignals?.canonicalExactMatch === 1) {
    return MATCH_TYPE_EXACT;
  }
  if ((aliasSignals?.aliasExactMatch ?? 0) > 0) {
    return MATCH_TYPE_ALIAS_EXACT;
  }
  if ((aliasSignals?.aliasFuzzyMatch ?? 0) > 0 || (aliasSignals?.editDistanceScore ?? 0) > 0) {
    return MATCH_TYPE_ALIAS_FUZZY;
  }
  return 'none';
}

function findStrongestAliasMatch(
  rawCandidate: ResolverCandidate | undefined,
): IdentityLaneProvenance['strongestAliasMatch'] {
  const strongestAliasMatch = rawCandidate?.aliasMatches.reduce<typeof rawCandidate.aliasMatches[number] | undefined>(
    (best, candidate) =>
      best === undefined || candidate.matchScore > best.matchScore ? candidate : best,
    undefined,
  );

  return strongestAliasMatch !== undefined
    ? {
        aliasValue: strongestAliasMatch.aliasValue,
        aliasType: strongestAliasMatch.aliasType,
        matchScore: strongestAliasMatch.matchScore,
      }
    : undefined;
}

function buildIdentityLaneProvenance(
  resolvedCandidate: EntityResolveResult['candidates'][number],
  rawCandidate: ResolverCandidate | undefined,
): IdentityLaneProvenance {
  const strongestAliasMatch = findStrongestAliasMatch(rawCandidate);

  return {
    source: 'entity_resolver',
    entityId: resolvedCandidate.entityId,
    exactnessTier: resolveIdentityExactnessTier(rawCandidate),
    calibratedScore: resolvedCandidate.calibratedScore,
    resolverRank: resolvedCandidate.rank,
    canonicalLabel: resolvedCandidate.canonicalLabel,
    evidenceRefs: resolvedCandidate.evidenceRefs,
    sourceSignals: buildIdentityProvenanceSignalSnapshot(rawCandidate),
    ...(strongestAliasMatch !== undefined ? { strongestAliasMatch } : {}),
    ...(rawCandidate?.sources !== undefined && rawCandidate.sources.length > 0
      ? { candidateSources: rawCandidate.sources }
      : rawCandidate?.source !== undefined
        ? { candidateSources: [rawCandidate.source] }
        : {}),
    ...(rawCandidate?.sourceRecordRefs !== undefined && rawCandidate.sourceRecordRefs.length > 0
      ? { sourceRecordRefs: rawCandidate.sourceRecordRefs }
      : {}),
  };
}

function liftResolvedEntityCandidateToHybridCandidate(
  resolvedCandidate: EntityResolveResult['candidates'][number],
  rawCandidate: ResolverCandidate | undefined,
  identityProvenance: IdentityLaneProvenance,
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
      entityPosteriorScore: identityProvenance.calibratedScore,
      identityExactnessTier: identityProvenance.exactnessTier,
      lanePresence: 'entity_only',
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
  identityProvenance: IdentityLaneProvenance,
  plan: QueryPlanV1,
  matchedSet: ReadonlySet<string>,
  unmetHardConstraints: readonly string[],
): readonly EvidenceItem[] {
  return [
    {
      type: 'identity',
      source: IDENTITY_EVIDENCE_SOURCE,
      contribution: `+${identityProvenance.calibratedScore.toFixed(2)}`,
      strength: 'high',
      provenance: `Entity resolved via alias match (${String(identityProvenance.entityId)})`,
      ...(identityProvenance.exactnessTier !== 'none' || identityProvenance.strongestAliasMatch !== undefined
        ? {
            metadata: {
              ...(identityProvenance.exactnessTier !== 'none'
                ? { matchType: identityProvenance.exactnessTier }
                : {}),
              ...(identityProvenance.strongestAliasMatch !== undefined
                ? {
                    matchedAlias: identityProvenance.strongestAliasMatch.aliasValue,
                    aliasType: identityProvenance.strongestAliasMatch.aliasType,
                    aliasScore: identityProvenance.strongestAliasMatch.matchScore,
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
    resolvedCandidate.rank !== 1
    || plan.constraints.hard.length === 0
    || unmetHardConstraints.length === 0
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

export function liftEntityResolveResultToLaneArtifacts(
  plan: QueryPlanV1,
  resolveResult: EntityResolveResult,
  resolverCandidates: readonly ResolverCandidate[],
): readonly EntityLaneCandidateArtifact[] {
  if (resolveResult.candidates.length === 0) {
    return [];
  }

  const resolverCandidateById = new Map(
    resolverCandidates.map((candidate) => [String(candidate.entityId), candidate] as const),
  );
  const identityProvenanceById = new Map(
    resolveResult.candidates.map((resolvedCandidate) => {
      const rawCandidate = resolverCandidateById.get(String(resolvedCandidate.entityId));
      return [
        String(resolvedCandidate.entityId),
        buildIdentityLaneProvenance(resolvedCandidate, rawCandidate),
      ] as const;
    }),
  );
  const syntheticCandidates = resolveResult.candidates.map((resolvedCandidate) => {
    const rawCandidate = resolverCandidateById.get(String(resolvedCandidate.entityId));
    const identityProvenance = identityProvenanceById.get(String(resolvedCandidate.entityId));
    if (identityProvenance === undefined) {
      throw invariantError('identity provenance missing for resolved entity');
    }
    return liftResolvedEntityCandidateToHybridCandidate(
      resolvedCandidate,
      rawCandidate,
      identityProvenance,
    );
  });
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

    const rawCandidate = resolverCandidateById.get(String(resolvedCandidate.entityId));
    const identityProvenance = identityProvenanceById.get(String(resolvedCandidate.entityId));
    if (identityProvenance === undefined) {
      throw invariantError('identity provenance missing for annotated entity');
    }
    const matchedSet = new Set(annotatedCandidate.matchedConstraints);
    const unmetHardConstraints = annotatedCandidate.unmetHardConstraints ?? [];

    return {
      entityId: resolvedCandidate.entityId,
      candidate: {
        ...annotatedCandidate,
        entityPosteriorScore: identityProvenance.calibratedScore,
        identityExactnessTier: identityProvenance.exactnessTier,
        lanePresence: 'entity_only',
      },
      resolvedCandidate,
      ...(rawCandidate !== undefined ? { rawCandidate } : {}),
      identityProvenance,
      evidenceItems: buildEntityRouteEvidenceItems(
        identityProvenance,
        plan,
        matchedSet,
        unmetHardConstraints,
      ),
    };
  });
}

export function buildEntityRouteRankedResults(
  plan: QueryPlanV1,
  resolveResult: EntityResolveResult,
  resolverCandidates: readonly ResolverCandidate[],
): readonly RankedResult[] {
  const entityLaneArtifacts = liftEntityResolveResultToLaneArtifacts(
    plan,
    resolveResult,
    resolverCandidates,
  );

  if (entityLaneArtifacts.length === 0) {
    return [];
  }

  const inferredConstraintAttributes = unique(
    plan.constraints.inferred.map((constraint) => constraint.attribute),
  );

  return entityLaneArtifacts.map((artifact) => {
    const unmetHardConstraints = artifact.candidate.unmetHardConstraints ?? [];
    const hardConstraintPass =
      unmetHardConstraints.length === 0
      && plan.constraints.hard.every((constraint) =>
        artifact.candidate.matchedConstraints.includes(constraint.attribute),
      );

    logTopConstraintProjectionGap(
      plan,
      artifact.resolvedCandidate,
      artifact.rawCandidate,
      artifact.candidate.matchedConstraints,
      unmetHardConstraints,
    );

    const scoreDecomposition = buildEntityRouteScoreDecomposition(
      artifact.resolvedCandidate.calibratedScore,
      artifact.identityProvenance.exactnessTier,
    );

    return {
      entityId: artifact.resolvedCandidate.entityId,
      canonicalLabel: artifact.resolvedCandidate.canonicalLabel,
      finalScore: artifact.resolvedCandidate.calibratedScore,
      rank: artifact.resolvedCandidate.rank,
      componentScores: buildComponentScores(
        artifact.resolvedCandidate.calibratedScore,
        hardConstraintPass,
      ),
      evidenceItems: artifact.evidenceItems,
      matchedConstraints: artifact.candidate.matchedConstraints,
      unmetConstraints: [...unmetHardConstraints],
      inferredConstraints: inferredConstraintAttributes,
      scoreDecomposition,
      ...projectHybridCandidateToRankedResultAttributes(
        artifact.candidate,
        WineAttributeEncoders,
      ),
    };
  });
}
