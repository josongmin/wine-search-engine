import type { Entity } from '../model/entity.js';

/**
 * Aliases grouped by quality tier for retrieval purposes.
 */
export interface AliasSet {
  /** High-confidence aliases safe for identity matching. */
  readonly identitySafe: readonly string[];
  /** Lower-confidence aliases that increase recall but may be noisy. */
  readonly noisyRecall: readonly string[];
}

/**
 * Input shape for creating a retrieval document projection (RFC-012).
 * This is the domain-side representation before it is persisted or indexed.
 */
export interface RetrievalDocumentInput {
  /** The entity's unique identifier. */
  readonly entityId: string;
  /** The entity type. */
  readonly entityType: string;
  /** Primary canonical label. */
  readonly canonicalLabel: string;
  /** Identity-safe aliases for exact matching. */
  readonly identitySafeAliases: readonly string[];
  /** Noisy recall aliases for broad matching. */
  readonly noisyRecallAliases: readonly string[];
  /** Concatenated text blob suitable for embedding or full-text search. */
  readonly searchableText: string;
  /** Structured facets for filtering. */
  readonly facets: RetrievalFacets;
}

/**
 * Facets extracted from entity attributes for structured filtering.
 */
export interface RetrievalFacets {
  readonly type: string;
  readonly style?: string;
  readonly region?: string;
  readonly priceBand?: string;
  readonly grapes?: readonly string[];
  readonly vintage?: number;
  readonly body?: number;
  readonly sweetness?: number;
}

/**
 * Builds a retrieval document projection from an Entity and its aliases.
 *
 * The projection flattens the entity's structured data into a shape suitable
 * for indexing in a search/retrieval system, per RFC-012 RetrievalDocument schema.
 *
 * @param entity - The source entity.
 * @param aliases - Identity-safe and noisy-recall alias sets.
 * @returns A RetrievalDocumentInput ready for indexing.
 */
export function buildProjection(entity: Entity, aliases: AliasSet): RetrievalDocumentInput {
  const searchableParts: string[] = [
    entity.canonicalLabel,
    ...aliases.identitySafe,
    ...aliases.noisyRecall,
  ];

  if (entity.attributes.style) {
    searchableParts.push(entity.attributes.style);
  }
  if (entity.attributes.region) {
    searchableParts.push(entity.attributes.region);
  }
  if (entity.attributes.grapes != null && entity.attributes.grapes.length > 0) {
    searchableParts.push(...entity.attributes.grapes);
  }
  if (entity.attributes.pairing != null && entity.attributes.pairing.length > 0) {
    searchableParts.push(...entity.attributes.pairing);
  }
  if (entity.attributes.occasion != null && entity.attributes.occasion.length > 0) {
    searchableParts.push(...entity.attributes.occasion);
  }
  if (entity.attributes.vintage != null) {
    searchableParts.push(String(entity.attributes.vintage));
  }

  return {
    entityId: entity.id,
    entityType: entity.type,
    canonicalLabel: entity.canonicalLabel,
    identitySafeAliases: aliases.identitySafe,
    noisyRecallAliases: aliases.noisyRecall,
    searchableText: searchableParts.join(' '),
    facets: buildFacets(entity),
  };
}

/**
 * Builds facets from entity attributes, only including defined properties
 * to satisfy `exactOptionalPropertyTypes`.
 */
function buildFacets(entity: Entity): RetrievalFacets {
  const attrs = entity.attributes;
  return {
    type: entity.type,
    ...(attrs.style !== undefined ? { style: attrs.style } : {}),
    ...(attrs.region !== undefined ? { region: attrs.region } : {}),
    ...(attrs.priceBand !== undefined ? { priceBand: attrs.priceBand } : {}),
    ...(attrs.grapes !== undefined ? { grapes: attrs.grapes } : {}),
    ...(attrs.vintage !== undefined ? { vintage: attrs.vintage } : {}),
    ...(attrs.body !== undefined ? { body: attrs.body } : {}),
    ...(attrs.sweetness !== undefined ? { sweetness: attrs.sweetness } : {}),
  };
}
