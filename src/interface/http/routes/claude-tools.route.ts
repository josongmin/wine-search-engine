/**
 * Epic 17.2: Claude Tools HTTP Endpoint
 *
 * POST /v1/claude-tools — execute Claude tool calls via HTTP.
 *
 * Request:
 * {
 *   "tool_name": "search_wines",
 *   "tool_input": { "query": "...", ... },
 *   "request_id": "..." (optional, generated if not provided)
 * }
 *
 * Response:
 * {
 *   "tool_name": "search_wines",
 *   "tool_result": { ... },
 *   "fallback_applied": "mixed" (optional),
 *   "request_id": "..."
 * }
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WINE_SEARCH_TOOLS } from '../../claude-tools/tool-schemas.js';
import type { ClaudeToolsRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import {
  ClaudeToolsExecuteRouteContract,
  ClaudeToolsListRouteContract,
} from './route-contracts.js';

function getRequestId(request: FastifyRequest): string {
  return request.requestId;
}

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
      try {
        const parsed = parseContractBody(request, ClaudeToolsExecuteRouteContract);
      const requestId = parsed.request_id ?? getRequestId(request);
      const executionResult = await deps.adaptiveToolExecutor.executeWithFallback(
        parsed.tool_name,
        parsed.tool_input,
        requestId,
      );
      sendRouteContractResponse(request, reply, ClaudeToolsExecuteRouteContract, 200, {
        tool_name: parsed.tool_name,
        tool_result: executionResult.result,
        request_id: requestId,
        ...(executionResult.fallbackApplied !== undefined
          ? { fallback_applied: executionResult.fallbackApplied }
          : {}),
      });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        sendRouteContractResponse(request, reply, ClaudeToolsExecuteRouteContract, 400, {
        error: 'TOOL_EXECUTION_FAILED',
        message,
        request_id: getRequestId(request),
        });
      }
    },
  });

  registerContractRoute(app, {
    method: 'GET',
    url: '/v1/claude-tools',
    contract: ClaudeToolsListRouteContract,
    handler: async (request, reply) => {
      sendRouteContractResponse(request, reply, ClaudeToolsListRouteContract, 200, {
        tools: WINE_SEARCH_TOOLS,
        request_id: getRequestId(request),
      });
    },
  });
}
