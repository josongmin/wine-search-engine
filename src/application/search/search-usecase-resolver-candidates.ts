import type { AliasType } from '../../domain/alias/model/alias.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { AnchorCandidate } from '../../domain/query/model/anchor-candidate.js';
import type { ResolverCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import type { MatchSignalSet } from '../../domain/resolver/model/match-signal-set.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type { EntityDocumentLookupPort } from './port/search-pipeline-deps.port.js';
import type {
  EntityCandidateGeneratorInput,
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
  if (entityLookup === undefined) {
    return [];
  }
  if (input.anchors.length === 0 && (input.blockerOnlyIds == null || input.blockerOnlyIds.length === 0)) {
    return [];
  }

  // Collect all unique entity IDs: from anchors + blocker-only additions
  const allEntityIds = new Set<EntityId>();
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
  const docMap = new Map<EntityId, RetrievalDocument>();

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
  const seen = new Set<EntityId>();
  const candidates: ResolverCandidate[] = [];

  // 1. Anchor-sourced candidates (carry full signal sets)
  for (const anchor of input.anchors) {
    for (const entityId of anchor.candidateEntityIds) {
      if (seen.has(entityId)) {
        continue;
      }
      const doc = docMap.get(entityId);
      if (doc == null) {
        continue;
      }
      seen.add(entityId);
      candidates.push({
        entityId,
        entityType: doc.entityType,
        canonicalLabel: doc.canonicalLabel,
        aliasMatches: [
          {
            aliasValue: anchor.surfaceForm,
            aliasType: inferAliasType(anchor),
            matchScore: anchor.confidence,
          },
        ],
        sourceSignals: buildSignals(input.normalizedQuery, anchor),
      });
    }
  }

  // 2. Blocker-seeded candidates (zero signal sets; not covered by any anchor)
  for (const entityId of blockerOnlyIds) {
    if (seen.has(entityId)) {
      continue;
    }
    const doc = docMap.get(entityId);
    if (doc == null) {
      continue;
    }
    seen.add(entityId);
    candidates.push({
      entityId,
      entityType: doc.entityType,
      canonicalLabel: doc.canonicalLabel,
      aliasMatches: [],
      sourceSignals: ZERO_SIGNALS,
      source: 'blocker_seed',
    });
  }

  return candidates;
}

/**
 * Legacy entry point — builds generator input from a QueryPlanV1 and delegates
 * to `buildResolverCandidatesFromGenerator`.
 *
 * Retained for backwards compatibility with callers that still pass a raw
 * QueryPlanV1. Prefer `buildResolverCandidatesFromGenerator` for new code.
 */
export async function buildResolverCandidatesFromPlan(
  plan: QueryPlanV1,
  entityLookup: EntityDocumentLookupPort | undefined,
): Promise<readonly ResolverCandidate[]> {
  const generatorInput: EntityCandidateGeneratorInput = {
    rawQuery: plan.rawQuery,
    normalizedQuery: plan.normalizedQuery,
    anchors: plan.anchors,
    // blockerOnlyIds and preloadedDocs are not yet available at this call site.
    // TA2-4 will thread blocker output here after the blocker runs in the resolver.
  };
  return buildResolverCandidatesFromGenerator(generatorInput, entityLookup);
}
