/**
 * Agent presentation mappers — domain result/session records → wire response
 * shapes. SINGLE source of truth shared by every transport (HTTP routes AND
 * the local CLI facade) so they emit byte-identical responses.
 *
 * Why it lives in `application/.../presentation` (not `interface/http`): the
 * CLI (infrastructure) must not depend on the HTTP interface layer just to
 * shape a response. Mappers here import the wire CONTRACT types from
 * `interface/http/schemas` as TYPE-ONLY (compile-time SSoT, zero runtime
 * coupling), but the runtime module sits in the application layer so both
 * transports point inward, not at each other.
 */

import type {
  WineSearchStepBody,
  WineSearchTerminationBody,
  TokenUsageBody,
  WineSearchResponseBody,
  AgentSessionDescriptorBody,
  AgentSessionTurnDescriptorBody,
  AgentSessionTurnResponseBody,
} from '../wine-search-wire.dto.js';
import type {
  AgentSessionRecord,
  AgentSessionTurn,
} from '../port/agent-session-store.port.js';
import type {
  WineSearchResult as OrchestratorResult,
  TokenUsageShape as OrchestratorTokenUsage,
} from '../wine-search-orchestrator.js';

type WineSearchResponse = WineSearchResponseBody;

function toTokenUsageBody(usage: OrchestratorTokenUsage): TokenUsageBody {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_creation_tokens: usage.cacheCreationTokens,
  };
}

export function mapWineSearchResultToResponse(
  result: OrchestratorResult,
  requestId: string,
): WineSearchResponse {
  const steps: WineSearchStepBody[] = result.executionSteps.map((step) => ({
    index: step.index,
    source: step.source,
    summary: step.summary,
    ...(step.toolCalls !== undefined
      ? {
          tool_calls: step.toolCalls.map((call) => ({
            name: call.name,
            arguments: call.arguments,
          })),
        }
      : {}),
    ...(step.observations !== undefined ? { observations: [...step.observations] } : {}),
    duration_ms: step.durationMs,
    ...(step.tokenUsage !== undefined
      ? { token_usage: toTokenUsageBody(step.tokenUsage) }
      : {}),
  }));

  const termination: WineSearchTerminationBody = {
    reason: result.terminationReason,
    layer: result.layer,
    ...(result.terminationKind !== undefined ? { kind: result.terminationKind } : {}),
    ...(result.degradedReason !== undefined
      ? { degraded_reason: result.degradedReason }
      : {}),
  };

  return {
    query_type: 'wine_search' as const,
    answer: result.answer,
    execution: {
      steps,
      tool_call_count: result.toolCallCount,
    },
    meta: {
      request_id: requestId,
      total_duration_ms: result.totalDurationMs,
      total_tokens: toTokenUsageBody(result.tokenUsage),
      intent: result.intent,
      plan_kind: result.planKind,
      termination,
      policy_blocked: result.policyBlocked,
    },
  };
}

export function buildSessionDescriptor(session: AgentSessionRecord): AgentSessionDescriptorBody {
  return {
    session_id: session.sessionId,
    session_version: session.sessionVersion,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
  };
}

function buildTurnDescriptor(
  turn: AgentSessionTurn,
  replayed: boolean,
): AgentSessionTurnDescriptorBody {
  return {
    turn_index: turn.turnIndex,
    client_turn_id: turn.clientTurnId,
    created_at: turn.createdAt.toISOString(),
    replayed,
  };
}

export function buildTurnResponse(
  response: WineSearchResponseBody,
  session: AgentSessionRecord,
  turn: AgentSessionTurn,
  replayed: boolean,
): AgentSessionTurnResponseBody {
  return {
    ...response,
    session: buildSessionDescriptor(session),
    turn: buildTurnDescriptor(turn, replayed),
    history_applied: [...turn.historyApplied],
  };
}
