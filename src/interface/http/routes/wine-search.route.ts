/**
 * POST /v1/wine-search — Plan-then-Execute wine search endpoint.
 *
 * Public HTTP surface for the new orchestrator (`WineSearchOrchestrator`)
 * that replaces the ReAct-style `/v1/agent` loop. This is a deliberate
 * breaking redesign:
 *
 *   - Steps are uniform (every step carries a `tool_calls[]` and
 *     `observations[]` array, even when there is only one of each — the
 *     legacy `action` vs `actions[]` duality is gone).
 *   - `meta.termination` is a single nested record (`reason`, `layer`,
 *     optional `degraded_reason`) instead of three sibling optional
 *     fields.
 *   - `meta.policy_blocked` is a typed boolean — callers no longer have
 *     to infer blocked state from `termination_reason` + `fallback_trace`.
 *
 * The route applies defense-in-depth clamping on `max_steps` (the Zod
 * schema rejects `0` outright — a `=0` request is a 400, not a silent
 * bump to the default cap) and wires the orchestrator's `abortSignal`
 * to the Node `request.raw 'aborted'` event (NOT `'close'`: Node can
 * emit close while a healthy handler is still running, which would
 * abort normal LLM calls before the planner finishes).
 */

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { registerContractRoute } from './register-contract-route.js';
import { parseContractBody, sendRouteContractResponse } from './contract-response.js';
import { getRequestId } from '../request-id.js';
import {
  HTTP_STATUS_OK,
  MAX_AGENT_STEPS_CAP,
} from '../constants.js';
import { WineSearchRouteContract } from './wine-search.contract.js';
import type {
  WineSearchResponseSchema,
  WineSearchStepBody,
  WineSearchTerminationBody,
  TokenUsageBody,
} from '../schemas/wine-search.schema.js';
import type {
  WineSearchOrchestratorContract as WineSearchOrchestrator,
  WineSearchResult as OrchestratorResult,
  TokenUsageShape as OrchestratorTokenUsage,
} from '@app/wine-search/wine-search-orchestrator.js';

export type { WineSearchOrchestrator };

// ---------------------------------------------------------------------------
// Orchestrator contract — the canonical types live in the application layer
// (`@app/wine-search/wine-search-orchestrator.js`). This route is the single
// HTTP boundary that re-cases camelCase fields into the snake_case wire
// shape — no other layer performs shape translation.
// ---------------------------------------------------------------------------

/** Re-export the orchestrator's input shape under the HTTP-route-facing alias
 *  so existing callers keep their import surface. `abortSignal` is required
 *  at the HTTP boundary (the route always wires one), whereas the
 *  orchestrator itself treats it as optional. */

// ---------------------------------------------------------------------------
// Route dependencies + registration
// ---------------------------------------------------------------------------

export interface WineSearchRouteDeps {
  readonly wineSearchOrchestrator: WineSearchOrchestrator;
}

export function registerWineSearchRoute(
  app: FastifyInstance,
  deps: WineSearchRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/wine-search',
    contract: WineSearchRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, WineSearchRouteContract);
      const requestId = getRequestId(request);

      // Defense-in-depth hard cap on max_steps. Zod already restricts the
      // input to [1, MAX_AGENT_STEPS_CAP] and rejects 0 outright, so we
      // never silently bump a `max_steps=0` request to the default cap (this
      // was a known latent bug in agent.route.ts; the redesigned route
      // surfaces it as a Zod 400 instead).
      const requestedSteps = parsed.options?.max_steps;
      const effectiveMaxSteps = clampMaxSteps(requestedSteps);

      // Wire the orchestrator to the actual request-abort event. Do NOT use
      // `request.raw 'close'` — Node can emit close while a long-running
      // handler is still healthy, which would abort LLM calls before the
      // planner can finish.
      const lifecycleController = new AbortController();
      const onClientAbort = (): void => { lifecycleController.abort(); };
      request.raw.once('aborted', onClientAbort);

      try {
        const result = await deps.wineSearchOrchestrator.execute({
          query: parsed.query,
          requestId,
          maxSteps: effectiveMaxSteps,
          ...(parsed.options?.per_step_timeout_ms !== undefined
            ? { perStepTimeoutMs: parsed.options.per_step_timeout_ms }
            : {}),
          ...(parsed.options?.agent_timeout_ms !== undefined
            ? { agentTimeoutMs: parsed.options.agent_timeout_ms }
            : {}),
          ...(parsed.options?.max_total_tokens !== undefined
            ? { maxTotalTokens: parsed.options.max_total_tokens }
            : {}),
          abortSignal: lifecycleController.signal,
        });

        const response = mapResultToResponse(result, requestId);
        sendRouteContractResponse(
          request,
          reply,
          WineSearchRouteContract,
          HTTP_STATUS_OK,
          response,
        );
      } finally {
        request.raw.off('aborted', onClientAbort);
        // Always abort on completion so AbortSignal listeners registered by
        // the orchestrator are cleaned up. Without this, listeners accumulate
        // under sustained load and leak memory (parity with agent.route.ts).
        lifecycleController.abort();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Pure mappers
// ---------------------------------------------------------------------------

/**
 * Clamps `max_steps` to [1, MAX_AGENT_STEPS_CAP]. The Zod schema already
 * enforces the bounds, but this is defense-in-depth: if the schema is later
 * loosened or the orchestrator default exceeds the cap, this guarantee
 * holds. Critically, we do NOT silently coerce `0` here — Zod rejects `0`
 * outright with a 400. The only path through this function that returns
 * the cap is when `requested` is `undefined`.
 */
function clampMaxSteps(requested: number | undefined): number {
  if (requested === undefined) {
    return MAX_AGENT_STEPS_CAP;
  }
  // Zod has already enforced int + finite + [1, cap], but re-floor and
  // re-clamp so corruption elsewhere cannot produce a non-integer or
  // overflowing value here.
  const floored = Math.floor(requested);
  if (!Number.isFinite(floored) || floored < 1) {
    return MAX_AGENT_STEPS_CAP;
  }
  return Math.min(floored, MAX_AGENT_STEPS_CAP);
}

/**
 * Convert the camelCase internal `WineSearchResult` to the snake_case wire
 * shape declared by `WineSearchResponseSchema`. Pure function — does not
 * touch the request or reply.
 *
 * This is the SINGLE seam that re-cases the unified result shape into the
 * HTTP wire envelope. Field names (`name`/`arguments` on tool calls,
 * `intent`, `terminationReason`/`layer`/`degradedReason`) line up 1:1 with
 * the wire snake_case fields — only the surrounding container is re-cased
 * here, never field-renamed.
 *
 * Exported so tests can validate the mapping independently of the route
 * wiring (and so the orchestrator team can spot-check the projection).
 */
export function mapResultToResponse(
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
    ...(step.observations !== undefined
      ? { observations: [...step.observations] }
      : {}),
    duration_ms: step.durationMs,
    ...(step.tokenUsage !== undefined
      ? { token_usage: toTokenUsageBody(step.tokenUsage) }
      : {}),
  }));

  const termination: WineSearchTerminationBody = {
    reason: result.terminationReason,
    layer: result.layer,
    // S1 semantic split: forward the internal `terminationKind` to the
    // wire `kind` field. Present only when the orchestrator emitted one
    // (always on `terminationReason === 'blocked'`).
    ...(result.terminationKind !== undefined
      ? { kind: result.terminationKind }
      : {}),
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
