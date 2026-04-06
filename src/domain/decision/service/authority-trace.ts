import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { DecisionSnapshot } from '../../shared/types/index.js';
import type { FailureReason } from '../model/failure-reason.js';
import { AUTHORITY_TRACE_SCHEMA_VERSION } from '../model/id-schema-version.js';
import { deterministicHash } from '../../shared/utils/hash.js';

export function buildAuthorityTraceRef(input: {
  queryPlan: QueryPlanV1;
  snapshot: DecisionSnapshot;
  chosenEntityId?: string;
  decisionStatus: string;
  nextAction: string;
  failureReason?: FailureReason;
}): string {
  const digest = deterministicHash({
    queryClass: input.queryPlan.queryClass,
    retrievalMode: input.queryPlan.retrievalMode,
    threshold_profile_id: input.snapshot.threshold_profile_id,
    planner_version: input.snapshot.planner_version,
    policy_rule_version: input.snapshot.policy_rule_version,
    chosenEntityId: input.chosenEntityId ?? '',
    decisionStatus: input.decisionStatus,
    nextAction: input.nextAction,
    failureReason: input.failureReason ?? '',
  });

  return `decision:${AUTHORITY_TRACE_SCHEMA_VERSION}:${input.queryPlan.queryClass}:${digest}`;
}

export function buildAdmissionAuthorityTraceRef(input: {
  queryPlan: QueryPlanV1;
  snapshot: DecisionSnapshot;
  reason: FailureReason;
}): string {
  const digest = deterministicHash({
    queryClass: input.queryPlan.queryClass,
    threshold_profile_id: input.snapshot.threshold_profile_id,
    planner_version: input.snapshot.planner_version,
    policy_rule_version: input.snapshot.policy_rule_version,
    reason: input.reason,
  });

  return `admission:${AUTHORITY_TRACE_SCHEMA_VERSION}:${input.queryPlan.queryClass}:${digest}`;
}
