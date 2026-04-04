import type { Pool } from 'pg';
import type { SnapshotStore } from '../../domain/decision/port/snapshot-store.port.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';

interface DecisionSnapshotRow {
  snapshot_id: string;
  snapshot_data: unknown;
  created_at: Date;
}

// The SnapshotStore port's save() takes only a DecisionSnapshot (no id field).
// We need a stable key. We derive it from threshold_profile_id + planner_version
// + a timestamp suffix stored within the data itself. However the port's get()
// requires a snapshotId. The caller must supply an id — we wrap the snapshot
// in an envelope that carries the id.

interface SnapshotEnvelope {
  snapshotId: string;
  snapshot: DecisionSnapshot;
}

export class PgSnapshotStore implements SnapshotStore {
  constructor(private readonly pool: Pool) {}

  async save(snapshot: DecisionSnapshot): Promise<void> {
    // Generate a deterministic-ish id from profile + planner + timestamp
    const snapshotId = [
      snapshot.threshold_profile_id,
      snapshot.planner_version,
      snapshot.policy_rule_version,
      Date.now().toString(36),
    ].join(':');

    const envelope: SnapshotEnvelope = { snapshotId, snapshot };

    await this.pool.query(
      `INSERT INTO decision_snapshots (snapshot_id, snapshot_data)
       VALUES ($1, $2)
       ON CONFLICT (snapshot_id) DO UPDATE SET snapshot_data = EXCLUDED.snapshot_data`,
      [snapshotId, JSON.stringify(envelope)],
    );
  }

  async get(snapshotId: string): Promise<DecisionSnapshot | null> {
    const result = await this.pool.query<DecisionSnapshotRow>(
      `SELECT * FROM decision_snapshots WHERE snapshot_id = $1`,
      [snapshotId],
    );
    const row = result.rows[0];
    if (row == null) return null;

    const data = row.snapshot_data as SnapshotEnvelope | DecisionSnapshot;
    // Handle both envelope format and raw snapshot format
    if ('snapshot' in data && data.snapshot != null) {
      return data.snapshot;
    }
    return data as DecisionSnapshot;
  }
}
