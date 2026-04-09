import type { Pool } from 'pg';
import type { SnapshotStore } from '../../domain/decision/port/snapshot-store.port.js';
import { SNAPSHOT_ID_SCHEMA_VERSION } from '../../domain/decision/model/id-schema-version.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import { canonicalJsonStringify } from '../../domain/shared/utils/canonical-json.js';
import { deterministicHash } from '../../domain/shared/utils/hash.js';
import type { SnapshotVersionContractV2 } from '../../application/search/snapshot-version-contract.js';

const SNAPSHOT_ID_SCHEMA_VERSION_V2 = 'v2';

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

/**
 * Arguments for {@link buildDeterministicSnapshotIdV2}.
 */
export interface BuildSnapshotIdV2Args {
  readonly snapshot: DecisionSnapshot;
  readonly versionContract: SnapshotVersionContractV2;
}

/**
 * Deterministic id for a V2 snapshot that incorporates {@link SnapshotVersionContractV2}
 * execution fields (executionRoute + retrievalMode) in both the ID prefix and the
 * hash payload.
 *
 * Format:
 *   `snapshot:v2:{threshold_profile_id}:{planner_version}:{policy_rule_version}:{execution_route}:{retrieval_mode}:{hash}`
 */
export function buildDeterministicSnapshotIdV2(args: BuildSnapshotIdV2Args): string {
  const { snapshot, versionContract } = args;
  const canonical = canonicalJsonStringify({
    model_versions: snapshot.model_versions,
    index_versions: snapshot.index_versions,
    policy_rule_version: versionContract.policyRuleVersion,
    threshold_profile_id: versionContract.thresholdProfileId,
    planner_version: versionContract.plannerVersion,
    execution_route: versionContract.executionRoute,
    retrieval_mode: versionContract.retrievalMode,
    feature_flags: snapshot.feature_flags,
    ...(snapshot.nondeterminism_notes !== undefined
      ? { nondeterminism_notes: snapshot.nondeterminism_notes }
      : {}),
  });
  return [
    'snapshot',
    SNAPSHOT_ID_SCHEMA_VERSION_V2,
    versionContract.thresholdProfileId,
    versionContract.plannerVersion,
    versionContract.policyRuleVersion,
    versionContract.executionRoute,
    versionContract.retrievalMode,
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

    return extractSnapshot(row.snapshot_data);
  }
}

/**
 * Decode a snapshot JSONB payload, handling both the modern envelope format
 * `{ snapshotId, snapshot }` and the legacy raw `DecisionSnapshot` format.
 *
 * Returns null on shape mismatch — including partial corruption (missing
 * required fields). The decision pipeline will crash deep inside on a
 * silently-typed garbage snapshot, so we validate aggressively here.
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing after typeof/null/Array checks for Object.values iteration
  for (const v of Object.values(value as Record<string, unknown>)) { // nosemgrep: wine-jsonb-as-cast
    if (typeof v !== 'string') return false;
  }
  return true;
}

function isBoolRecord(value: unknown): value is Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing after typeof/null/Array checks for Object.values iteration
  for (const v of Object.values(value as Record<string, unknown>)) { // nosemgrep: wine-jsonb-as-cast
    if (typeof v !== 'boolean') return false;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  // Reject whitespace-only strings — they pass `.length > 0` but feed garbage
  // into identityHash() and snapshot_id composition, producing format-sensitive
  // hash keys that break string equality across platforms (CRLF vs LF, tab vs space).
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDecisionSnapshot(raw: unknown): raw is DecisionSnapshot {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing after typeof/null/Array checks for property access
  const obj = raw as Record<string, unknown>; // nosemgrep: wine-jsonb-as-cast
  // Required non-empty (and non-whitespace) string fields
  if (!isNonEmptyString(obj['snapshot_id'])) return false;
  if (!isNonEmptyString(obj['policy_rule_version'])) return false;
  if (!isNonEmptyString(obj['threshold_profile_id'])) return false;
  if (!isNonEmptyString(obj['planner_version'])) return false;
  if (!isNonEmptyString(obj['response_contract_version'])) return false;
  // Required Record<string, string> fields — VALUES must also be strings.
  if (!isStringRecord(obj['model_versions'])) return false;
  if (!isStringRecord(obj['index_versions'])) return false;
  // feature_flags is Record<string, boolean>
  if (!isBoolRecord(obj['feature_flags'])) return false;
  return true;
}

function extractSnapshot(raw: unknown): DecisionSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing after typeof/null/Array checks for property access
  const obj = raw as Record<string, unknown>; // nosemgrep: wine-jsonb-as-cast
  // Envelope: { snapshotId, snapshot: DecisionSnapshot }
  if ('snapshotId' in obj && 'snapshot' in obj) {
    const inner = obj['snapshot'];
    if (isValidDecisionSnapshot(inner)) return inner;
    return null;
  }
  // Legacy: raw DecisionSnapshot — must pass full structural validation
  if (isValidDecisionSnapshot(obj)) return obj;
  return null;
}
