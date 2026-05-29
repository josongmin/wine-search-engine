/**
 * Agent surface — T-IR-02 single-shot endpoint.
 *
 * `POST /v1/agent/run` — caller-managed history. The caller submits the
 * full `messages[]` slice it wants the planner to see; the server retains
 * no state between calls (architecture-decision §3.1).
 *
 * During the T-IR-02 → T-IR-03 transition the orchestrator still consumes a
 * single `query` string. The route handler extracts the latest USER message
 * content as that string and passes the prior messages along as
 * orchestrator-visible context. When the orchestrator gains native
 * `messages[]` support (T-IR-03), this adapter collapses to a pass-through.
 *
 * Session-managed endpoints (`/v1/agent/sessions`,
 * `/v1/agent/sessions/:sessionId/turns`) are declared in
 * `agent.schema.ts` but their route registration lands with T-IR-03 alongside
 * the persistent session store.
 */

import type { FastifyInstance } from 'fastify';
import { registerContractRoute } from './register-contract-route.js';
import { parseContractBody } from './contract-response.js';
import { AgentRunRouteContract } from './agent.contract.js';
import type {
  WineSearchOrchestratorContract as WineSearchOrchestrator,
} from '@app/wine-search/wine-search-orchestrator.js';
import { executeWineSearchHttpRequest } from './wine-search-route-support.js';
import type { AgentMessage, AgentRunRequestBody } from '../schemas/agent.schema.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';

export interface AgentRouteDeps {
  readonly wineSearchOrchestrator: WineSearchOrchestrator;
}

/**
 * Pulls the most recent `role: 'user'` message content. The planner needs a
 * single anchor utterance — the last user message is the canonical choice
 * (matches both Anthropic Messages API semantics and the way a session turn
 * sandwiches prior context around a new user prompt). Throws a 400 if the
 * caller submitted a `messages` array with no user role — a system-only or
 * assistant-echo-only payload has nothing to plan on.
 */
function extractLatestUserMessage(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === 'user') {
      return msg.content;
    }
  }
  throw new DomainError(
    'INVALID_REQUEST',
    'agent run requires at least one message with role="user"',
  );
}

/**
 * Reshapes the new `messages[]` body into the legacy `query` field the
 * orchestrator currently expects. The mapping is intentionally narrow:
 *
 *   - `query`             ← latest user-message content
 *   - `options.*`         ← per-request budget overrides (snake_case keys
 *                           identical to the legacy `WineSearchRequestSchema`)
 *
 * Prior assistant / tool / system messages are not yet fed to the planner —
 * native history support lands with T-IR-03. The fact that we accept them
 * here lets clients write the canonical `messages[]` payload today without
 * waiting for T-IR-03 to ship.
 */
function adaptAgentRunBodyToWineSearch(body: AgentRunRequestBody): {
  readonly query: string;
  readonly options?: AgentRunRequestBody['options'];
} {
  const query = extractLatestUserMessage(body.messages);
  return {
    query,
    ...(body.options !== undefined ? { options: body.options } : {}),
  };
}

export function registerAgentRunRoute(app: FastifyInstance, deps: AgentRouteDeps): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/agent/run',
    contract: AgentRunRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, AgentRunRouteContract);
      const adapted = adaptAgentRunBodyToWineSearch(parsed);
      await executeWineSearchHttpRequest(
        request,
        reply,
        adapted,
        AgentRunRouteContract,
        deps.wineSearchOrchestrator,
      );
    },
  });
}
