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

function inferAliasType(anchor: AnchorCandidate): AliasType {
  const strategies = new Set(anchor.lookupStrategies ?? []);
  if (strategies.has('phonetic_exact') || strategies.has('phonetic_fuzzy')) {
    return 'phonetic';
  }
  if (strategies.has('transliterated_exact') || strategies.has('transliterated_fuzzy')) {
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

function buildSignals(normalizedQuery: string, anchor: AnchorCandidate): MatchSignalSet {
  const strategies = new Set(anchor.lookupStrategies ?? []);
  const exactLike =
    strategies.has('exact') ||
    strategies.has('lexical_exact') ||
    strategies.has('compact_exact') ||
    strategies.has('transliterated_exact') ||
    strategies.has('phonetic_exact');
  const fuzzyLike =
    strategies.has('fuzzy_char_ngram') ||
    strategies.has('transliterated_fuzzy') ||
    strategies.has('phonetic_fuzzy') ||
    strategies.has('substring') ||
    strategies.has('smart_document');

  return {
    ...ZERO_SIGNALS,
    canonicalExactMatch: exactLike && normalizedQuery === anchor.normalizedForm ? 1 : 0,
    canonicalNormalizedMatch: anchor.confidence,
    aliasExactMatch: exactLike ? anchor.confidence : 0,
    aliasFuzzyMatch: fuzzyLike ? anchor.confidence : 0,
    aliasTypePrior: anchor.confidence,
    phoneticMatch:
      strategies.has('phonetic_exact') || strategies.has('phonetic_fuzzy')
        ? anchor.confidence
        : 0,
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

function buildAttributeHints(
  doc: RetrievalDocument,
): Readonly<Record<string, unknown>> | undefined {
  const hints: Record<string, unknown> = {};

  if (typeof doc.producer === 'string' && doc.producer.length > 0) hints['producer'] = doc.producer;
  if (typeof doc.region === 'string' && doc.region.length > 0) hints['region'] = doc.region;
  if (typeof doc.appellation === 'string' && doc.appellation.length > 0) hints['appellation'] = doc.appellation;
  if (typeof doc.country === 'string' && doc.country.length > 0) hints['country'] = doc.country;
  if (typeof doc.grapePrimary === 'string' && doc.grapePrimary.length > 0) hints['grape_primary'] = doc.grapePrimary;
  if (Array.isArray(doc.grapes) && doc.grapes.length > 0) hints['grapes'] = doc.grapes;
  if (typeof doc.style === 'string' && doc.style.length > 0) hints['style'] = doc.style;
  if (typeof doc.priceBand === 'string' && doc.priceBand.length > 0) hints['price_band'] = doc.priceBand;
  if (Array.isArray(doc.pairing) && doc.pairing.length > 0) hints['pairing'] = doc.pairing;
  if (Array.isArray(doc.occasion) && doc.occasion.length > 0) hints['occasion'] = doc.occasion;
  if (doc.vintageYear !== undefined) {
    hints['vintage'] = doc.vintageYear;
    hints['vintage_year'] = doc.vintageYear;
  }
  if (doc.body !== undefined) hints['body'] = doc.body;
  if (doc.tannin !== undefined) hints['tannin'] = doc.tannin;
  if (doc.acidity !== undefined) hints['acidity'] = doc.acidity;
  if (doc.sweetness !== undefined) hints['sweetness'] = doc.sweetness;
  if (typeof doc.wineType === 'string' && doc.wineType.length > 0) hints['wine_type'] = doc.wineType;
  if (typeof doc.classification === 'string' && doc.classification.length > 0) hints['classification'] = doc.classification;
  if (doc.alcoholPct !== undefined) hints['alcohol_pct'] = doc.alcoholPct;
  if (doc.priceUsd !== undefined) hints['price_usd'] = doc.priceUsd;
  if (doc.producerPrestige !== undefined) hints['producer_prestige'] = doc.producerPrestige;
  if (doc.criticScoreNormalized !== undefined) hints['critic_score_normalized'] = doc.criticScoreNormalized;
  if (Array.isArray(doc.certifications) && doc.certifications.length > 0) hints['certifications'] = doc.certifications;
  if (typeof doc.soilType === 'string' && doc.soilType.length > 0) hints['soil_type'] = doc.soilType;
  if (typeof doc.producerType === 'string' && doc.producerType.length > 0) hints['producer_type'] = doc.producerType;
  if (typeof doc.grapeFamily === 'string' && doc.grapeFamily.length > 0) hints['grape_family'] = doc.grapeFamily;
  if (Array.isArray(doc.flavorProfiles) && doc.flavorProfiles.length > 0) hints['flavor_profiles'] = doc.flavorProfiles;

  return Object.keys(hints).length > 0 ? hints : undefined;
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

  // Build set of IDs covered by anchors (used to tag blocker-only seeds)
  const anchorCoveredIds = new Set<string>();
  for (const anchor of input.anchors) {
    for (const id of anchor.candidateEntityIds) {
      anchorCoveredIds.add(String(id));
    }
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

  // Fetch IDs not covered by the prefetch cache
  const missingIds = [...allEntityIds].filter((id) => !docMap.has(id));
  if (missingIds.length > 0) {
    const settled = await Promise.allSettled(
      missingIds.map(async (id) => {
        const doc = await entityLookup.getDocument(id);
        return [id, doc] as const;
      }),
    );
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const [id, doc] = result.value;
        if (doc != null) {
          docMap.set(id, doc);
        }
      }
      // rejected results are silently skipped — correct degradation behaviour.
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
      const attributeHints = buildAttributeHints(doc);
      const key = String(entityId);
      const incomingAliasMatch = {
        aliasValue: anchor.surfaceForm,
        aliasType: inferAliasType(anchor),
        matchScore: anchor.confidence,
      } as const;
      const incomingSignals = buildSignals(input.normalizedQuery, anchor);
      const existing = candidatesById.get(key);
      if (existing === undefined) {
        candidatesById.set(key, {
          entityId,
          entityType: doc.entityType,
          canonicalLabel: doc.canonicalLabel,
          aliasMatches: [incomingAliasMatch],
          ...(attributeHints !== undefined ? { attributeHints } : {}),
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
    const attributeHints = buildAttributeHints(doc);
    candidatesById.set(key, {
      entityId,
      entityType: doc.entityType,
      canonicalLabel: doc.canonicalLabel,
      aliasMatches: [],
      ...(attributeHints !== undefined ? { attributeHints } : {}),
      sourceSignals: ZERO_SIGNALS,
      source: 'blocker_seed',
      sources: ['blocker_seed'],
    });
  }

  return [...candidatesById.values()];
}
