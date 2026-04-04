import type { DecisionSnapshot } from '../../shared/types/index.js';

/**
 * Port for persisting and retrieving decision snapshots.
 *
 * A decision snapshot captures the exact system versions and configuration
 * active at the time a decision was made, enabling reproducibility analysis.
 */
export interface SnapshotStore {
  /**
   * Persists a decision snapshot.
   *
   * @param snapshot - The snapshot to save.
   */
  save(snapshot: DecisionSnapshot): Promise<void>;

  /**
   * Retrieves a decision snapshot by its identifier.
   *
   * @param snapshotId - The snapshot identifier.
   * @returns The snapshot, or `null` if not found.
   */
  get(snapshotId: string): Promise<DecisionSnapshot | null>;
}
