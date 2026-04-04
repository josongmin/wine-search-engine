import type { EntityId } from '../../shared/types/index.js';
import type { Alias, AliasScope } from '../model/alias.js';

/**
 * Repository port for alias persistence.
 * Implementations may be backed by a relational DB, search index, or in-memory store.
 */
export interface AliasRepository {
  /**
   * Finds all active aliases whose raw value matches exactly.
   * Optionally filtered by scope.
   *
   * @param value - The exact surface-form value to search for.
   * @param scope - Optional scope filter.
   * @returns Matching aliases, ordered by confidencePrior descending.
   */
  findByValue(value: string, scope?: AliasScope): Promise<readonly Alias[]>;

  /**
   * Finds all aliases associated with a given entity.
   *
   * @param entityId - The entity whose aliases to retrieve.
   * @returns All aliases for the entity, including suppressed ones.
   */
  findByEntity(entityId: EntityId): Promise<readonly Alias[]>;

  /**
   * Finds all active aliases matching a pre-normalized value.
   * Used for normalized and fuzzy matching pipelines.
   *
   * @param normalized - The normalized surface form.
   * @returns Matching aliases, ordered by confidencePrior descending.
   */
  findByNormalizedValue(normalized: string): Promise<readonly Alias[]>;

  /**
   * Persists a single alias.
   * If an alias with the same aliasId exists, it is replaced.
   *
   * @param alias - The alias to save.
   */
  save(alias: Alias): Promise<void>;

  /**
   * Soft-deletes an alias by marking it as suppressed.
   *
   * @param aliasId - The alias to suppress.
   * @param reason - Human-readable reason for suppression.
   */
  suppress(aliasId: string, reason: string): Promise<void>;

  /**
   * Persists multiple aliases in a single batch operation.
   *
   * @param aliases - The aliases to save.
   */
  bulkSave(aliases: readonly Alias[]): Promise<void>;
}
