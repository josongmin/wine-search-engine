import type { CanonicalEntityId } from '../../shared/types/index.js';

/**
 * An entry in the ambiguity registry tracking unresolved alias conflicts.
 * When a conflict cannot be auto-resolved (margin < threshold), it is
 * registered here so downstream systems can present disambiguation options.
 */
export interface AmbiguityRegistryEntry {
  /** The surface form that maps to multiple entities. */
  readonly surfaceForm: string;
  /** Entity IDs that compete for this surface form. */
  readonly conflictingEntityIds: readonly CanonicalEntityId[];
  /** Classification of the conflict (e.g. 'homonym', 'near_duplicate'). */
  readonly conflictType: string;
  /** When this entry was created. */
  readonly registeredAt: Date;
  /** Whether this ambiguity is still unresolved. */
  readonly active: boolean;
}

/**
 * Creates a new active ambiguity registry entry.
 *
 * @param surfaceForm - The ambiguous surface form.
 * @param conflictingEntityIds - The entities in conflict.
 * @param conflictType - Classification of the conflict.
 * @returns A new AmbiguityRegistryEntry.
 */
export function createAmbiguityEntry(
  surfaceForm: string,
  conflictingEntityIds: readonly CanonicalEntityId[],
  conflictType: string,
): AmbiguityRegistryEntry {
  return {
    surfaceForm,
    conflictingEntityIds,
    conflictType,
    registeredAt: new Date(),
    active: true,
  };
}
