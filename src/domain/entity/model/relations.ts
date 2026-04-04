import type { EntityId } from '../../shared/types/index.js';

/**
 * Directed relations from one entity to another.
 * Each relation type is optional; the set of valid relations
 * depends on the entity's type.
 */
export interface Relations {
  /** vintage -> producer, wine -> producer */
  readonly producedBy?: EntityId;
  /** vintage -> wine (parent) */
  readonly variantOf?: EntityId;
  /** producer -> region, wine -> region */
  readonly locatedIn?: EntityId;
}
