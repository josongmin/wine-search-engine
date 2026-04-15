import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { EntityType } from './entity-type.js';
import type { Relations } from './relations.js';
import type { EntityAttributes } from './attributes.js';

/**
 * Metadata attached to every entity for auditing and trust scoring.
 */
export interface EntityMetadata {
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly source?: string;
  readonly trustTier?: 'high' | 'medium' | 'low';
}

/**
 * Entity aggregate root — the core node in the Identity Graph.
 * Immutable value object; mutations produce a new instance.
 */
export interface Entity {
  readonly id: CanonicalEntityId;
  readonly type: EntityType;
  readonly canonicalLabel: string;
  readonly identitySignature: string;
  readonly relations: Relations;
  readonly attributes: EntityAttributes;
  readonly metadata: EntityMetadata;
}
