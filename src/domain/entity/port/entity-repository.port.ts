import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { Entity } from '../model/entity.js';
import type { EntityType } from '../model/entity-type.js';

/**
 * Repository port for Entity persistence.
 * Implementations live in the infrastructure layer.
 */
export interface EntityRepository {
  /** Find an entity by its unique id. */
  findById(id: CanonicalEntityId): Promise<Entity | null>;

  /** Find an entity by its deterministic identity signature. */
  findBySignature(signature: string): Promise<Entity | null>;

  /**
   * Find entities by type.
   * @param type - The entity type to filter on.
   * @param limit - Maximum number of results (default implementation-defined).
   */
  findByType(type: EntityType, limit?: number): Promise<readonly Entity[]>;

  /** Persist a new entity. */
  save(entity: Entity): Promise<void>;

  /** Update an existing entity. */
  update(entity: Entity): Promise<void>;

  /** Delete an entity by id. */
  delete(id: CanonicalEntityId): Promise<void>;

  /**
   * Create a named snapshot of the current entity store (RFC-001 §4.5).
   * @param label - Human-readable label for the snapshot.
   * @returns The snapshot identifier.
   */
  createSnapshot(label: string): Promise<string>;

  /**
   * Roll back the entity store to a previously created snapshot (RFC-001 §4.5).
   * @param snapshotId - The snapshot to restore.
   */
  rollbackToSnapshot(snapshotId: string): Promise<void>;
}
