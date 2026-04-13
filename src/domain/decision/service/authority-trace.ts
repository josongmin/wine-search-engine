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
  retrievalMode?: string;
  retrievalKind?: string;
  route?: string;
}): string {
  const digest = deterministicHash({
    queryClass: input.queryPlan.queryClass,
    route: input.route ?? input.queryPlan.route,
    retrievalMode: input.retrievalMode ?? input.queryPlan.retrievalMode,
    retrievalKind: input.retrievalKind ?? '',
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
  retrievalMode?: string;
  retrievalKind?: string;
  route?: string;
}): string {
  const digest = deterministicHash({
    queryClass: input.queryPlan.queryClass,
    route: input.route ?? input.queryPlan.route,
    retrievalMode: input.retrievalMode ?? input.queryPlan.retrievalMode,
    retrievalKind: input.retrievalKind ?? '',
    threshold_profile_id: input.snapshot.threshold_profile_id,
    planner_version: input.snapshot.planner_version,
    policy_rule_version: input.snapshot.policy_rule_version,
    reason: input.reason,
  });

  return `admission:${AUTHORITY_TRACE_SCHEMA_VERSION}:${input.queryPlan.queryClass}:${digest}`;
}

export function buildInternalErrorAuthorityTraceRef(input: {
  snapshot: DecisionSnapshot;
  requestId: string;
  failureReason?: FailureReason | 'INTERNAL_INCONSISTENCY';
}): string {
  const digest = deterministicHash({
    queryClass: 'internal_error',
    route: 'error',
    retrievalMode: 'internal_error',
    threshold_profile_id: input.snapshot.threshold_profile_id,
    planner_version: input.snapshot.planner_version,
    policy_rule_version: input.snapshot.policy_rule_version,
    requestId: input.requestId,
    failureReason: input.failureReason ?? 'INTERNAL_INCONSISTENCY',
  });

  return `decision:${AUTHORITY_TRACE_SCHEMA_VERSION}:internal_error:${digest}`;
}

export function buildComparisonAuthorityTraceRef(input: {
  originalQuery: string;
  comparisonIntent: 'compare' | 'recommend_one' | 'list_both';
  overallStatus: 'resolved' | 'ambiguous' | 'failed';
  leftAuthorityTraceRef: string;
  rightAuthorityTraceRef: string;
}): string {
  const digest = deterministicHash({
    queryClass: 'comparison_query',
    originalQuery: input.originalQuery,
    comparisonIntent: input.comparisonIntent,
    overallStatus: input.overallStatus,
    leftAuthorityTraceRef: input.leftAuthorityTraceRef,
    rightAuthorityTraceRef: input.rightAuthorityTraceRef,
  });

  return `decision:${AUTHORITY_TRACE_SCHEMA_VERSION}:comparison_query:${digest}`;
}
