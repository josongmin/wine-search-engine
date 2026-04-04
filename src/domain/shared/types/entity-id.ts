import { nanoid } from 'nanoid';

declare const EntityIdBrand: unique symbol;

/**
 * A branded string type representing a unique entity identifier.
 * Branding prevents accidental use of arbitrary strings as entity IDs.
 */
export type EntityId = string & { readonly [EntityIdBrand]: typeof EntityIdBrand };

/**
 * Creates a new {@link EntityId}, optionally from an existing string value.
 * When no value is provided, a cryptographically random nanoid is generated.
 *
 * @param value - An optional string to use as the entity ID. Must be non-empty if provided.
 * @returns A branded {@link EntityId}.
 * @throws {Error} If an empty string is provided.
 */
export function createEntityId(value?: string): EntityId {
  if (value !== undefined) {
    if (value.length === 0) {
      throw new Error('EntityId cannot be an empty string');
    }
    return value as EntityId;
  }
  return nanoid();
}

/**
 * Type guard that checks whether an unknown value is a valid {@link EntityId}.
 * An EntityId is any non-empty string. This is a runtime check; the brand is
 * erased at runtime and serves only as a compile-time guard.
 *
 * @param value - The value to test.
 * @returns `true` if `value` is a non-empty string suitable for use as an EntityId.
 */
export function isEntityId(value: unknown): value is EntityId {
  return typeof value === 'string' && value.length > 0;
}
