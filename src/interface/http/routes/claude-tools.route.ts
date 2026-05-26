/**
 * Epic 17.2: Claude Tools HTTP Endpoint
 *
 * POST /v1/claude-tools — execute Claude tool calls via HTTP.
 *
 * Request:
 * {
 *   "tool_name": "search_wines" | "lookup_wine" | "get_food_pairings" |
 *                "check_drinking_window" | "compare_wines",
 *   "tool_input": { ... },
 *   "request_id": "..." (optional, generated if not provided)
 * }
 *
 * Response:
 * {
 *   "tool_name": "...",
 *   "tool_result": { ... },
 *   "fallback_applied": "mixed" (search_wines only, optional),
 *   "request_id": "..."
 * }
 */

import type { FastifyInstance } from 'fastify';
import type { ClaudeToolsRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import {
  ClaudeToolsExecuteRequestSchema,
  ClaudeToolsExecuteRouteContract,
  ClaudeToolsListRouteContract,
  type ClaudeToolsExecuteRequest,
} from './route-contracts.js';
import { WINE_SEARCH_TOOLS } from '../../claude-tools/tool-schemas.js';
import { getRequestId, resolveRequestId } from '../request-id.js';
import { HTTP_STATUS_OK } from '../constants.js';

/**
 * Register /v1/claude-tools endpoint.
 *
 * Accepts tool call requests and delegates to AdaptiveToolExecutor.
 * Returns structured responses with tool results.
 *
 * @param app - Fastify instance
 * @param deps - Narrow route dependencies with tool executors
 */
export function registerClaudeToolsRoute(app: FastifyInstance, deps: ClaudeToolsRouteDeps): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/claude-tools',
    contract: ClaudeToolsExecuteRouteContract,
    handler: async (request, reply) => {
      // Unknown errors MUST propagate to the global error handler so the
      // response body matches the RFC-014 envelope. A previous version of
      // this handler fabricated a flat `{ error, message, request_id }`
      // payload on catch-all errors — that shape violated the contract in
      // CLAUDE.md ("catch blocks in use-case code MUST NOT fabricate
      // success-shaped responses from unexpected errors").
      // Pass the schema directly (instead of the wider contract object) so
      // TypeScript can infer `TBody` precisely as the discriminated union schema.
      // Without this, the intersection type on the contract (`HttpRouteContract &
      // { readonly body: typeof ClaudeToolsExecuteRequestSchema }`) widens `body`
      // back to `z.ZodTypeAny` and propagates `any` through `z.output<TBody>`.
      const parsed: ClaudeToolsExecuteRequest = parseContractBody(request, {
        body: ClaudeToolsExecuteRequestSchema,
      });
      const requestId = resolveRequestId(request, parsed.request_id);
      const executionResult = await deps.adaptiveToolExecutor.executeWithFallback(
        parsed.tool_name,
        parsed.tool_input,
        requestId,
      );
      sendRouteContractResponse(request, reply, ClaudeToolsExecuteRouteContract, HTTP_STATUS_OK, {
        tool_name: parsed.tool_name,
        tool_result: executionResult.result,
        request_id: requestId,
        ...(executionResult.fallbackApplied !== undefined
          ? { fallback_applied: executionResult.fallbackApplied }
          : {}),
      });
    },
  });

  registerContractRoute(app, {
    method: 'GET',
    url: '/v1/claude-tools',
    contract: ClaudeToolsListRouteContract,
    handler: async (request, reply) => {
      sendRouteContractResponse(request, reply, ClaudeToolsListRouteContract, HTTP_STATUS_OK, {
        tools: WINE_SEARCH_TOOLS,
        request_id: getRequestId(request),
      });
    },
  });
}
