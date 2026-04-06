import type { Pool } from 'pg';
import type { SnapshotStore } from '../../domain/decision/port/snapshot-store.port.js';
import { SNAPSHOT_ID_SCHEMA_VERSION } from '../../domain/decision/model/id-schema-version.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import { canonicalJsonStringify } from '../../domain/shared/utils/canonical-json.js';
import { deterministicHash } from '../../domain/shared/utils/hash.js';

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

/**
 * Deterministic id for a persisted {@link DecisionSnapshot} (SSOT for replay/audit).
 */
export function buildDeterministicSnapshotId(snapshot: DecisionSnapshot): string {
  const canonical = canonicalJsonStringify({
    model_versions: snapshot.model_versions,
    index_versions: snapshot.index_versions,
    policy_rule_version: snapshot.policy_rule_version,
    threshold_profile_id: snapshot.threshold_profile_id,
    planner_version: snapshot.planner_version,
    feature_flags: snapshot.feature_flags,
    ...(snapshot.nondeterminism_notes !== undefined
      ? { nondeterminism_notes: snapshot.nondeterminism_notes }
      : {}),
  });
  return [
    'snapshot',
    SNAPSHOT_ID_SCHEMA_VERSION,
    snapshot.threshold_profile_id,
    snapshot.planner_version,
    snapshot.policy_rule_version,
    deterministicHash(canonical),
  ].join(':');
}

export class PgSnapshotStore implements SnapshotStore {
  constructor(private readonly pool: Pool) {}

  async save(snapshot: DecisionSnapshot): Promise<void> {
    const snapshotId = buildDeterministicSnapshotId(snapshot);

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
    // Envelope rows store { snapshotId, snapshot }; legacy rows are raw DecisionSnapshot.
    if ('snapshotId' in data && 'snapshot' in data) {
      return data.snapshot;
    }
    return data;
  }
}
