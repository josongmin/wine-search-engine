import type {
  DualLaneArtifact,
  DualLanePresence,
  EntityLaneCandidateArtifact,
  GeneralLaneCandidateArtifact,
  IdentityExactnessTier,
} from '../model/dual-lane-artifact.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';

const MISSING_LANE_RANK = Number.POSITIVE_INFINITY;

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function mergeStringLists(
  primary: readonly string[] | undefined,
  secondary: readonly string[] | undefined,
): readonly string[] | undefined {
  const merged = uniqueStrings([...(primary ?? []), ...(secondary ?? [])]);
  return merged.length > 0 ? merged : undefined;
}

function mergeSourceRecordRefs(
  primary: readonly SourceRecordRef[] | undefined,
  secondary: readonly SourceRecordRef[] | undefined,
): readonly SourceRecordRef[] | undefined {
  const merged = new Map<string, SourceRecordRef>();
  for (const ref of primary ?? []) {
    merged.set(`${ref.sourceSystem}:${ref.sourceRecordId}`, ref);
  }
  for (const ref of secondary ?? []) {
    const key = `${ref.sourceSystem}:${ref.sourceRecordId}`;
    if (!merged.has(key)) {
      merged.set(key, ref);
    }
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function pickFirstDefined<T>(
  primary: T | undefined,
  secondary: T | undefined,
): T | undefined {
  return primary ?? secondary;
}

function mergeRetrievalTrace(
  general: RetrievalTrace | undefined,
  entity: RetrievalTrace,
  lanePresence: DualLanePresence,
): RetrievalTrace {
  const skippedPhases = mergeStringLists(
    general?.skippedPhases,
    entity.skippedPhases,
  );

  return {
    retrievalProfile:
      lanePresence === 'corroborated'
        ? 'dual_lane_fusion'
        : (general?.retrievalProfile ?? entity.retrievalProfile),
    lexicalQueriesUsed: uniqueStrings([
      ...(general?.lexicalQueriesUsed ?? []),
      ...entity.lexicalQueriesUsed,
    ]),
    semanticQueriesUsed: uniqueStrings([
      ...(general?.semanticQueriesUsed ?? []),
      ...entity.semanticQueriesUsed,
    ]),
    filtersApplied: uniqueStrings([
      ...(general?.filtersApplied ?? []),
      ...entity.filtersApplied,
    ]),
    candidateSources: uniqueStrings([
      ...(general?.candidateSources ?? []),
      ...entity.candidateSources,
    ]),
    ...(skippedPhases !== undefined ? { skippedPhases } : {}),
  };
}

function mergeCandidates(params: {
  readonly lanePresence: DualLanePresence;
  readonly exactnessTier: IdentityExactnessTier;
  readonly entityArtifact?: EntityLaneCandidateArtifact | undefined;
  readonly generalArtifact?: GeneralLaneCandidateArtifact | undefined;
}): HybridCandidate {
  const generalCandidate = params.generalArtifact?.candidate;
  const entityCandidate = params.entityArtifact?.candidate;

  if (generalCandidate === undefined && entityCandidate === undefined) {
    throw new Error('fuseDualLaneArtifacts invariant violated: missing both lane candidates');
  }

  const substrate = generalCandidate ?? entityCandidate!;
  const sourceRecordRefs = mergeSourceRecordRefs(
    generalCandidate?.sourceRecordRefs,
    entityCandidate?.sourceRecordRefs,
  );
  const unmetHardConstraints = mergeStringLists(
    generalCandidate?.unmetHardConstraints,
    entityCandidate?.unmetHardConstraints,
  );
  const matchedAtomRefs = mergeStringLists(
    generalCandidate?.matchedAtomRefs,
    entityCandidate?.matchedAtomRefs,
  );
  const unmetAtomRefs = mergeStringLists(
    generalCandidate?.unmetAtomRefs,
    entityCandidate?.unmetAtomRefs,
  );
  const trace = entityCandidate !== undefined
    ? mergeRetrievalTrace(generalCandidate?.retrievalTrace, entityCandidate.retrievalTrace, params.lanePresence)
    : substrate.retrievalTrace;
  const entityPosteriorScore = params.entityArtifact?.identityProvenance.calibratedScore;

  const mergedCandidate = {
    entityId: substrate.entityId,
    ...(pickFirstDefined(generalCandidate?.canonicalLabel, entityCandidate?.canonicalLabel) !== undefined
      ? { canonicalLabel: pickFirstDefined(generalCandidate?.canonicalLabel, entityCandidate?.canonicalLabel) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.producer, entityCandidate?.producer) !== undefined
      ? { producer: pickFirstDefined(generalCandidate?.producer, entityCandidate?.producer) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.region, entityCandidate?.region) !== undefined
      ? { region: pickFirstDefined(generalCandidate?.region, entityCandidate?.region) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.closure, entityCandidate?.closure) !== undefined
      ? { closure: pickFirstDefined(generalCandidate?.closure, entityCandidate?.closure) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.searchTextEn, entityCandidate?.searchTextEn) !== undefined
      ? { searchTextEn: pickFirstDefined(generalCandidate?.searchTextEn, entityCandidate?.searchTextEn) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.searchTextKo, entityCandidate?.searchTextKo) !== undefined
      ? { searchTextKo: pickFirstDefined(generalCandidate?.searchTextKo, entityCandidate?.searchTextKo) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.semanticSummary, entityCandidate?.semanticSummary) !== undefined
      ? { semanticSummary: pickFirstDefined(generalCandidate?.semanticSummary, entityCandidate?.semanticSummary) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.grapePrimary, entityCandidate?.grapePrimary) !== undefined
      ? { grapePrimary: pickFirstDefined(generalCandidate?.grapePrimary, entityCandidate?.grapePrimary) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.grapes, entityCandidate?.grapes) !== undefined
      ? { grapes: pickFirstDefined(generalCandidate?.grapes, entityCandidate?.grapes) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.style, entityCandidate?.style) !== undefined
      ? { style: pickFirstDefined(generalCandidate?.style, entityCandidate?.style) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.priceBand, entityCandidate?.priceBand) !== undefined
      ? { priceBand: pickFirstDefined(generalCandidate?.priceBand, entityCandidate?.priceBand) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.pairing, entityCandidate?.pairing) !== undefined
      ? { pairing: pickFirstDefined(generalCandidate?.pairing, entityCandidate?.pairing) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.occasion, entityCandidate?.occasion) !== undefined
      ? { occasion: pickFirstDefined(generalCandidate?.occasion, entityCandidate?.occasion) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.drinkingWindowStart, entityCandidate?.drinkingWindowStart) !== undefined
      ? { drinkingWindowStart: pickFirstDefined(generalCandidate?.drinkingWindowStart, entityCandidate?.drinkingWindowStart) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.drinkingWindowEnd, entityCandidate?.drinkingWindowEnd) !== undefined
      ? { drinkingWindowEnd: pickFirstDefined(generalCandidate?.drinkingWindowEnd, entityCandidate?.drinkingWindowEnd) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.drinkingWindowModelVersion, entityCandidate?.drinkingWindowModelVersion) !== undefined
      ? { drinkingWindowModelVersion: pickFirstDefined(generalCandidate?.drinkingWindowModelVersion, entityCandidate?.drinkingWindowModelVersion) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.vintageYear, entityCandidate?.vintageYear) !== undefined
      ? { vintageYear: pickFirstDefined(generalCandidate?.vintageYear, entityCandidate?.vintageYear) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.body, entityCandidate?.body) !== undefined
      ? { body: pickFirstDefined(generalCandidate?.body, entityCandidate?.body) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.tannin, entityCandidate?.tannin) !== undefined
      ? { tannin: pickFirstDefined(generalCandidate?.tannin, entityCandidate?.tannin) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.acidity, entityCandidate?.acidity) !== undefined
      ? { acidity: pickFirstDefined(generalCandidate?.acidity, entityCandidate?.acidity) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.sweetness, entityCandidate?.sweetness) !== undefined
      ? { sweetness: pickFirstDefined(generalCandidate?.sweetness, entityCandidate?.sweetness) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.finishLength, entityCandidate?.finishLength) !== undefined
      ? { finishLength: pickFirstDefined(generalCandidate?.finishLength, entityCandidate?.finishLength) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.wineType, entityCandidate?.wineType) !== undefined
      ? { wineType: pickFirstDefined(generalCandidate?.wineType, entityCandidate?.wineType) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.criticScoreNormalized, entityCandidate?.criticScoreNormalized) !== undefined
      ? { criticScoreNormalized: pickFirstDefined(generalCandidate?.criticScoreNormalized, entityCandidate?.criticScoreNormalized) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.producerPrestige, entityCandidate?.producerPrestige) !== undefined
      ? { producerPrestige: pickFirstDefined(generalCandidate?.producerPrestige, entityCandidate?.producerPrestige) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.popularityScore, entityCandidate?.popularityScore) !== undefined
      ? { popularityScore: pickFirstDefined(generalCandidate?.popularityScore, entityCandidate?.popularityScore) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.availability, entityCandidate?.availability) !== undefined
      ? { availability: pickFirstDefined(generalCandidate?.availability, entityCandidate?.availability) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.country, entityCandidate?.country) !== undefined
      ? { country: pickFirstDefined(generalCandidate?.country, entityCandidate?.country) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.appellation, entityCandidate?.appellation) !== undefined
      ? { appellation: pickFirstDefined(generalCandidate?.appellation, entityCandidate?.appellation) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.classification, entityCandidate?.classification) !== undefined
      ? { classification: pickFirstDefined(generalCandidate?.classification, entityCandidate?.classification) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.alcoholPct, entityCandidate?.alcoholPct) !== undefined
      ? { alcoholPct: pickFirstDefined(generalCandidate?.alcoholPct, entityCandidate?.alcoholPct) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.priceUsd, entityCandidate?.priceUsd) !== undefined
      ? { priceUsd: pickFirstDefined(generalCandidate?.priceUsd, entityCandidate?.priceUsd) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.certifications, entityCandidate?.certifications) !== undefined
      ? { certifications: pickFirstDefined(generalCandidate?.certifications, entityCandidate?.certifications) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.soilType, entityCandidate?.soilType) !== undefined
      ? { soilType: pickFirstDefined(generalCandidate?.soilType, entityCandidate?.soilType) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.flavorProfiles, entityCandidate?.flavorProfiles) !== undefined
      ? { flavorProfiles: pickFirstDefined(generalCandidate?.flavorProfiles, entityCandidate?.flavorProfiles) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.producerType, entityCandidate?.producerType) !== undefined
      ? { producerType: pickFirstDefined(generalCandidate?.producerType, entityCandidate?.producerType) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.grapeFamily, entityCandidate?.grapeFamily) !== undefined
      ? { grapeFamily: pickFirstDefined(generalCandidate?.grapeFamily, entityCandidate?.grapeFamily) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.regionHierarchy, entityCandidate?.regionHierarchy) !== undefined
      ? { regionHierarchy: pickFirstDefined(generalCandidate?.regionHierarchy, entityCandidate?.regionHierarchy) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.priceBandNumeric, entityCandidate?.priceBandNumeric) !== undefined
      ? { priceBandNumeric: pickFirstDefined(generalCandidate?.priceBandNumeric, entityCandidate?.priceBandNumeric) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.giftSuitabilityScore, entityCandidate?.giftSuitabilityScore) !== undefined
      ? { giftSuitabilityScore: pickFirstDefined(generalCandidate?.giftSuitabilityScore, entityCandidate?.giftSuitabilityScore) }
      : {}),
    ...(pickFirstDefined(generalCandidate?.beginnerSuitabilityScore, entityCandidate?.beginnerSuitabilityScore) !== undefined
      ? { beginnerSuitabilityScore: pickFirstDefined(generalCandidate?.beginnerSuitabilityScore, entityCandidate?.beginnerSuitabilityScore) }
      : {}),
    ...(generalCandidate?.sparseRank !== undefined ? { sparseRank: generalCandidate.sparseRank } : {}),
    ...(generalCandidate?.sparseRawScore !== undefined ? { sparseRawScore: generalCandidate.sparseRawScore } : {}),
    ...(generalCandidate?.denseRank !== undefined ? { denseRank: generalCandidate.denseRank } : {}),
    ...(generalCandidate?.denseRawScore !== undefined ? { denseRawScore: generalCandidate.denseRawScore } : {}),
    ...(generalCandidate?.learnedSparseRank !== undefined ? { learnedSparseRank: generalCandidate.learnedSparseRank } : {}),
    ...(generalCandidate?.learnedSparseRawScore !== undefined ? { learnedSparseRawScore: generalCandidate.learnedSparseRawScore } : {}),
    ...(generalCandidate?.anchorRank !== undefined ? { anchorRank: generalCandidate.anchorRank } : {}),
    ...(generalCandidate?.anchorRawScore !== undefined ? { anchorRawScore: generalCandidate.anchorRawScore } : {}),
    ...(generalCandidate?.fusionRrfTotal !== undefined ? { fusionRrfTotal: generalCandidate.fusionRrfTotal } : {}),
    ...(sourceRecordRefs !== undefined ? { sourceRecordRefs } : {}),
    matchedConstraints: uniqueStrings([
      ...(generalCandidate?.matchedConstraints ?? []),
      ...(entityCandidate?.matchedConstraints ?? []),
    ]),
    ...(unmetHardConstraints !== undefined ? { unmetHardConstraints } : {}),
    ...(matchedAtomRefs !== undefined ? { matchedAtomRefs } : {}),
    ...(unmetAtomRefs !== undefined ? { unmetAtomRefs } : {}),
    retrievalTrace: trace,
    ...(generalCandidate?.retrievalProvenance !== undefined
      ? { retrievalProvenance: generalCandidate.retrievalProvenance }
      : entityCandidate?.retrievalProvenance !== undefined
        ? { retrievalProvenance: entityCandidate.retrievalProvenance }
        : {}),
  };

  if (params.lanePresence === 'general_only') {
    return {
      ...mergedCandidate,
      identityExactnessTier: 'none',
      lanePresence: 'general_only',
    };
  }

  const lanePresence: Exclude<DualLanePresence, 'general_only'> = params.lanePresence;
  return {
    ...mergedCandidate,
    ...(entityPosteriorScore !== undefined ? { entityPosteriorScore } : {}),
    identityExactnessTier: params.exactnessTier,
    lanePresence,
  };
}

function compareArtifacts(
  left: DualLaneArtifact,
  right: DualLaneArtifact,
): number {
  const leftGeneralRank = left.generalLane?.rank ?? MISSING_LANE_RANK;
  const rightGeneralRank = right.generalLane?.rank ?? MISSING_LANE_RANK;
  if (leftGeneralRank !== rightGeneralRank) {
    return leftGeneralRank - rightGeneralRank;
  }

  const leftEntityRank = left.entityLane?.resolvedCandidate.rank ?? MISSING_LANE_RANK;
  const rightEntityRank = right.entityLane?.resolvedCandidate.rank ?? MISSING_LANE_RANK;
  if (leftEntityRank !== rightEntityRank) {
    return leftEntityRank - rightEntityRank;
  }

  return left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0;
}

export interface DualLaneFusionResult {
  readonly fusedCandidates: readonly HybridCandidate[];
  readonly laneArtifacts: readonly DualLaneArtifact[];
}

export function fuseDualLaneArtifacts(params: {
  readonly entityLaneArtifacts: readonly EntityLaneCandidateArtifact[];
  readonly generalLaneCandidates: readonly HybridCandidate[];
}): DualLaneFusionResult {
  const generalLaneArtifacts = new Map<string, GeneralLaneCandidateArtifact>();
  for (const [index, candidate] of params.generalLaneCandidates.entries()) {
    generalLaneArtifacts.set(String(candidate.entityId), {
      entityId: candidate.entityId,
      candidate,
      rank: index + 1,
    });
  }

  const entityLaneArtifacts = new Map(
    params.entityLaneArtifacts.map((artifact) => [String(artifact.entityId), artifact] as const),
  );
  const entityIds = new Set<string>([
    ...generalLaneArtifacts.keys(),
    ...entityLaneArtifacts.keys(),
  ]);

  const artifacts: DualLaneArtifact[] = [];
  for (const entityId of entityIds) {
    const entityArtifact = entityLaneArtifacts.get(entityId);
    const generalArtifact = generalLaneArtifacts.get(entityId);
    const lanePresence: DualLanePresence =
      entityArtifact !== undefined && generalArtifact !== undefined
        ? 'corroborated'
        : entityArtifact !== undefined
          ? 'entity_only'
          : 'general_only';
    const exactnessTier = entityArtifact?.identityProvenance.exactnessTier ?? 'none';
    const fusedCandidate = mergeCandidates({
      lanePresence,
      exactnessTier,
      entityArtifact,
      generalArtifact,
    });
    artifacts.push({
      entityId: fusedCandidate.entityId,
      canonicalLabel:
        fusedCandidate.canonicalLabel
        ?? entityArtifact?.resolvedCandidate.canonicalLabel
        ?? String(fusedCandidate.entityId),
      lanePresence,
      ...(entityArtifact?.identityProvenance !== undefined
        ? { identityProvenance: entityArtifact.identityProvenance }
        : {}),
      ...(entityArtifact !== undefined ? { entityLane: entityArtifact } : {}),
      ...(generalArtifact !== undefined ? { generalLane: generalArtifact } : {}),
      fusedCandidate,
    });
  }

  artifacts.sort(compareArtifacts);

  return {
    laneArtifacts: artifacts,
    fusedCandidates: artifacts.map((artifact) => artifact.fusedCandidate),
  };
}
