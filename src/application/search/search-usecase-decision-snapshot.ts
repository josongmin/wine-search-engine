import { isDeepStrictEqual } from 'node:util';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { SnapshotVersions } from './search.usecase.js';

const DEFAULT_POLICY_RULE_VERSION = '1.0.0';
const DEFAULT_THRESHOLD_PROFILE_ID = 'default';
const DEFAULT_PLANNER_VERSION = '1.0.0';

export interface ComparableDecisionSnapshot {
  readonly model_versions: DecisionSnapshot['model_versions'];
  readonly index_versions: DecisionSnapshot['index_versions'];
  readonly policy_rule_version: DecisionSnapshot['policy_rule_version'];
  readonly threshold_profile_id: DecisionSnapshot['threshold_profile_id'];
  readonly planner_version: DecisionSnapshot['planner_version'];
  readonly feature_flags: DecisionSnapshot['feature_flags'];
}

/**
 * Canonical runtime decision snapshot builder for replay and other non-plan
 * contexts where the fixed version metadata comes from injected runtime support.
 */
export function buildDecisionSnapshotFromRuntimeVersions(
  versions?: SnapshotVersions,
): DecisionSnapshot {
  return {
    model_versions: versions?.modelVersions ?? {},
    index_versions: versions?.indexVersions ?? {},
    policy_rule_version: DEFAULT_POLICY_RULE_VERSION,
    threshold_profile_id: DEFAULT_THRESHOLD_PROFILE_ID,
    planner_version: DEFAULT_PLANNER_VERSION,
    feature_flags: versions?.featureFlags ?? {},
  };
}

export function toComparableDecisionSnapshot(
  snapshot: DecisionSnapshot,
): ComparableDecisionSnapshot {
  return {
    model_versions: snapshot.model_versions,
    index_versions: snapshot.index_versions,
    policy_rule_version: snapshot.policy_rule_version,
    threshold_profile_id: snapshot.threshold_profile_id,
    planner_version: snapshot.planner_version,
    feature_flags: snapshot.feature_flags,
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
  return response.meta.decisionSnapshot ?? response.engineDecision.decisionSnapshot;
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

  return {
    ...runtimeSnapshot,
    policy_rule_version: plan.policyRuleVersion,
    threshold_profile_id: plan.thresholdProfileId,
    planner_version: plan.plannerVersion,
    ...(hasInconsistency && nondeterminismNote !== undefined
      ? { nondeterminism_notes: nondeterminismNote }
      : {}),
  };
}
