import type { z } from 'zod';
import type {
  WineSearchResponseSchema,
  WineSearchStepBody,
  WineSearchTerminationBody,
  TokenUsageBody,
} from '../schemas/wine-search.schema.js';
import type {
  WineSearchResult as OrchestratorResult,
  TokenUsageShape as OrchestratorTokenUsage,
} from '@app/wine-search/wine-search-orchestrator.js';

export function mapWineSearchResultToResponse(
  result: OrchestratorResult,
  requestId: string,
): z.infer<typeof WineSearchResponseSchema> {
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

function toTokenUsageBody(usage: OrchestratorTokenUsage): TokenUsageBody {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_creation_tokens: usage.cacheCreationTokens,
  };
}
