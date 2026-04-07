import { type z } from 'zod';
import type { DecisionSnapshot } from '../../../domain/shared/types/index.js';
import type { ReplayRequest } from '../../../application/search/replay-request.dto.js';
import type {
  SearchOptions,
  SearchRequest,
} from '../../../application/search/search-request.dto.js';
import type {
  HybridSearchOptions,
  HybridSearchRequest,
} from '../../../application/search/hybrid-request.dto.js';
import type { InterpretRequest } from '../../../application/search/interpret-request.dto.js';
import type { ResolveRequest } from '../../../application/search/resolve-request.dto.js';
import {
  type HybridRequestSchema,
  type InterpretRequestSchema,
  type ReplayRequestSchema,
  type ResolveRequestSchema,
  type SearchRequestSchema,
} from '../schemas/search-request.schema.js';

function normalizeSearchOptions(
  options: z.output<typeof SearchRequestSchema>['options'],
): SearchOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  return {
    mode: options.mode,
    explain: options.explain,
    clarification: options.clarification,
  };
}

function normalizeHybridOptions(
  options: z.output<typeof HybridRequestSchema>['options'],
): HybridSearchOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  return {
    explain: options.explain,
    clarification: options.clarification,
  };
}

export function toSearchRequest(body: z.output<typeof SearchRequestSchema>): SearchRequest {
  const options = normalizeSearchOptions(body.options);
  return {
    query: body.query,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(body.retrieval_mode !== undefined ? { retrieval_mode: body.retrieval_mode } : {}),
  };
}

export function toHybridSearchRequest(
  body: z.output<typeof HybridRequestSchema>,
): HybridSearchRequest {
  const options = normalizeHybridOptions(body.options);
  return {
    query: body.query,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
    ...(options !== undefined ? { options } : {}),
  };
}

export function toInterpretRequest(body: z.output<typeof InterpretRequestSchema>): InterpretRequest {
  return {
    query: body.query,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
  };
}

export function toResolveRequest(
  body: z.output<typeof ResolveRequestSchema>,
  requestId: string,
): ResolveRequest {
  return {
    query: body.query,
    requestId,
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.sessionContext !== undefined ? { sessionContext: body.sessionContext } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
  };
}

export function toReplayRequest(body: z.output<typeof ReplayRequestSchema>): ReplayRequest {
  const options = normalizeSearchOptions(body.options);
  const snapshot: DecisionSnapshot = {
    snapshot_id: body.decision_snapshot.snapshot_id,
    model_versions: body.decision_snapshot.model_versions,
    index_versions: body.decision_snapshot.index_versions,
    policy_rule_version: body.decision_snapshot.policy_rule_version,
    threshold_profile_id: body.decision_snapshot.threshold_profile_id,
    planner_version: body.decision_snapshot.planner_version,
    feature_flags: body.decision_snapshot.feature_flags,
    response_contract_version: body.decision_snapshot.response_contract_version,
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
    ...(options !== undefined ? { options } : {}),
    ...(body.expected_response_hash !== undefined
      ? { expected_response_hash: body.expected_response_hash }
      : {}),
    ...(body.preflight_honesty_contract !== undefined
      ? {
          preflight_honesty_contract: {
            execution_mode: body.preflight_honesty_contract.execution_mode,
            degradation_reasons: body.preflight_honesty_contract.degradation_reasons,
            ...(body.preflight_honesty_contract.blocking_eligible !== undefined
              ? { blocking_eligible: body.preflight_honesty_contract.blocking_eligible }
              : {}),
          },
        }
      : {}),
  };
}
