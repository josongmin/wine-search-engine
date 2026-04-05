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

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../../config/container.js';
import { WINE_SEARCH_TOOLS } from '../../claude-tools/tool-schemas.js';

/**
 * Schema for tool call request.
 */
const ClaudeToolCallRequestSchema = z.object({
  tool_name: z.string().min(1, 'tool_name required'),
  tool_input: z.record(z.unknown()).optional().default({}),
  request_id: z.string().optional(),
});

/**
 * Successful tool call response body.
 */
interface ClaudeToolCallResponse {
  readonly tool_name: string;
  readonly tool_result: unknown;
  readonly fallback_applied?: string;
  readonly request_id: string;
}

/**
 * Register /v1/claude-tools endpoint.
 *
 * Accepts tool call requests and delegates to AdaptiveToolExecutor.
 * Returns structured responses with tool results.
 *
 * @param app - Fastify instance
 * @param container - DI container with tool executors
 */
export function registerClaudeToolsRoute(app: FastifyInstance, container: Container): void {
  /**
   * POST /v1/claude-tools
   *
   * Execute a Claude tool call.
   */
  app.post('/v1/claude-tools', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = ClaudeToolCallRequestSchema.parse(request.body);

      const requestId = parsed.request_id ?? request.id;

      // Execute tool with adaptive fallback
      const executionResult = await container.adaptiveToolExecutor.executeWithFallback(
        parsed.tool_name,
        parsed.tool_input,
        requestId,
      );

      // Build response
      const response: ClaudeToolCallResponse = {
        tool_name: parsed.tool_name,
        tool_result: executionResult.result,
        request_id: requestId,
        ...(executionResult.fallbackApplied !== undefined
          ? { fallback_applied: executionResult.fallbackApplied }
          : {}),
      };

      void reply.status(200).send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      void reply.status(400).send({
        error: 'TOOL_EXECUTION_FAILED',
        message,
        request_id: request.id,
      });
    }
  });

  /**
   * GET /v1/claude-tools
   *
   * Return available tool definitions (for Claude API tools parameter).
   */
  app.get('/v1/claude-tools', async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(200).send({
      tools: WINE_SEARCH_TOOLS,
      request_id: request.id,
    });
  });
}
