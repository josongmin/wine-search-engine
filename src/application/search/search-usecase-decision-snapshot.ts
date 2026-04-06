import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { SnapshotVersions } from './search.usecase.js';

const DEFAULT_POLICY_RULE_VERSION = '1.0.0';
const DEFAULT_THRESHOLD_PROFILE_ID = 'default';
const DEFAULT_PLANNER_VERSION = '1.0.0';

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
