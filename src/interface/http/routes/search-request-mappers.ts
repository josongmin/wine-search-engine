import type { DecisionSnapshot } from '../../../domain/shared/types/index.js';
import type { ReplayRequest } from '../../../application/search/replay-request.dto.js';
import type { SearchRequest } from '../../../application/search/search-request.dto.js';
import type {
  HybridRequestBody,
  InterpretRequestBody,
  ReplayRequestBody,
  ResolveRequestBody,
  SearchRequestBody,
} from '../schemas/search-request.schema.js';
import type { HybridSearchRequest } from '../../../application/search/hybrid-request.dto.js';
import type { InterpretRequest } from '../../../application/search/interpret-request.dto.js';
import type { ResolveRequest } from '../../../application/search/resolve-request.dto.js';

export function toSearchRequest(body: SearchRequestBody): SearchRequest {
  return {
    query: body.query,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
    ...(body.options !== undefined ? { options: body.options } : {}),
  };
}

export function toHybridSearchRequest(body: HybridRequestBody): HybridSearchRequest {
  return {
    query: body.query,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
    ...(body.options !== undefined ? { options: body.options } : {}),
  };
}

export function toInterpretRequest(body: InterpretRequestBody): InterpretRequest {
  return {
    query: body.query,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
  };
}

export function toResolveRequest(
  body: ResolveRequestBody,
  requestId: string,
): ResolveRequest {
  return {
    query: body.query,
    requestId,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
  };
}

export function toReplayRequest(body: ReplayRequestBody): ReplayRequest {
  const snapshot: DecisionSnapshot = {
    model_versions: body.decision_snapshot.model_versions,
    index_versions: body.decision_snapshot.index_versions,
    policy_rule_version: body.decision_snapshot.policy_rule_version,
    threshold_profile_id: body.decision_snapshot.threshold_profile_id,
    planner_version: body.decision_snapshot.planner_version,
    feature_flags: body.decision_snapshot.feature_flags,
    ...(body.decision_snapshot.nondeterminism_notes !== undefined
      ? { nondeterminism_notes: body.decision_snapshot.nondeterminism_notes }
      : {}),
  };

  return {
    query: body.query,
    decision_snapshot: snapshot,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
    ...(body.options !== undefined ? { options: body.options } : {}),
  };
}
