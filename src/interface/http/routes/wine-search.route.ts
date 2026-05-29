/**
 * POST /v1/wine-search — Plan-then-Execute wine search endpoint.
 *
 * Public HTTP surface for the canonical orchestrator
 * (`WineSearchOrchestrator`). This is a deliberate
 * redesign:
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
import { registerContractRoute } from './register-contract-route.js';
import { parseContractBody } from './contract-response.js';
import { WineSearchRouteContract } from './wine-search.contract.js';
import type {
  WineSearchOrchestratorContract as WineSearchOrchestrator,
} from '@app/wine-search/wine-search-orchestrator.js';
import {
  executeWineSearchHttpRequest,
} from './wine-search-route-support.js';

export type { WineSearchOrchestrator };
export { mapResultToResponse } from './wine-search-route-support.js';

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
      await executeWineSearchHttpRequest(
        request,
        reply,
        parsed,
        WineSearchRouteContract,
        deps.wineSearchOrchestrator,
      );
    },
  });
}
