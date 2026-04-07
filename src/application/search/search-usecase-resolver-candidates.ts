import type { AliasType } from '../../domain/alias/model/alias.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { AnchorCandidate } from '../../domain/query/model/anchor-candidate.js';
import type { ResolverCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import type { MatchSignalSet } from '../../domain/resolver/model/match-signal-set.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type { EntityDocumentLookupPort } from './port/search-pipeline-deps.port.js';

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

function buildSignals(plan: QueryPlanV1, anchor: AnchorCandidate): MatchSignalSet {
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
    canonicalExactMatch: exactLike && plan.normalizedQuery === anchor.normalizedForm ? 1 : 0,
    canonicalNormalizedMatch: anchor.confidence,
    aliasExactMatch: exactLike ? anchor.confidence : 0,
    aliasFuzzyMatch: fuzzyLike ? anchor.confidence : 0,
    aliasTypePrior: anchor.confidence,
    phoneticMatch:
      strategies.has('phonetic_exact') || strategies.has('phonetic_fuzzy')
        ? anchor.confidence
        : 0,
    editDistanceScore: fuzzyLike ? anchor.confidence * 0.8 : 0,
  };
}

export async function buildResolverCandidatesFromPlan(
  plan: QueryPlanV1,
  entityLookup: EntityDocumentLookupPort | undefined,
): Promise<readonly ResolverCandidate[]> {
  if (entityLookup === undefined || plan.anchors.length === 0) {
    return [];
  }

  // Collect all unique entity IDs across anchors
  const allEntityIds = new Set<EntityId>();
  for (const anchor of plan.anchors) {
    for (const id of anchor.candidateEntityIds) {
      allEntityIds.add(id);
    }
  }

  // Fetch all documents in parallel (eliminates N+1 sequential latency)
  const docEntries = await Promise.all(
    [...allEntityIds].map(async (id) => {
      const doc = await entityLookup.getDocument(id);
      return [id, doc] as const;
    }),
  );
  const docMap = new Map(
    docEntries.filter((entry): entry is [EntityId, RetrievalDocument] => entry[1] != null),
  );

  // Build candidates from the pre-fetched map (synchronous)
  const seen = new Set<EntityId>();
  const candidates: ResolverCandidate[] = [];

  for (const anchor of plan.anchors) {
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
        sourceSignals: buildSignals(plan, anchor),
      });
    }
  }

  return candidates;
}
