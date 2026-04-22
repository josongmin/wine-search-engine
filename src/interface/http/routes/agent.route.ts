/**
 * POST /v1/agent — Agentic wine search endpoint.
 *
 * Accepts a natural language query and runs a ReAct reasoning loop
 * using existing search tools (search_wines, compare_wines, etc.).
 */

import type { FastifyInstance } from 'fastify';
import { registerContractRoute } from './register-contract-route.js';
import { parseContractBody, sendRouteContractResponse } from './contract-response.js';
import { getRequestId } from '../request-id.js';
import type { AgentOrchestrator } from '../../../application/agent/agent-orchestrator.js';
import {
  HTTP_STATUS_OK,
  MAX_AGENT_STEPS_CAP,
} from '../constants.js';
import { AgentRouteContract } from './agent.contract.js';

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

      // Wire the agent loop to real request-abort events. Do not use
      // request.raw/reply.raw "close": Node can emit close while a long-running
      // handler is still healthy, which aborts normal LLM calls before the
      // planner can finish.
      const lifecycleController = new AbortController();
      const onClientAbort = () => { lifecycleController.abort(); };
      request.raw.once('aborted', onClientAbort);

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
        request.raw.off('aborted', onClientAbort);
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

      sendRouteContractResponse(request, reply, AgentRouteContract, HTTP_STATUS_OK, response);
    },
  });
}
