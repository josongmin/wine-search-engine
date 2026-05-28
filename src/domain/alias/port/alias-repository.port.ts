import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { Alias, AliasScope } from '../model/alias.js';

/**
 * Read-only repository port for alias lookups.
 *
 * Runtime plane snapshot-scoped PK migration (mig 016): the runtime write path
 * is collapsed to a single authority — the ETL publisher in
 * `scripts/etl/publish-runtime-substrates.ts`. Mutating methods (save /
 * suppress / bulkSave) were removed because composite PK (search_snapshot_id,
 * alias_id) broke their single-column `ON CONFLICT (alias_id)` semantics and
 * their INSERT column lists did not include `search_snapshot_id`. Writers that
 * previously produced aliases directly (`scripts/etl/generate-transliteration-aliases.ts`)
 * now emit NDJSON artifacts consumed by the snapshot builder.
 */
export interface AliasRepository {
  /**
   * Finds all active aliases whose raw value matches exactly.
   * Optionally filtered by scope.
   *
   * @param value - The exact surface-form value to search for.
   * @param scope - Optional scope filter.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   * @returns Matching aliases, ordered by confidencePrior descending.
   */
  findByValue(value: string, scope?: AliasScope, signal?: AbortSignal): Promise<readonly Alias[]>;

  /**
   * Finds all aliases associated with a given entity.
   *
   * @param entityId - The entity whose aliases to retrieve.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   * @returns All aliases for the entity, including suppressed ones.
   */
  findByEntity(entityId: CanonicalEntityId, signal?: AbortSignal): Promise<readonly Alias[]>;

  /**
   * Finds all active aliases matching a pre-normalized value.
   * Used for normalized matching pipelines (exact-normalized lookup).
   *
   * @param normalized - The normalized surface form.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   * @returns Matching aliases, ordered by confidencePrior descending.
   */
  findByNormalizedValue(normalized: string, signal?: AbortSignal): Promise<readonly Alias[]>;

  /**
   * Returns a set of candidate aliases for fuzzy matching against the given
   * normalized query prefix. Implementations should retrieve aliases that
   * share at least one significant token or prefix with the query, so the
   * caller can apply edit-distance filtering. The result set trades precision
   * for recall: false positives are expected and filtered by the caller.
   *
   * @param normalized - The normalized query form.
   * @param scope - Optional scope filter.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   * @returns Candidate aliases for edit-distance filtering.
   */
  findFuzzyCandidates(
    normalized: string,
    scope?: AliasScope,
    signal?: AbortSignal,
  ): Promise<readonly Alias[]>;
}
