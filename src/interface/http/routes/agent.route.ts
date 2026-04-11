/**
 * POST /v1/agent — Agentic wine search endpoint.
 *
 * Accepts a natural language query and runs a ReAct reasoning loop
 * using existing search tools (search_wines, compare_wines, etc.).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerContractRoute } from './register-contract-route.js';
import { parseContractBody, sendContractResponse } from './contract-response.js';
import { getRequestId } from '../request-id.js';
import type { AgentOrchestrator } from '../../../application/agent/agent-orchestrator.js';
import { ErrorResponseSchema } from '../schemas/search-response.schema.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  MAX_AGENT_HTTP_QUERY_CHARS,
  MAX_AGENT_STEPS_CAP,
  MAX_SESSION_ENTITY_ID_CHARS,
  MAX_SESSION_PREVIOUS_ENTITIES,
} from '../constants.js';

const AgentRequestSchema = z.object({
  query: z.string().min(1).max(MAX_AGENT_HTTP_QUERY_CHARS),
  session_context: z.object({
    session_id: z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS),
    previous_entities: z.array(z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS)).max(MAX_SESSION_PREVIOUS_ENTITIES).optional(),
  }).strict().optional(),
  options: z.object({
    max_steps: z.number().int().min(1).max(MAX_AGENT_STEPS_CAP).optional(),
  }).strict().optional(),
}).strict();

const AgentToolCallSchema = z.object({
  tool: z.string(),
  input: z.record(z.unknown()),
}).strict();

const AgentStepSchema = z.object({
  index: z.number().int().nonnegative(),
  thought: z.string(),
  // Sequential single tool call
  action: AgentToolCallSchema.optional(),
  observation: z.string().optional(),
  // Parallel batch (2+ tools fired simultaneously)
  actions: z.array(AgentToolCallSchema).max(MAX_AGENT_STEPS_CAP).optional(),
  observations: z.array(z.string()).max(MAX_AGENT_STEPS_CAP).optional(),
  answer: z.string().optional(),
  duration_ms: z.number().int().nonnegative(),
  token_count: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const AgentResponseSchema = z.object({
  query_type: z.literal('agent'),
  answer: z.string(),
  steps: z.array(AgentStepSchema).max(MAX_AGENT_STEPS_CAP),
  meta: z.object({
    request_id: z.string(),
    total_duration_ms: z.number().finite().nonnegative(),
    tool_call_count: z.number().int().nonnegative(),
    termination_reason: z.enum([
      'answer',
      'max_steps',
      'timeout',
      'budget',
      'error',
      'loop_detected',
      'fallback',
      'blocked',
      'aborted',
    ]),
    fallback_applied: z.boolean(),
    fallback_trace: z.object({
      fallbackApplied: z.enum(['layer2', 'layer3', 'layer4']).nullable(),
      reasoningFailure: z.boolean(),
      failedSynthesisAttempts: z.number().int().nonnegative(),
      fallbackSearchUsed: z.boolean(),
    }).strict().optional(),
    total_tokens: z.object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
}).strict();

// ErrorResponseSchema imported from search-response.schema.ts (RFC-014 canonical shape)

export const AgentRouteContract = {
  operationId: 'agent.execute',
  body: AgentRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: AgentResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
} as const;

export interface AgentRouteDeps {
  readonly agentOrchestrator: AgentOrchestrator;
}

export function registerAgentRoute(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/agent',
    contract: AgentRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, AgentRouteContract);
      const requestId = getRequestId(request);

      // Defense-in-depth hard cap on max_steps. Zod already restricts input
      // to [1, 10] but we re-clamp here so the orchestrator can never run
      // more steps than the route advertises, even if the schema is later
      // loosened or the orchestrator default exceeds the cap.
      const requestedSteps = parsed.options?.max_steps;
      const effectiveMaxSteps = Math.min(
        requestedSteps !== undefined && Number.isFinite(requestedSteps) && requestedSteps > 0
          ? Math.floor(requestedSteps)
          : MAX_AGENT_STEPS_CAP,
        MAX_AGENT_STEPS_CAP,
      );

      // Wire the agent loop to the request lifecycle: when the client
      // disconnects, abort the orchestrator so we stop spending LLM tokens.
      // Without this, a closed connection still costs us ~10 LLM round-trips.
      const lifecycleController = new AbortController();
      const onClose = () => { lifecycleController.abort(); };
      request.raw.once('close', onClose);

      let result;
      try {
        // Security: the user query is passed to the LLM for reasoning only.
        // Actual Vespa queries go through SearchUseCase.execute() which runs
        // SecurityGate internally (pre-route phase). The LLM never sends
        // unsanitized text to Vespa.
        result = await deps.agentOrchestrator.execute(
          parsed.query,
          requestId,
          { maxSteps: effectiveMaxSteps },
          lifecycleController.signal,
        );
      } finally {
        request.raw.off('close', onClose);
        // Always abort the controller on request completion (success or error) so
        // that AbortController internal listener maps are cleaned up. Without this,
        // AbortSignal listeners registered by the orchestrator accumulate on every
        // healthy request, causing a memory leak under sustained load.
        lifecycleController.abort();
      }

      const response = {
        query_type: 'agent' as const,
        answer: result.answer,
        steps: result.steps.map((s) => ({
          index: s.index,
          thought: s.thought,
          ...(s.action !== undefined ? { action: { tool: s.action.tool, input: s.action.input } } : {}),
          ...(s.observation !== undefined ? { observation: s.observation } : {}),
          ...(s.actionPairs !== undefined ? { actions: s.actionPairs.map((p) => ({ tool: p.action.tool, input: p.action.input })) } : {}),
          ...(s.actionPairs !== undefined ? { observations: s.actionPairs.map((p) => p.observation) } : {}),
          ...(s.answer !== undefined ? { answer: s.answer } : {}),
          duration_ms: s.durationMs,
          token_count: s.tokenCount,
        })),
        meta: {
          request_id: requestId,
          total_duration_ms: result.totalDurationMs,
          tool_call_count: result.toolCallCount,
          termination_reason: result.terminationReason,
          fallback_applied: result.fallbackApplied,
          ...(result.fallbackTrace !== undefined ? { fallback_trace: result.fallbackTrace } : {}),
          total_tokens: result.totalTokens,
        },
      };

      sendContractResponse(request, reply, HTTP_STATUS_OK, AgentResponseSchema, response);
    },
  });
}
