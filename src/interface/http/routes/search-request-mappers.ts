import { z } from 'zod';
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
  HybridRequestSchema,
  InterpretRequestSchema,
  ReplayRequestSchema,
  ResolveRequestSchema,
  SearchRequestSchema,
} from '../schemas/search-request.schema.js';

function normalizeSearchOptions(
  options: z.output<typeof SearchRequestSchema>['options']
    | z.output<typeof ReplayRequestSchema>['options'],
): SearchOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  return {
    mode: options.mode ?? 'auto',
    explain: options.explain ?? false,
    clarification: options.clarification ?? true,
  };
}

function normalizeHybridOptions(
  options: z.output<typeof HybridRequestSchema>['options'],
): HybridSearchOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  return {
    explain: options.explain ?? false,
    clarification: options.clarification ?? true,
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
  };
}

export function toReplayRequest(body: z.output<typeof ReplayRequestSchema>): ReplayRequest {
  const options = normalizeSearchOptions(body.options);
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
    ...(options !== undefined ? { options } : {}),
  };
}
