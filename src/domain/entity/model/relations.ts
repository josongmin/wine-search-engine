import type { CanonicalEntityId } from '../../shared/types/index.js';

/**
 * Directed relations from one entity to another.
 * Each relation type is optional; the set of valid relations
 * depends on the entity's type.
 */
export interface Relations {
  /** vintage -> producer, wine -> producer */
  readonly producedBy?: CanonicalEntityId;
  /** vintage -> wine (parent) */
  readonly variantOf?: CanonicalEntityId;
  /** producer -> region, wine -> region */
  readonly locatedIn?: CanonicalEntityId;
}
