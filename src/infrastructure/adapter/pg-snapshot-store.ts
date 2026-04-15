import { SNAPSHOT_ID_SCHEMA_VERSION } from '../../domain/decision/model/id-schema-version.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import { canonicalJsonStringify } from '../../domain/shared/utils/canonical-json.js';
import { deterministicHash } from '../../domain/shared/utils/hash.js';
import type { SnapshotVersionContractV2 } from '../../application/search/snapshot-version-contract.js';

const SNAPSHOT_ID_SCHEMA_VERSION_V2 = 'v2';

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
