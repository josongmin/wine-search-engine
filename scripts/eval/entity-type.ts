import type { GoldenQuery } from '../etl/types.js';
import type { EntityTargetType, RankedHit } from './metrics.js';

const RETRIEVAL_MODE_TARGET_TYPE_MAP: Partial<Record<NonNullable<GoldenQuery['retrieval_mode']>, EntityTargetType>> = {
  entity_lookup: 'wine',
  entity_resolution: 'wine',
  attribute_search: 'wine',
  constraint_filter: 'wine',
  producer_browse: 'producer',
  region_browse: 'region',
  compare_candidates: 'wine',
  recommendation: 'wine',
  similar_items: 'wine',
  no_match_detection: 'wine',
};

const QUERY_CLASS_TARGET_TYPE_MAP: Partial<Record<GoldenQuery['query_class'], EntityTargetType>> = {
  exact_entity: 'wine',
  ambiguous_short_form: 'wine',
  semantic_preference: 'wine',
  pure_constraint: 'wine',
  exploration: 'wine',
  similar_compare: 'wine',
  catalog_browse: 'wine',
  noisy_recall: 'wine',
  no_match: 'wine',
};

const KNOWN_ENTITY_TYPES: readonly EntityTargetType[] = ['wine', 'producer', 'region', 'unknown'];

export interface QueryTargetTypeSource {
  readonly retrieval_mode?: GoldenQuery['retrieval_mode'];
  readonly query_class: GoldenQuery['query_class'];
  readonly scenario: GoldenQuery['scenario'];
}

export function inferEntityTargetType(query: QueryTargetTypeSource): EntityTargetType {
  const fromMode = query.retrieval_mode
    ? RETRIEVAL_MODE_TARGET_TYPE_MAP[query.retrieval_mode]
    : undefined;
  if (fromMode !== undefined) {
    return fromMode;
  }

  const fromQueryClass = QUERY_CLASS_TARGET_TYPE_MAP[query.query_class];
  if (fromQueryClass !== undefined) {
    return fromQueryClass;
  }

  // Historical fallback for legacy scenario-only datasets.
  if (query.scenario === 'no_match') {
    return 'wine';
  }
  return 'wine';
}

export function inferResolvedEntityType(hit: Pick<RankedHit, 'entity_type'> | undefined): EntityTargetType {
  const entityType = hit?.entity_type;
  if (entityType === undefined) {
    return 'unknown';
  }
  return KNOWN_ENTITY_TYPES.includes(entityType as EntityTargetType)
    ? (entityType as EntityTargetType)
    : 'unknown';
}
