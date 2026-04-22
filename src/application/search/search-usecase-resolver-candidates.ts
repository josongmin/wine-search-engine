import type { AliasType } from '../../domain/alias/model/alias.js';
import type { AnchorCandidate } from '../../domain/query/model/anchor-candidate.js';
import type { ResolverCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import type { MatchSignalSet } from '../../domain/resolver/model/match-signal-set.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type { EntityDocumentLookupPort } from './port/search-pipeline-deps.port.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import type {
  EntityCandidateGeneratorInput,
  EntityCandidateSource,
} from '../../domain/resolver/model/entity-candidate-generator-input.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import {
  hasExactLikeLookupStrategy,
  hasPhoneticLookupStrategy,
  hasTranslationLookupStrategy,
} from '../../domain/query/service/lookup-strategy-taxonomy.js';
import { buildResolverCandidateAttributeHints } from './search-usecase-entity-attribute-projection.js';

const ZERO_SIGNALS: MatchSignalSet = {
  canonicalExactMatch: 0,
  canonicalNormalizedMatch: 0,
  aliasExactMatch: 0,
  aliasFuzzyMatch: 0,
  aliasTypePrior: 0,
  producerMatch: 0,
  vintageMatch: 0,
  regionMatch: 0,
  grapeHintMatch: 0,
  phoneticMatch: 0,
  editDistanceScore: 0,
  ambiguityPenalty: 0,
};

/** Down-weights fuzzy edit-distance matches by 20% relative to exact alias
 *  confidence. Rationale: edit-distance matches have higher false-positive
 *  rate (e.g. "Barolo" vs "Barossa"), so the confidence discount reflects
 *  the additional ambiguity inherent in fuzzy matching. */
const FUZZY_EDIT_DISTANCE_CONFIDENCE_FACTOR = 0.8;

function normalizeIdentitySurface(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function identitySurfaceKeys(value: string): readonly string[] {
  const views = buildNormalizedQueryViews(value);
  const surfaces = [
    views.vintageStripped,
    ...views.lookupVariants,
  ];
  return [...new Set(
    surfaces
      .map(normalizeIdentitySurface)
      .filter((key) => key.length > 0),
  )];
}

function stripParenthetical(value: string): string {
  return value.replace(/\([^)]*\)/gu, ' ');
}

function coreIdentityKey(value: string): string {
  return normalizeIdentitySurface(buildNormalizedQueryViews(stripParenthetical(value)).vintageStripped);
}

function removeAllOccurrences(value: string, needle: string): string {
  if (needle.length === 0) {
    return value;
  }
  return value
    .split(needle)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isProducerOnlyAliasForDistinctWine(
  doc: RetrievalDocument,
  identitySurface: string,
): boolean {
  if (doc.entityType !== 'wine' || typeof doc.producer !== 'string' || doc.producer.trim().length === 0) {
    return false;
  }

  const producerKey = coreIdentityKey(doc.producer);
  const aliasKey = coreIdentityKey(identitySurface);
  if (producerKey.length === 0 || aliasKey !== producerKey) {
    return false;
  }

  const canonicalKey = coreIdentityKey(doc.canonicalLabel);
  return removeAllOccurrences(canonicalKey, producerKey).length > 0;
}

function collectIdentitySafeKeys(doc: RetrievalDocument): ReadonlySet<string> {
  const keys = new Set<string>();
  const aliases: readonly string[] = doc.aliasesIdentitySafe;
  const label = doc.canonicalLabel;
  const identitySurfaces: string[] = [
    ...(typeof label === 'string' ? [label] : []),
    ...aliases,
  ];

  for (const surface of identitySurfaces) {
    if (isProducerOnlyAliasForDistinctWine(doc, surface)) {
      continue;
    }
    for (const key of identitySurfaceKeys(surface)) {
      keys.add(key);
    }
  }

  return keys;
}

function collectAnchorIdentityKeys(
  normalizedQuery: string,
  anchor: AnchorCandidate,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const anchorSurfaces = [
    normalizedQuery,
    anchor.surfaceForm,
    anchor.normalizedForm,
    ...(anchor.lookupVariants ?? []),
  ];

  for (const surface of anchorSurfaces) {
    for (const key of identitySurfaceKeys(surface)) {
      keys.add(key);
    }
  }

  return keys;
}

function anchorMatchesIdentitySafeProjection(
  normalizedQuery: string,
  anchor: AnchorCandidate,
  doc: RetrievalDocument,
): boolean | undefined {
  const identityKeys = collectIdentitySafeKeys(doc);
  if (identityKeys.size === 0) {
    return undefined;
  }

  const anchorKeys = collectAnchorIdentityKeys(normalizedQuery, anchor);
  for (const key of anchorKeys) {
    if (identityKeys.has(key)) {
      return true;
    }
  }

  return false;
}

function inferAliasType(anchor: AnchorCandidate): AliasType {
  const strategies = new Set(anchor.lookupStrategies ?? []);
  if (hasPhoneticLookupStrategy(strategies)) {
    return 'phonetic';
  }
  if (hasTranslationLookupStrategy(strategies)) {
    return 'translation';
  }
  if (
    strategies.has('fuzzy_char_ngram') ||
    strategies.has('substring') ||
    strategies.has('smart_document')
  ) {
    return 'misspelling';
  }
  return 'canonical';
}

function buildSignals(
  normalizedQuery: string,
  anchor: AnchorCandidate,
  doc: RetrievalDocument,
): MatchSignalSet {
  const strategies = new Set(anchor.lookupStrategies ?? []);
  const exactLike = hasExactLikeLookupStrategy(strategies);
  const fuzzyLike =
    strategies.has('fuzzy_char_ngram') ||
    strategies.has('transliterated_fuzzy') ||
    strategies.has('phonetic_fuzzy') ||
    strategies.has('substring') ||
    strategies.has('smart_document');

  const identitySafeMatch = exactLike
    ? anchorMatchesIdentitySafeProjection(normalizedQuery, anchor, doc)
    : undefined;
  const exactSignalAllowed = identitySafeMatch !== false;
  const identityNormalizedMatch = identitySafeMatch === false ? 0 : anchor.confidence;

  return {
    ...ZERO_SIGNALS,
    canonicalExactMatch: exactSignalAllowed && exactLike && normalizedQuery === anchor.normalizedForm ? 1 : 0,
    canonicalNormalizedMatch: identityNormalizedMatch,
    aliasExactMatch: exactSignalAllowed && exactLike ? anchor.confidence : 0,
    aliasFuzzyMatch: fuzzyLike ? anchor.confidence : 0,
    aliasTypePrior: anchor.confidence,
    phoneticMatch: hasPhoneticLookupStrategy(strategies) ? anchor.confidence : 0,
    editDistanceScore: fuzzyLike ? anchor.confidence * FUZZY_EDIT_DISTANCE_CONFIDENCE_FACTOR : 0,
  };
}

function mergeSignals(
  left: MatchSignalSet,
  right: MatchSignalSet,
): MatchSignalSet {
  return {
    canonicalExactMatch: Math.max(left.canonicalExactMatch, right.canonicalExactMatch),
    canonicalNormalizedMatch: Math.max(left.canonicalNormalizedMatch, right.canonicalNormalizedMatch),
    aliasExactMatch: Math.max(left.aliasExactMatch, right.aliasExactMatch),
    aliasFuzzyMatch: Math.max(left.aliasFuzzyMatch, right.aliasFuzzyMatch),
    aliasTypePrior: Math.max(left.aliasTypePrior, right.aliasTypePrior),
    producerMatch: Math.max(left.producerMatch, right.producerMatch),
    vintageMatch: Math.max(left.vintageMatch, right.vintageMatch),
    regionMatch: Math.max(left.regionMatch, right.regionMatch),
    grapeHintMatch: Math.max(left.grapeHintMatch, right.grapeHintMatch),
    phoneticMatch: Math.max(left.phoneticMatch, right.phoneticMatch),
    editDistanceScore: Math.max(left.editDistanceScore, right.editDistanceScore),
    ambiguityPenalty: Math.max(left.ambiguityPenalty, right.ambiguityPenalty),
  };
}

function mergeSources(
  existing: readonly EntityCandidateSource[] | undefined,
  incoming: EntityCandidateSource | undefined,
): readonly EntityCandidateSource[] | undefined {
  if (incoming === undefined) {
    return existing;
  }
  const merged = new Set(existing ?? []);
  merged.add(incoming);
  return [...merged].sort();
}

function describeEntityIds(ids: readonly CanonicalEntityId[]): string {
  return ids.map((id) => String(id)).join(', ');
}

/**
 * TA2-3: Build resolver candidates from the shared entity candidate generator
 * input contract (EntityCandidateGeneratorInput).
 *
 * Extends the prior anchors-only contract to include:
 *   - blockerOnlyIds: IDs from Blocker.block() not covered by any anchor
 *   - preloadedDocs: upstream prefetch cache to avoid N+1 fetches
 *
 * Blocker-seeded candidates are emitted with ZERO_SIGNALS and
 * `source: 'blocker_seed'` — they carry no alias surface form.
 * The scorer's attribute-hint pathway populates their effective score.
 *
 * @param input  Shared generator contract
 * @param entityLookup  Port for fetching entity documents by ID
 */
export async function buildResolverCandidatesFromGenerator(
  input: EntityCandidateGeneratorInput,
  entityLookup: EntityDocumentLookupPort | undefined,
): Promise<readonly ResolverCandidate[]> {
  if (input.anchors.length === 0 && (input.blockerOnlyIds == null || input.blockerOnlyIds.length === 0)) {
    return [];
  }
  if (entityLookup === undefined) {
    throw new DomainError(
      'INTERNAL_INCONSISTENCY',
      'Entity candidate generation requires entityLookup when anchors or blocker seeds are present.',
    );
  }

  // Collect all unique entity IDs: from anchors + blocker-only additions
  const allEntityIds = new Set<CanonicalEntityId>();
  for (const anchor of input.anchors) {
    for (const id of anchor.candidateEntityIds) {
      allEntityIds.add(id);
    }
  }
  const blockerOnlyIds = input.blockerOnlyIds ?? [];
  for (const id of blockerOnlyIds) {
    allEntityIds.add(id);
  }

  // Resolve documents: use preloaded cache first, then fetch missing IDs.
  const docMap = new Map<CanonicalEntityId, RetrievalDocument>();

  // Populate from upstream prefetch cache
  if (input.preloadedDocs != null) {
    for (const [key, doc] of input.preloadedDocs) {
      // preloadedDocs keys are string-coerced EntityIds; match by stringified form
      for (const id of allEntityIds) {
        if (String(id) === key) {
          docMap.set(id, doc);
        }
      }
    }
  }

  // -- Batch hydration (required production path) ----------------------------
  // Fetch IDs not covered by the prefetch cache via the batch port.
  // Single-fetch supplement has been removed (T-E4-01): getDocuments() is the
  // only production hydration path. Partial resolution is forbidden -- any
  // unresolved IDs are a loud error.
  const missingIds = [...allEntityIds].filter((id) => !docMap.has(id));
  if (missingIds.length > 0) {
    try {
      const docs = await entityLookup.getDocuments(missingIds);
      for (const [id, doc] of docs) {
        docMap.set(id, doc);
      }
    } catch (error: unknown) {
      // Failure taxonomy: batch_lookup_failed -- the entire batch fetch errored.
      const message = error instanceof Error ? error.message : String(error);
      throw new DomainError(
        'INTERNAL_INCONSISTENCY',
        `batch_lookup_failed: getDocuments() threw for ${missingIds.length} ids | ${message}`,
      );
    }

    // Failure taxonomy: document_missing / partial_resolution_forbidden --
    // batch returned successfully but some documents were absent.
    const unresolvedIds = [...allEntityIds].filter((id) => !docMap.has(id));
    if (unresolvedIds.length > 0) {
      throw new DomainError(
        'INTERNAL_INCONSISTENCY',
        [
          'partial_resolution_forbidden: entity candidate hydration incomplete',
          `requested=${allEntityIds.size}`,
          `resolved=${docMap.size}`,
          `document_missing=[${describeEntityIds(unresolvedIds)}]`,
        ].join(' | '),
      );
    }
  }

  // Build candidates from the pre-fetched map (synchronous)
  const candidatesById = new Map<string, ResolverCandidate>();

  // 1. Anchor-sourced candidates (carry full signal sets)
  for (const anchor of input.anchors) {
    for (const entityId of anchor.candidateEntityIds) {
      const doc = docMap.get(entityId);
      if (doc == null) {
        continue;
      }
      const attributeHints = buildResolverCandidateAttributeHints(doc);
      const key = String(entityId);
      const incomingAliasMatch = {
        aliasValue: anchor.surfaceForm,
        aliasType: inferAliasType(anchor),
        matchScore: anchor.confidence,
      } as const;
      const incomingSignals = buildSignals(input.normalizedQuery, anchor, doc);
      const existing = candidatesById.get(key);
      if (existing === undefined) {
        candidatesById.set(key, {
          entityId,
          entityType: doc.entityType,
          canonicalLabel: doc.canonicalLabel,
          aliasMatches: [incomingAliasMatch],
          ...(attributeHints !== undefined ? { attributeHints } : {}),
          ...(doc.sourceRecordRefs !== undefined && doc.sourceRecordRefs.length > 0
            ? { sourceRecordRefs: doc.sourceRecordRefs }
            : {}),
          sourceSignals: incomingSignals,
          source: anchor.source,
          ...(mergeSources(undefined, anchor.source) !== undefined
            ? { sources: mergeSources(undefined, anchor.source) }
            : {}),
        });
        continue;
      }

      const aliasMatches = [
        ...existing.aliasMatches,
        incomingAliasMatch,
      ].filter((match, index, all) => all.findIndex((candidate) => (
        candidate.aliasValue === match.aliasValue
        && candidate.aliasType === match.aliasType
        && candidate.matchScore === match.matchScore
      )) === index);
      const mergedSources = mergeSources(existing.sources, anchor.source);
      candidatesById.set(key, {
        ...existing,
        aliasMatches,
        sourceSignals: mergeSignals(existing.sourceSignals, incomingSignals),
        ...(mergedSources !== undefined ? { sources: mergedSources } : {}),
        ...(mergedSources !== undefined && mergedSources.length === 1
          ? { source: mergedSources[0] }
          : { source: undefined }),
      });
    }
  }

  // 2. Blocker-seeded candidates (zero signal sets; not covered by any anchor)
  for (const entityId of blockerOnlyIds) {
    const key = String(entityId);
    if (candidatesById.has(key)) {
      continue;
    }
    const doc = docMap.get(entityId);
    if (doc == null) {
      continue;
    }
    const attributeHints = buildResolverCandidateAttributeHints(doc);
    candidatesById.set(key, {
      entityId,
      entityType: doc.entityType,
      canonicalLabel: doc.canonicalLabel,
      aliasMatches: [],
      ...(attributeHints !== undefined ? { attributeHints } : {}),
      ...(doc.sourceRecordRefs !== undefined && doc.sourceRecordRefs.length > 0
        ? { sourceRecordRefs: doc.sourceRecordRefs }
        : {}),
      sourceSignals: ZERO_SIGNALS,
      source: 'blocker_seed',
      sources: ['blocker_seed'],
    });
  }

  return [...candidatesById.values()];
}
