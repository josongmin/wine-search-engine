import type { QueryFamilyLabel } from '../../query/model/query-observability-vocab.js';
import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_BROWSE_PRODUCER,
  RETRIEVAL_CHANNEL_BROWSE_REGION,
  RETRIEVAL_CHANNEL_COMPARE_ANCHOR,
  RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
  RETRIEVAL_CHANNEL_LEARNED_SPARSE,
  RETRIEVAL_CHANNEL_RELATIVE_FILTER,
  RETRIEVAL_CHANNEL_SPARSE_BM25,
  type RetrievalChannel,
} from '../model/retrieval-channel.js';
import type { QueryClass as DomainQueryClass } from '../../shared/types/query-class.js';
import { RRF_DEFAULT_K, RRF_K } from '../../shared/utils/rrf.js';

export const LIVE_RETRIEVAL_POLICY_CONFIG_HASH = '1cb62630de449ff5a51c1c80f484871b39f950aeba926b8a08139135ebd72bbf' as const;
export const LIVE_RETRIEVAL_POLICY_VERSION = '2026-05-26-live-policy-v2-1cb62630' as const;

const WEIGHT_NEUTRAL = 1.0;
const WEIGHT_DAMPED = 0.8;
const WEIGHT_HALF = 0.5;
const WEIGHT_BOOST_MILD = 1.5;
const WEIGHT_BOOST_STRONG = 2.0;
const LEARNED_SPARSE_DISABLED = 0.0;

export interface LiveFusionConfig {
  readonly rrfK: number;
  readonly sparseWeight: number;
  readonly denseWeight: number;
  readonly anchorWeight: number;
  readonly learnedSparseWeight: number;
}

export type LiveFusionQueryClass =
  | 'specific_wine'
  | 'entity_exact'
  | 'browse'
  | 'compare'
  | 'pairing'
  | 'fallback';

export const LIVE_FUSION_CONFIGS = {
  fallback: {
    rrfK: RRF_DEFAULT_K,
    sparseWeight: WEIGHT_NEUTRAL,
    denseWeight: WEIGHT_NEUTRAL,
    anchorWeight: WEIGHT_NEUTRAL,
    learnedSparseWeight: LEARNED_SPARSE_DISABLED,
  },
  specific_wine: {
    rrfK: RRF_K.TIGHT,
    sparseWeight: WEIGHT_BOOST_STRONG,
    denseWeight: WEIGHT_HALF,
    anchorWeight: WEIGHT_BOOST_MILD,
    learnedSparseWeight: LEARNED_SPARSE_DISABLED,
  },
  entity_exact: {
    rrfK: RRF_K.ENTITY_EXACT,
    sparseWeight: WEIGHT_BOOST_MILD,
    denseWeight: WEIGHT_HALF,
    anchorWeight: WEIGHT_BOOST_STRONG,
    learnedSparseWeight: LEARNED_SPARSE_DISABLED,
  },
  browse: {
    rrfK: RRF_DEFAULT_K,
    sparseWeight: WEIGHT_NEUTRAL,
    denseWeight: WEIGHT_BOOST_MILD,
    anchorWeight: WEIGHT_NEUTRAL,
    learnedSparseWeight: LEARNED_SPARSE_DISABLED,
  },
  compare: {
    rrfK: RRF_K.COMPARE,
    sparseWeight: WEIGHT_BOOST_MILD,
    denseWeight: WEIGHT_NEUTRAL,
    anchorWeight: WEIGHT_BOOST_STRONG,
    learnedSparseWeight: LEARNED_SPARSE_DISABLED,
  },
  pairing: {
    rrfK: RRF_K.LOOSE,
    sparseWeight: WEIGHT_DAMPED,
    denseWeight: WEIGHT_BOOST_STRONG,
    anchorWeight: WEIGHT_HALF,
    learnedSparseWeight: LEARNED_SPARSE_DISABLED,
  },
} as const satisfies Record<LiveFusionQueryClass, LiveFusionConfig>;

export interface LiveRetrievalProfileDefinition {
  readonly channelMix: readonly RetrievalChannel[];
  readonly sparseWeight: number;
  readonly denseWeight: number;
  readonly anchorWeight: number;
  readonly learnedSparseWeight?: number | undefined;
  readonly sparseTopN: number;
  readonly denseTopN: number;
  readonly fusionK: number;
  readonly finalTopK: number;
}

export type LiveRetrievalProfileName =
  | 'hybrid_default'
  | 'mixed_anchor'
  | 'recommendation_anchor'
  | 'exact_safe_fallback'
  | 'entity_anchor_first'
  | 'browse_default'
  | 'region_browse'
  | 'compare_default'
  | 'learned_sparse_hybrid'
  | 'relative_filter';

export const LIVE_RETRIEVAL_PROFILE_DEFINITIONS = {
  hybrid_default: {
    channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC],
    sparseWeight: 0.5,
    denseWeight: 0.5,
    anchorWeight: 0,
    sparseTopN: 100,
    denseTopN: 100,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 200,
  },
  mixed_anchor: {
    channelMix: [
      RETRIEVAL_CHANNEL_SPARSE_BM25,
      RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
      RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
    ],
    sparseWeight: 0.3,
    denseWeight: 0.3,
    anchorWeight: 0.4,
    sparseTopN: 80,
    denseTopN: 80,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 200,
  },
  recommendation_anchor: {
    channelMix: [
      RETRIEVAL_CHANNEL_SPARSE_BM25,
      RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
      RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
    ],
    sparseWeight: 0.3,
    denseWeight: 0.3,
    anchorWeight: 0.4,
    sparseTopN: 48,
    denseTopN: 48,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 120,
  },
  exact_safe_fallback: {
    channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC],
    sparseWeight: 0.7,
    denseWeight: 0.3,
    anchorWeight: 0,
    sparseTopN: 150,
    denseTopN: 50,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 100,
  },
  entity_anchor_first: {
    channelMix: [
      RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
      RETRIEVAL_CHANNEL_SPARSE_BM25,
      RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
    ],
    sparseWeight: 0.3,
    denseWeight: 0.1,
    anchorWeight: 0.6,
    sparseTopN: 50,
    denseTopN: 30,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 50,
  },
  browse_default: {
    channelMix: [
      RETRIEVAL_CHANNEL_SPARSE_BM25,
      RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
      RETRIEVAL_CHANNEL_BROWSE_PRODUCER,
    ],
    sparseWeight: 0.65,
    denseWeight: 0.35,
    anchorWeight: 0,
    sparseTopN: 120,
    denseTopN: 80,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 150,
  },
  region_browse: {
    channelMix: [
      RETRIEVAL_CHANNEL_SPARSE_BM25,
      RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
      RETRIEVAL_CHANNEL_BROWSE_REGION,
    ],
    sparseWeight: 0.65,
    denseWeight: 0.35,
    anchorWeight: 0,
    sparseTopN: 120,
    denseTopN: 80,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 150,
  },
  compare_default: {
    channelMix: [
      RETRIEVAL_CHANNEL_SPARSE_BM25,
      RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
      RETRIEVAL_CHANNEL_COMPARE_ANCHOR,
    ],
    sparseWeight: 0.3,
    denseWeight: 0.5,
    anchorWeight: 0.2,
    sparseTopN: 60,
    denseTopN: 100,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 80,
  },
  learned_sparse_hybrid: {
    channelMix: [
      RETRIEVAL_CHANNEL_SPARSE_BM25,
      RETRIEVAL_CHANNEL_LEARNED_SPARSE,
      RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
    ],
    sparseWeight: 0.35,
    denseWeight: 0.45,
    anchorWeight: 0,
    learnedSparseWeight: 0.2,
    sparseTopN: 100,
    denseTopN: 100,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 200,
  },
  relative_filter: {
    channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_RELATIVE_FILTER],
    sparseWeight: 1.0,
    denseWeight: 0,
    anchorWeight: 0,
    sparseTopN: 150,
    denseTopN: 0,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 80,
  },
} as const satisfies Record<LiveRetrievalProfileName, LiveRetrievalProfileDefinition>;

export const LIVE_QUERY_FAMILY_POLICY = {
  comparison: {
    profileName: 'compare_default',
    reason: 'comparison family -> compare_anchor channel for side-by-side candidates',
  },
  recommendation: {
    profileName: 'recommendation_anchor',
    reason: 'recommendation family -> recommendation_anchor profile for broader neighborhood retrieval',
  },
  reference_similarity: {
    profileName: 'mixed_anchor',
    reason: 'reference_similarity family -> mixed_anchor profile (anchor-conditioned similarity neighborhood)',
  },
  pairing: {
    profileName: 'mixed_anchor',
    reason: 'pairing family -> anchor_similarity channel anchored on food entity',
  },
  multi_intent: {
    profileName: 'hybrid_default',
    reason: 'multi_intent family -> full hybrid for broadest intent coverage',
  },
  attribute_constrained: {
    profileName: 'hybrid_default',
    reason: 'attribute_constrained family -> hybrid for term plus semantic coverage',
  },
  entity_resolution: {
    profileName: 'hybrid_default',
    reason: 'entity_resolution family -> hybrid to handle fuzzy entity matching',
  },
  entity_fuzzy: {
    profileName: 'hybrid_default',
    reason: 'entity_fuzzy family -> hybrid for spelling variation tolerance',
  },
  entity_exact: {
    profileName: 'exact_safe_fallback',
    reason: 'entity_exact family -> exact_safe_fallback for precision-first retrieval',
  },
  producer_browse: {
    profileName: 'browse_default',
    reason: 'producer_browse family -> browse_default for producer-name retrieval',
  },
  region_browse: {
    profileName: 'region_browse',
    reason: 'region_browse family -> region_browse profile for region-name retrieval',
  },
  no_match: {
    profileName: 'hybrid_default',
    reason: 'no_match family -> hybrid default safe fallback',
  },
  ambiguous: {
    profileName: 'hybrid_default',
    reason: 'ambiguous family -> hybrid default for maximum recall',
  },
  unknown: {
    profileName: 'hybrid_default',
    reason: 'unknown family -> hybrid default catch-all',
  },
} as const satisfies Record<
  QueryFamilyLabel,
  { readonly profileName: LiveRetrievalProfileName; readonly reason: string }
>;

const LIVE_RETRIEVAL_MODE_PROFILE_NAMES = {
  entity_anchor_first: 'entity_anchor_first',
  entity_lookup: 'exact_safe_fallback',
  entity_resolution: 'exact_safe_fallback',
  attribute_search: 'hybrid_default',
  constraint_filter: 'hybrid_default',
  producer_browse: 'browse_default',
  region_browse: 'region_browse',
  compare_candidates: 'compare_default',
  relative: 'relative_filter',
  recommendation: 'recommendation_anchor',
  similar_items: 'mixed_anchor',
  no_match_detection: 'hybrid_default',
} as const satisfies Record<string, LiveRetrievalProfileName>;

const LEGACY_HEURISTIC_RETRIEVAL_MODE_ALIASES = [
  'semantic_hybrid',
  'hybrid_search',
] as const;

export function getLiveFusionConfig(queryClass: string): LiveFusionConfig {
  return queryClass in LIVE_FUSION_CONFIGS
    ? LIVE_FUSION_CONFIGS[queryClass as LiveFusionQueryClass]
    : LIVE_FUSION_CONFIGS.fallback;
}

export function mapDomainQueryClassToLiveFusionQueryClass(
  qc: DomainQueryClass,
  runtimeMode?: string,
): LiveFusionQueryClass {
  if (runtimeMode === 'entity_anchor_first') {
    return 'entity_exact';
  }
  switch (qc) {
    case 'exact_entity':
    case 'short_entity':
    case 'ambiguous_short_form':
    case 'anchored_similarity':
      return 'specific_wine';
    case 'pure_constraint':
    case 'semantic_preference':
      return 'browse';
    case 'comparison_query':
      return 'compare';
    case 'unknown':
    default:
      return 'fallback';
  }
}

export function getLiveRetrievalProfileDefinition(
  profileName: LiveRetrievalProfileName,
): LiveRetrievalProfileDefinition {
  return LIVE_RETRIEVAL_PROFILE_DEFINITIONS[profileName];
}

export function resolveLiveQueryFamilyPolicy(
  queryFamily: QueryFamilyLabel,
): {
  readonly profileName: LiveRetrievalProfileName;
  readonly reason: string;
} {
  return LIVE_QUERY_FAMILY_POLICY[queryFamily];
}

export function resolveLiveProfileNameForRetrievalMode(
  retrievalMode: string,
): LiveRetrievalProfileName | undefined {
  return LIVE_RETRIEVAL_MODE_PROFILE_NAMES[
    retrievalMode as keyof typeof LIVE_RETRIEVAL_MODE_PROFILE_NAMES
  ];
}

export function isLegacyHeuristicRetrievalModeAlias(
  retrievalMode: string,
): boolean {
  return (LEGACY_HEURISTIC_RETRIEVAL_MODE_ALIASES as readonly string[]).includes(retrievalMode);
}

export function resolveFallbackLiveProfileName(
  queryClass: DomainQueryClass,
  route: string,
): LiveRetrievalProfileName {
  if (queryClass === 'semantic_preference') {
    return 'learned_sparse_hybrid';
  }
  if (route === 'mixed') {
    return 'mixed_anchor';
  }
  if (
    queryClass === 'exact_entity'
    || queryClass === 'short_entity'
    || queryClass === 'ambiguous_short_form'
  ) {
    return 'exact_safe_fallback';
  }
  return 'hybrid_default';
}
