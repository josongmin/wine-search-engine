/** All supported entity types in the identity graph. */
export const ENTITY_TYPES = ['wine', 'vintage', 'producer', 'region', 'grape'] as const;

/** Discriminated union of entity type literals. */
export type EntityType = typeof ENTITY_TYPES[number];

/**
 * Type guard for EntityType.
 * @param value - The string to check.
 */
export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}
