import { type z } from 'zod';
import type { DecisionSnapshot } from '../../../domain/shared/types/index.js';
import type { ReplayRequest } from '../../../application/search/replay-request.dto.js';
import type {
  SearchOptions,
  SearchQueryBudget,
  SearchRequestContext,
  SearchRequest,
  SearchSessionContext,
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
  type LookupRequestSchema,
  type ReplayRequestSchema,
  type ResolveRequestSchema,
  type SearchRequestSchema,
} from '../schemas/search-request.schema.js';

interface NormalizedRequestAliases {
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
}

function extractNormalizedAliases(body: unknown): NormalizedRequestAliases {
  const candidate = body as Partial<NormalizedRequestAliases>;
  return {
    ...(candidate.context !== undefined ? { context: candidate.context } : {}),
    ...(candidate.sessionContext !== undefined
      ? { sessionContext: candidate.sessionContext }
      : {}),
    ...(candidate.queryBudget !== undefined ? { queryBudget: candidate.queryBudget } : {}),
  };
}

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

/**
 * Maps a lookup request body to a SearchRequest with retrieval_mode forced to
 * 'entity'. The caller cannot override routing — lookup is always entity-only.
 *
 * `options.mode` is intentionally omitted: routing is non-negotiable.
 * `clarification` is always false: lookup callers want a direct answer,
 *   not a "did you mean?" deflection.
 */
export function toLookupRequest(body: z.output<typeof LookupRequestSchema>): SearchRequest {
  const aliases = extractNormalizedAliases(body);
  // Always inject options so clarification:false is honoured even when the
  // caller omits the options object entirely.
  const options: SearchOptions = {
    mode: 'auto',
    explain: body.options?.explain ?? false,
    clarification: false,
  };
  return {
    query: body.query,
    ...aliases,
    options,
    retrieval_mode: 'entity',
  };
}

export function toSearchRequest(body: z.output<typeof SearchRequestSchema>): SearchRequest {
  const options = normalizeSearchOptions(body.options);
  const aliases = extractNormalizedAliases(body);
  return {
    query: body.query,
    ...aliases,
    ...(options !== undefined ? { options } : {}),
    ...(body.retrieval_mode !== undefined ? { retrieval_mode: body.retrieval_mode } : {}),
  };
}

export function toHybridSearchRequest(
  body: z.output<typeof HybridRequestSchema>,
): HybridSearchRequest {
  const options = normalizeHybridOptions(body.options);
  const aliases = extractNormalizedAliases(body);
  return {
    query: body.query,
    ...aliases,
    ...(options !== undefined ? { options } : {}),
  };
}

export function toInterpretRequest(body: z.output<typeof InterpretRequestSchema>): InterpretRequest {
  const aliases = extractNormalizedAliases(body);
  return {
    query: body.query,
    ...aliases,
  };
}

export function toResolveRequest(
  body: z.output<typeof ResolveRequestSchema>,
  requestId: string,
): ResolveRequest {
  const aliases = extractNormalizedAliases(body);
  return {
    query: body.query,
    requestId,
    ...aliases,
  };
}

export function toReplayRequest(body: z.output<typeof ReplayRequestSchema>): ReplayRequest {
  const options = normalizeSearchOptions(body.options);
  const aliases = extractNormalizedAliases(body);
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
    ...aliases,
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
