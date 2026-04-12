import { createEntityId, type CanonicalEntityId } from '../../shared/types/index.js';
import { DomainError } from '../../shared/error/domain-error.js';
import type { EntityType } from './entity-type.js';
import type { Relations } from './relations.js';
import type { EntityAttributes } from './attributes.js';
import { computeIdentitySignature, type SignatureParams } from './identity-signature.js';

/**
 * Thrown when a domain invariant specific to the entity model is violated.
 */
export class EntityInvariantError extends DomainError {
  constructor(message: string) {
    super('ENTITY_INVARIANT', message);
    this.name = 'EntityInvariantError';
  }
}

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

/**
 * Parameters accepted by the {@link createEntity} factory.
 * The factory auto-generates `id`, computes `identitySignature`,
 * and fills in metadata timestamps.
 */
export interface CreateEntityParams {
  readonly type: EntityType;
  readonly canonicalLabel: string;
  readonly relations?: Relations;
  readonly attributes?: EntityAttributes;
  readonly source?: string;
  readonly trustTier?: 'high' | 'medium' | 'low';
  /** Signature params forwarded to computeIdentitySignature. */
  readonly signatureParams: Omit<SignatureParams, 'canonicalLabel'>;
}

/**
 * Validates domain invariants for an entity.
 * @throws {EntityInvariantError} if any invariant is violated.
 */
function validateInvariants(type: EntityType, attributes: EntityAttributes, relations: Relations): void {
  if (type === 'vintage') {
    if (attributes.vintage == null) {
      throw new EntityInvariantError('vintage entity must have a vintage year in attributes');
    }
    if (!relations.variantOf) {
      throw new EntityInvariantError('vintage entity must have a variantOf relation to its parent wine');
    }
  }

  // Validate numeric range invariants (0.0 ~ 1.0)
  const rangeFields = ['body', 'sweetness', 'acidity', 'tannin'] as const;
  for (const field of rangeFields) {
    const value = attributes[field];
    if (value != null && (value < 0 || value > 1)) {
      throw new EntityInvariantError(`${field} must be between 0.0 and 1.0, got ${String(value)}`);
    }
  }
}

/**
 * Factory function that creates a new Entity aggregate root.
 *
 * - Auto-generates a unique {@link EntityId}.
 * - Computes the identity signature from the entity type and signature params.
 * - Validates all domain invariants before returning.
 *
 * @param params - Creation parameters.
 * @returns A fully initialized Entity.
 * @throws {EntityInvariantError} if domain invariants are violated.
 */
export function createEntity(params: CreateEntityParams): Entity {
  const relations: Relations = params.relations ?? {};
  const attributes: EntityAttributes = params.attributes ?? {};

  validateInvariants(params.type, attributes, relations);

  const now = new Date();
  const identitySignature = computeIdentitySignature(params.type, {
    ...params.signatureParams,
    canonicalLabel: params.canonicalLabel,
  });

  const metadata: EntityMetadata = {
    createdAt: now,
    updatedAt: now,
    ...(params.source !== undefined ? { source: params.source } : {}),
    ...(params.trustTier !== undefined ? { trustTier: params.trustTier } : {}),
  };

  return {
    id: createEntityId(),
    type: params.type,
    canonicalLabel: params.canonicalLabel,
    identitySignature,
    relations,
    attributes,
    metadata,
  };
}
