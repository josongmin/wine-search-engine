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

const AgentRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  session_context: z.object({
    session_id: z.string().min(1).max(256),
    previous_entities: z.array(z.string()).max(50).optional(),
  }).optional(),
  options: z.object({
    max_steps: z.number().int().min(1).max(10).optional(),
  }).strict().optional(),
}).strict();

const AgentStepSchema = z.object({
  index: z.number().int().nonnegative(),
  thought: z.string(),
  action: z.object({
    tool: z.string(),
    input: z.record(z.unknown()),
  }).strict().optional(),
  observation: z.string().optional(),
  answer: z.string().optional(),
  duration_ms: z.number().nonnegative(),
  token_count: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const AgentResponseSchema = z.object({
  query_type: z.literal('agent'),
  answer: z.string(),
  steps: z.array(AgentStepSchema),
  meta: z.object({
    request_id: z.string(),
    total_duration_ms: z.number(),
    tool_call_count: z.number(),
    termination_reason: z.string(),
    fallback_applied: z.boolean(),
    total_tokens: z.object({
      input: z.number(),
      output: z.number(),
    }),
  }),
});

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
  }),
});

const AgentRouteContract = {
  operationId: 'agent.execute',
  body: AgentRequestSchema,
  responses: {
    200: AgentResponseSchema,
    400: ErrorResponseSchema,
    429: ErrorResponseSchema,
    500: ErrorResponseSchema,
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
      const HARD_CAP_MAX_STEPS = 10;
      const requestedSteps = parsed.options?.max_steps;
      const effectiveMaxSteps = Math.min(
        requestedSteps !== undefined && Number.isFinite(requestedSteps) && requestedSteps > 0
          ? Math.floor(requestedSteps)
          : HARD_CAP_MAX_STEPS,
        HARD_CAP_MAX_STEPS,
      );

      // Wire the agent loop to the request lifecycle: when the client
      // disconnects, abort the orchestrator so we stop spending LLM tokens.
      // Without this, a closed connection still costs us ~10 LLM round-trips.
      const lifecycleController = new AbortController();
      const onClose = () => lifecycleController.abort();
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
        );
      } finally {
        request.raw.off('close', onClose);
      }
      // lifecycleController is referenced to keep the abort wiring intact
      // for future orchestrator AbortSignal support without changing the
      // public port shape.
      void lifecycleController;

      const response = {
        query_type: 'agent' as const,
        answer: result.answer,
        steps: result.steps.map((s) => ({
          index: s.index,
          thought: s.thought,
          ...(s.action !== undefined ? { action: { tool: s.action.tool, input: s.action.input } } : {}),
          ...(s.observation !== undefined ? { observation: s.observation } : {}),
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
          total_tokens: result.totalTokens,
        },
      };

      sendContractResponse(request, reply, 200, AgentResponseSchema, response);
    },
  });
}
