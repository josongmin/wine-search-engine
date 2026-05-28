import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { Entity } from '../model/entity.js';
import type { EntityType } from '../model/entity-type.js';

/**
 * Read-only repository port for Entity lookups.
 *
 * Runtime plane snapshot-scoped PK migration (mig 016): the runtime write path
 * is collapsed to a single authority — the ETL publisher in
 * `scripts/etl/publish-runtime-substrates.ts`. Mutating methods previously
 * exposed by this port (save/update/delete/createSnapshot/rollbackToSnapshot)
 * were removed because:
 *  1. No production composition root constructed a PgEntityRepository with
 *     write intent (verified by grep).
 *  2. rollbackToSnapshot's row-level semantics contradicts the pointer-based
 *     rollback declared in migration 010.
 *  3. Multiple runtime writers multiply the surface where the append-only
 *     invariant can be broken. Collapse to one authoritative writer is safer.
 *
 * Implementations live in the infrastructure layer.
 */
export interface EntityRepository {
  /**
   * Find an entity by its unique id, scoped to the active snapshot.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   */
  findById(id: CanonicalEntityId, signal?: AbortSignal): Promise<Entity | null>;

  /**
   * Find an entity by its deterministic identity signature, scoped to the active snapshot.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   */
  findBySignature(signature: string, signal?: AbortSignal): Promise<Entity | null>;

  /**
   * Find entities by type within the active snapshot.
   * @param type - The entity type to filter on.
   * @param limit - Maximum number of results (default implementation-defined).
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   */
  findByType(type: EntityType, limit?: number, signal?: AbortSignal): Promise<readonly Entity[]>;
}
