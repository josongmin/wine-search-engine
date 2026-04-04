import type { EntityId } from '../../shared/types/index.js';
import type { LineageRecord } from '../model/lineage-record.js';

/**
 * Port for persisting and querying lineage records (RFC-002 §9.1).
 *
 * Lineage records are append-only. Implementations must guarantee that
 * once a record is saved it is never mutated or deleted.
 */
export interface LineageStore {
  /**
   * Persists a lineage record.
   *
   * @param record - The lineage record to store.
   */
  save(record: LineageRecord): Promise<void>;

  /**
   * Retrieves all lineage records associated with a source record.
   *
   * @param sourceRecordId - The source record identifier.
   * @returns All lineage records for the given source record, ordered by timestamp.
   */
  findBySourceRecord(sourceRecordId: string): Promise<readonly LineageRecord[]>;

  /**
   * Retrieves all lineage records that reference the given entity.
   *
   * @param entityId - The entity identifier.
   * @returns All lineage records for the given entity, ordered by timestamp.
   */
  findByEntity(entityId: EntityId): Promise<readonly LineageRecord[]>;
}
