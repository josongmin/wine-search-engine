import { isDeepStrictEqual } from 'node:util';
import { SNAPSHOT_ID_SCHEMA_VERSION } from '../../domain/decision/model/id-schema-version.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import { canonicalJsonStringify } from '../../domain/shared/utils/canonical-json.js';
import { deterministicHash } from '../../domain/shared/utils/hash.js';
import type { SnapshotVersions } from './search.usecase.js';
import type { SnapshotVersionContractV2 } from './snapshot-version-contract.js';

const DEFAULT_POLICY_RULE_VERSION = '1.0.0';
const DEFAULT_THRESHOLD_PROFILE_ID = 'default';
const DEFAULT_PLANNER_VERSION = '1.0.0';
export const SEARCH_RESPONSE_CONTRACT_VERSION = 'search_response_v1';

export function buildDecisionSnapshotId(snapshot: {
  readonly threshold_profile_id: string;
  readonly planner_version: string;
  readonly policy_rule_version: string;
  readonly model_versions?: DecisionSnapshot['model_versions'];
  readonly index_versions: DecisionSnapshot['index_versions'];
  readonly feature_flags: DecisionSnapshot['feature_flags'];
  readonly response_contract_version: DecisionSnapshot['response_contract_version'];
  readonly nondeterminism_notes?: DecisionSnapshot['nondeterminism_notes'];
}): string {
  const canonical = canonicalJsonStringify({
    ...(snapshot.model_versions !== undefined ? { model_versions: snapshot.model_versions } : {}),
    index_versions: snapshot.index_versions,
    policy_rule_version: snapshot.policy_rule_version,
    threshold_profile_id: snapshot.threshold_profile_id,
    planner_version: snapshot.planner_version,
    feature_flags: snapshot.feature_flags,
    response_contract_version: snapshot.response_contract_version,
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

export interface ComparableDecisionSnapshot {
  readonly snapshot_id: DecisionSnapshot['snapshot_id'];
  readonly model_versions: DecisionSnapshot['model_versions'];
  readonly index_versions: DecisionSnapshot['index_versions'];
  readonly policy_rule_version: DecisionSnapshot['policy_rule_version'];
  readonly threshold_profile_id: DecisionSnapshot['threshold_profile_id'];
  readonly planner_version: DecisionSnapshot['planner_version'];
  readonly feature_flags: DecisionSnapshot['feature_flags'];
  readonly response_contract_version: DecisionSnapshot['response_contract_version'];
}

/**
 * Canonical runtime decision snapshot builder for replay and other non-plan
 * contexts where the fixed version metadata comes from injected runtime support.
 */
export function buildDecisionSnapshotFromRuntimeVersions(
  versions?: SnapshotVersions,
): DecisionSnapshot {
  const snapshotBase = {
    model_versions: versions?.modelVersions ?? {},
    index_versions: versions?.indexVersions ?? {},
    policy_rule_version: DEFAULT_POLICY_RULE_VERSION,
    threshold_profile_id: DEFAULT_THRESHOLD_PROFILE_ID,
    planner_version: DEFAULT_PLANNER_VERSION,
    feature_flags: versions?.featureFlags ?? {},
    response_contract_version: SEARCH_RESPONSE_CONTRACT_VERSION,
  };
  return {
    snapshot_id: buildDecisionSnapshotId(snapshotBase),
    ...snapshotBase,
  };
}

export function toComparableDecisionSnapshot(
  snapshot: DecisionSnapshot,
): ComparableDecisionSnapshot {
  return {
    snapshot_id: snapshot.snapshot_id,
    model_versions: snapshot.model_versions,
    index_versions: snapshot.index_versions,
    policy_rule_version: snapshot.policy_rule_version,
    threshold_profile_id: snapshot.threshold_profile_id,
    planner_version: snapshot.planner_version,
    feature_flags: snapshot.feature_flags,
    response_contract_version: snapshot.response_contract_version,
  };
}

export function decisionSnapshotsMatch(
  expected: DecisionSnapshot,
  actual: DecisionSnapshot,
): boolean {
  return isDeepStrictEqual(
    toComparableDecisionSnapshot(expected),
    toComparableDecisionSnapshot(actual),
  );
}

export function readDecisionSnapshotFromSearchResponse(
  response: SearchResponseV1,
): DecisionSnapshot {
  const snapshot = response.meta.decisionSnapshot ?? response.engineDecision.decisionSnapshot;
  // Runtime guard: both locations can be undefined when consuming older or
  // partially-serialized responses. Fail explicitly instead of propagating
  // undefined through a non-optional return type.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive runtime guard
  if (snapshot == null) {
    throw new Error('DecisionSnapshot missing from both meta and engineDecision');
  }
  return snapshot;
}

/**
 * E1-U6: Project CompiledWineQuery execution fields → SnapshotVersionContractV2.
 *
 * Field mapping (compiled → snapshot vocabulary):
 *   compiled.query.plannerVersion       → plannerVersion
 *   compiled.query.policyRuleVersion    → policyRuleVersion
 *   compiled.query.thresholdProfileId   → thresholdProfileId
 *   compiled.execution.effectiveRoute   → executionRoute
 *   compiled.execution.effectiveRetrievalMode → retrievalMode
 *
 * This is the authoritative projection spec for cache-key enrichment and
 * observability consumers that need route/mode in the snapshot contract.
 *
 * Activation guide (separate epic):
 *   1. Call this function in buildDecisionSnapshotFromPlan when compiled is available
 *   2. Pass result to buildDeterministicSnapshotIdV2 for enriched cache keys
 *   3. Update PgSnapshotStore.save() to persist V2 contract fields
 *   4. Update cache-service.ts QueryCacheKeyBuilder to include route/mode in key
 */
export function buildSnapshotVersionContractV2FromCompiled(
  compiled: CompiledWineQuery,
): SnapshotVersionContractV2 {
  return {
    plannerVersion: compiled.query.plannerVersion,
    policyRuleVersion: compiled.query.policyRuleVersion,
    thresholdProfileId: compiled.query.thresholdProfileId,
    executionRoute: compiled.execution.effectiveRoute,
    retrievalMode: compiled.execution.effectiveRetrievalMode,
  };
}

/**
 * RFC-015 snapshot from plan + optional injected version maps.
 */
export function buildDecisionSnapshotFromPlan(
  plan: QueryPlanV1,
  versions?: SnapshotVersions,
): DecisionSnapshot {
  const runtimeSnapshot = buildDecisionSnapshotFromRuntimeVersions(versions);

  const versionsAbsent = versions === undefined;
  const bothEmpty =
    Object.keys(runtimeSnapshot.model_versions).length === 0 &&
    Object.keys(runtimeSnapshot.index_versions).length === 0;

  const hasInconsistency = versionsAbsent || bothEmpty;
  const nondeterminismNote = versionsAbsent
    ? 'snapshotVersions not injected; model_versions and index_versions are empty — snapshot reproducibility cannot be guaranteed'
    : bothEmpty
      ? 'snapshotVersions injected but both modelVersions and indexVersions are empty — snapshot reproducibility cannot be guaranteed'
      : undefined;

  const snapshotBase = {
    ...runtimeSnapshot,
    policy_rule_version: plan.policyRuleVersion,
    threshold_profile_id: plan.thresholdProfileId,
    planner_version: plan.plannerVersion,
    ...(hasInconsistency && nondeterminismNote !== undefined
      ? { nondeterminism_notes: nondeterminismNote }
      : {}),
  };

  return {
    ...snapshotBase,
    snapshot_id: buildDecisionSnapshotId(snapshotBase),
  };
}
