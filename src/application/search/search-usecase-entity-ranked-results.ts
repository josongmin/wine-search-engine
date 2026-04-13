import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult, ComponentScores } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { ResolverCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import type { EvidenceItem } from '../../domain/shared/types/index.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import { annotateCandidateConstraintEvidenceBatch } from '../../domain/retrieval/service/candidate-constraint-evidence.js';

const SYNTHETIC_ENTITY_RETRIEVAL_PROFILE = 'entity_route_synthetic';
const IDENTITY_EVIDENCE_SOURCE = 'entity_resolver';
const CONSTRAINT_EVIDENCE_SOURCE = 'entity_route_constraint_projection';
const POSITIVE_CONSTRAINT_CONTRIBUTION = '+pass';
const NEGATIVE_CONSTRAINT_CONTRIBUTION = '-fail';

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function getStringHint(
  hints: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = hints?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getNumberHint(
  hints: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = hints?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getStringArrayHint(
  hints: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly string[] | undefined {
  const value = hints?.[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function buildSyntheticHybridCandidate(
  resolvedCandidate: EntityResolveResult['candidates'][number],
  rawCandidate: ResolverCandidate | undefined,
): HybridCandidate {
  const hints = rawCandidate?.attributeHints;
  return {
    entityId: resolvedCandidate.entityId,
    canonicalLabel: resolvedCandidate.canonicalLabel,
    ...(getStringHint(hints, 'producer') !== undefined
      ? { producer: getStringHint(hints, 'producer') }
      : {}),
    ...(getStringHint(hints, 'region') !== undefined
      ? { region: getStringHint(hints, 'region') }
      : {}),
    ...(getStringHint(hints, 'appellation') !== undefined
      ? { appellation: getStringHint(hints, 'appellation') }
      : {}),
    ...(getStringHint(hints, 'country') !== undefined
      ? { country: getStringHint(hints, 'country') }
      : {}),
    ...(getStringHint(hints, 'grape_primary') !== undefined
      ? { grapePrimary: getStringHint(hints, 'grape_primary') }
      : {}),
    ...(getStringArrayHint(hints, 'grapes') !== undefined
      ? { grapes: getStringArrayHint(hints, 'grapes') }
      : {}),
    ...(getStringHint(hints, 'style') !== undefined
      ? { style: getStringHint(hints, 'style') }
      : {}),
    ...(getStringHint(hints, 'price_band') !== undefined
      ? { priceBand: getStringHint(hints, 'price_band') }
      : {}),
    ...(getStringArrayHint(hints, 'pairing') !== undefined
      ? { pairing: getStringArrayHint(hints, 'pairing') }
      : {}),
    ...(getStringArrayHint(hints, 'occasion') !== undefined
      ? { occasion: getStringArrayHint(hints, 'occasion') }
      : {}),
    ...(getNumberHint(hints, 'vintage_year') !== undefined
      ? { vintageYear: getNumberHint(hints, 'vintage_year') }
      : {}),
    ...(getNumberHint(hints, 'body') !== undefined
      ? { body: getNumberHint(hints, 'body') }
      : {}),
    ...(getNumberHint(hints, 'tannin') !== undefined
      ? { tannin: getNumberHint(hints, 'tannin') }
      : {}),
    ...(getNumberHint(hints, 'acidity') !== undefined
      ? { acidity: getNumberHint(hints, 'acidity') }
      : {}),
    ...(getNumberHint(hints, 'sweetness') !== undefined
      ? { sweetness: getNumberHint(hints, 'sweetness') }
      : {}),
    ...(getStringHint(hints, 'wine_type') !== undefined
      ? { wineType: getStringHint(hints, 'wine_type') }
      : {}),
    ...(getStringHint(hints, 'classification') !== undefined
      ? { classification: getStringHint(hints, 'classification') }
      : {}),
    ...(getNumberHint(hints, 'alcohol_pct') !== undefined
      ? { alcoholPct: getNumberHint(hints, 'alcohol_pct') }
      : {}),
    ...(getNumberHint(hints, 'price_usd') !== undefined
      ? { priceUsd: getNumberHint(hints, 'price_usd') }
      : {}),
    ...(getNumberHint(hints, 'producer_prestige') !== undefined
      ? { producerPrestige: getNumberHint(hints, 'producer_prestige') }
      : {}),
    ...(getNumberHint(hints, 'critic_score_normalized') !== undefined
      ? { criticScoreNormalized: getNumberHint(hints, 'critic_score_normalized') }
      : {}),
    ...(getStringArrayHint(hints, 'certifications') !== undefined
      ? { certifications: getStringArrayHint(hints, 'certifications') }
      : {}),
    ...(getStringHint(hints, 'soil_type') !== undefined
      ? { soilType: getStringHint(hints, 'soil_type') }
      : {}),
    ...(getStringHint(hints, 'producer_type') !== undefined
      ? { producerType: getStringHint(hints, 'producer_type') }
      : {}),
    ...(getStringHint(hints, 'grape_family') !== undefined
      ? { grapeFamily: getStringHint(hints, 'grape_family') }
      : {}),
    ...(getStringArrayHint(hints, 'flavor_profiles') !== undefined
      ? { flavorProfiles: getStringArrayHint(hints, 'flavor_profiles') }
      : {}),
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: SYNTHETIC_ENTITY_RETRIEVAL_PROFILE,
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [IDENTITY_EVIDENCE_SOURCE],
    },
  };
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
  matchedSet: ReadonlySet<string>,
  unmetHardConstraints: readonly string[],
): readonly EvidenceItem[] {
  return [
    {
      type: 'identity',
      source: IDENTITY_EVIDENCE_SOURCE,
      contribution: `+${resolvedCandidate.calibratedScore.toFixed(2)}`,
      strength: 'high',
      provenance: `Entity resolved via alias match (${String(resolvedCandidate.entityId)})`,
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
  const inferredConstraintAttributes = unique(
    plan.constraints.inferred.map((constraint) => constraint.attribute),
  );

  return annotatedCandidates.map((annotatedCandidate, index) => {
    const resolvedCandidate = resolveResult.candidates[index]!;
    const matchedSet = new Set(annotatedCandidate.matchedConstraints);
    const unmetHardConstraints = annotatedCandidate.unmetHardConstraints ?? [];
    const hardConstraintPass =
      unmetHardConstraints.length === 0 &&
      plan.constraints.hard.every((constraint) => matchedSet.has(constraint.attribute));

    return {
      entityId: resolvedCandidate.entityId,
      canonicalLabel: resolvedCandidate.canonicalLabel,
      finalScore: resolvedCandidate.calibratedScore,
      rank: index + 1,
      componentScores: buildComponentScores(resolvedCandidate.calibratedScore, hardConstraintPass),
      evidenceItems: buildEntityRouteEvidenceItems(
        resolvedCandidate,
        plan,
        matchedSet,
        unmetHardConstraints,
      ),
      matchedConstraints: annotatedCandidate.matchedConstraints,
      unmetConstraints: [...unmetHardConstraints],
      inferredConstraints: inferredConstraintAttributes,
      ...(annotatedCandidate.producer !== undefined
        ? { producer: annotatedCandidate.producer }
        : {}),
      ...(annotatedCandidate.region !== undefined
        ? { region: annotatedCandidate.region }
        : {}),
      ...(annotatedCandidate.appellation !== undefined
        ? { appellation: annotatedCandidate.appellation }
        : {}),
      ...(annotatedCandidate.grapePrimary !== undefined
        ? { grapePrimary: annotatedCandidate.grapePrimary }
        : {}),
      ...(annotatedCandidate.vintageYear !== undefined
        ? { vintageYear: annotatedCandidate.vintageYear }
        : {}),
      ...(annotatedCandidate.body !== undefined ? { body: annotatedCandidate.body } : {}),
      ...(annotatedCandidate.tannin !== undefined ? { tannin: annotatedCandidate.tannin } : {}),
      ...(annotatedCandidate.acidity !== undefined ? { acidity: annotatedCandidate.acidity } : {}),
      ...(annotatedCandidate.sweetness !== undefined
        ? { sweetness: annotatedCandidate.sweetness }
        : {}),
      ...(annotatedCandidate.criticScoreNormalized !== undefined
        ? { criticScoreNormalized: annotatedCandidate.criticScoreNormalized }
        : {}),
      ...(annotatedCandidate.producerPrestige !== undefined
        ? { producerPrestige: annotatedCandidate.producerPrestige }
        : {}),
      ...(annotatedCandidate.country !== undefined ? { country: annotatedCandidate.country } : {}),
      ...(annotatedCandidate.drinkingWindowStart !== undefined
        ? { drinkingWindowStart: annotatedCandidate.drinkingWindowStart }
        : {}),
      ...(annotatedCandidate.drinkingWindowEnd !== undefined
        ? { drinkingWindowEnd: annotatedCandidate.drinkingWindowEnd }
        : {}),
      ...(annotatedCandidate.drinkingWindowModelVersion !== undefined
        ? { drinkingWindowModelVersion: annotatedCandidate.drinkingWindowModelVersion }
        : {}),
      ...(annotatedCandidate.priceUsd !== undefined ? { priceUsd: annotatedCandidate.priceUsd } : {}),
      ...(annotatedCandidate.classification !== undefined
        ? { classification: annotatedCandidate.classification }
        : {}),
      ...(annotatedCandidate.alcoholPct !== undefined
        ? { alcoholPct: annotatedCandidate.alcoholPct }
        : {}),
    };
  });
}
