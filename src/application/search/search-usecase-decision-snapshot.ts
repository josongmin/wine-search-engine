import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';

/**
 * RFC-015 snapshot from plan + optional injected version maps.
 */
export function buildDecisionSnapshotFromPlan(
  plan: QueryPlanV1,
  versions?: { readonly modelVersions: Readonly<Record<string, string>>; readonly indexVersions: Readonly<Record<string, string>> },
): DecisionSnapshot {
  const modelVersions = versions?.modelVersions ?? {};
  const indexVersions = versions?.indexVersions ?? {};

  const versionsAbsent = versions === undefined;
  const bothEmpty =
    Object.keys(modelVersions).length === 0 && Object.keys(indexVersions).length === 0;

  const hasInconsistency = versionsAbsent || bothEmpty;
  const nondeterminismNote = versionsAbsent
    ? 'snapshotVersions not injected; model_versions and index_versions are empty — snapshot reproducibility cannot be guaranteed'
    : bothEmpty
      ? 'snapshotVersions injected but both modelVersions and indexVersions are empty — snapshot reproducibility cannot be guaranteed'
      : undefined;

  return {
    model_versions: modelVersions,
    index_versions: indexVersions,
    policy_rule_version: plan.policyRuleVersion,
    threshold_profile_id: plan.thresholdProfileId,
    planner_version: plan.plannerVersion,
    feature_flags: {},
    ...(hasInconsistency && nondeterminismNote !== undefined
      ? { nondeterminism_notes: nondeterminismNote }
      : {}),
  };
}
