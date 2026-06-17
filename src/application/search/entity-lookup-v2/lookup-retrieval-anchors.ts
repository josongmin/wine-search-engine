import type { AnchorCandidate } from '../../../domain/query/model/anchor-candidate.js';
import type { CanonicalEntityId } from '../../../domain/shared/types/index.js';
import type {
  LookupCandidate,
  LookupRetrievalChannel,
  LookupRetrievalResult,
} from '../../../domain/resolver/v2/lookup-v2-types.js';

const CHANNEL_TO_LOOKUP_STRATEGY: Readonly<Record<LookupRetrievalChannel, string>> = {
  exact_alias: 'exact',
  compact_exact: 'compact_exact',
  transliteration_exact: 'transliterated_exact',
  jamo_phonetic: 'phonetic_exact',
  fuzzy_alias: 'transliterated_fuzzy',
  family_graph: 'family_graph',
  line_graph: 'line_graph',
  vintage_graph: 'vintage_graph',
  dense: 'dense',
};

/**
 * Project timed multi-channel retrieval hits into planner anchors so alias
 * recall runs once per request (retrieval engine owns the matcher fanout).
 */
export function buildAnchorsFromRetrievalResult(args: {
  readonly rawQuery: string;
  readonly normalizedQuery: string;
  readonly retrieval: LookupRetrievalResult;
}): readonly AnchorCandidate[] {
  return args.retrieval.candidates.map((candidate) =>
    buildAnchorFromLookupCandidate(args.rawQuery, args.normalizedQuery, candidate),
  );
}

function buildAnchorFromLookupCandidate(
  rawQuery: string,
  normalizedQuery: string,
  candidate: LookupCandidate,
): AnchorCandidate {
  const lookupStrategies = [
    ...new Set(
      candidate.channelHits
        .map((hit) => CHANNEL_TO_LOOKUP_STRATEGY[hit.channel] ?? hit.channel),
    ),
  ];
  const confidence = candidate.channelHits.reduce(
    (max, hit) => Math.max(max, hit.channelScore),
    0,
  );
  const matchedAlias = candidate.channelHits.find((hit) => hit.matchedAlias !== undefined)?.matchedAlias;
  return {
    surfaceForm: rawQuery,
    normalizedForm: normalizedQuery,
    candidateEntityIds: [candidate.entityId as CanonicalEntityId],
    lookupVariants: matchedAlias !== undefined ? [matchedAlias] : [normalizedQuery],
    lookupStrategies: lookupStrategies.length > 0 ? lookupStrategies : ['exact'],
    aliasType: 'observed_query_alias',
    confidence,
    source: 'alias',
  };
}
