import type {
  DualLaneArtifact,
  DualLanePresence,
  EntityLaneCandidateArtifact,
  GeneralLaneCandidateArtifact,
  IdentityExactnessTier,
} from '../model/dual-lane-artifact.js';
import type {
  HybridCandidate,
  HybridCandidateBase,
} from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';

const MISSING_LANE_RANK = Number.POSITIVE_INFINITY;

/**
 * Fields where the merge policy is "prefer general lane, fall back to entity lane".
 *
 * These are propagated from the search index summary on either lane; when both
 * lanes hydrated the same entity, the general lane (sparse/dense fusion) is the
 * canonical substrate, so its values win.
 *
 * Constrained to `keyof HybridCandidateBase` so a typo (e.g. renaming a field
 * on the type) becomes a compile error rather than a silent skip at runtime.
 */
const GENERAL_PREFERRED_KEYS = [
  'canonicalLabel',
  'producer',
  'region',
  'closure',
  'searchTextEn',
  'searchTextKo',
  'semanticSummary',
  'grapePrimary',
  'grapes',
  'style',
  'priceBand',
  'pairing',
  'occasion',
  'drinkingWindowStart',
  'drinkingWindowEnd',
  'drinkingWindowModelVersion',
  'vintageYear',
  'body',
  'tannin',
  'acidity',
  'sweetness',
  'finishLength',
  'wineType',
  'criticScoreNormalized',
  'producerPrestige',
  'popularityScore',
  'availability',
  'country',
  'appellation',
  'classification',
  'alcoholPct',
  'priceUsd',
  'certifications',
  'soilType',
  'flavorProfiles',
  'producerType',
  'grapeFamily',
  'regionHierarchy',
  'priceBandNumeric',
  'giftSuitabilityScore',
  'beginnerSuitabilityScore',
] as const satisfies readonly (keyof HybridCandidateBase)[];

/**
 * Fields propagated only from the general lane (retrieval-pass ranking signals).
 *
 * The entity lane is a synthetic resolver path with no sparse/dense ranks of
 * its own, so these never come from the entity candidate.
 */
const GENERAL_ONLY_KEYS = [
  'sparseRank',
  'sparseRawScore',
  'denseRank',
  'denseRawScore',
  'learnedSparseRank',
  'learnedSparseRawScore',
  'anchorRank',
  'anchorRawScore',
  'fusionRrfTotal',
] as const satisfies readonly (keyof HybridCandidateBase)[];

/**
 * Assign `value` to `target[key]` only when defined.
 *
 * Honors `exactOptionalPropertyTypes`: the key is omitted entirely (not set to
 * `undefined`) when the source value is missing, so downstream `in`/`hasOwn`
 * checks behave correctly and structural types stay clean.
 *
 * The target is constrained to `Partial<T>` (rather than `Record<K, V>`) so
 * callers can pass a heterogeneous accumulator whose key types vary; the value
 * type is then derived from `T[K]`, keeping the assignment compile-checked.
 */
function setOptional<T, K extends keyof T>(
  target: Partial<T>,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * Merge two optional values by preferring the first defined one.
 *
 * Trivial alias of `??` lifted to a named function so the merge intent reads
 * uniformly across 40+ field assignments. `mergeOptional(a, b)` ≡ `a ?? b`.
 */
function mergeOptional<T>(a: T | undefined, b: T | undefined): T | undefined {
  return a ?? b;
}

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

  // Required fields (always present) are constructed up-front. Optional fields
  // are layered in via `setOptional`, which preserves `exactOptionalPropertyTypes`
  // semantics by omitting keys whose values are undefined.
  const mergedCandidate: Partial<HybridCandidateBase> & {
    entityId: HybridCandidateBase['entityId'];
    matchedConstraints: HybridCandidateBase['matchedConstraints'];
    retrievalTrace: HybridCandidateBase['retrievalTrace'];
  } = {
    entityId: substrate.entityId,
    matchedConstraints: uniqueStrings([
      ...(generalCandidate?.matchedConstraints ?? []),
      ...(entityCandidate?.matchedConstraints ?? []),
    ]),
    retrievalTrace: trace,
  };

  // Category A: general-preferred fields with entity fallback.
  for (const key of GENERAL_PREFERRED_KEYS) {
    setOptional(
      mergedCandidate,
      key,
      mergeOptional(generalCandidate?.[key], entityCandidate?.[key]),
    );
  }

  // Category B: general-only ranking signals (entity lane has no rank).
  for (const key of GENERAL_ONLY_KEYS) {
    setOptional(mergedCandidate, key, generalCandidate?.[key]);
  }

  // Custom merge results (list union / record dedup).
  setOptional(mergedCandidate, 'sourceRecordRefs', sourceRecordRefs);
  setOptional(mergedCandidate, 'unmetHardConstraints', unmetHardConstraints);
  setOptional(mergedCandidate, 'matchedAtomRefs', matchedAtomRefs);
  setOptional(mergedCandidate, 'unmetAtomRefs', unmetAtomRefs);
  setOptional(
    mergedCandidate,
    'retrievalProvenance',
    mergeOptional(generalCandidate?.retrievalProvenance, entityCandidate?.retrievalProvenance),
  );

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

interface DualLaneFusionResult {
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
