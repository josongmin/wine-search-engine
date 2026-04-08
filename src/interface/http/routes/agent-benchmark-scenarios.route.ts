/**
 * GET /v1/agent/benchmark-scenarios — list quick-profile benchmark scenarios for UI simulation.
 *
 * Disabled in production unless ENABLE_AGENT_BENCHMARK_UI=true.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_BENCHMARK_UI_SCENARIOS } from '../../../domain/agent/benchmark-ui-scenarios.js';
import {
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
} from '../constants.js';
import { buildSearchErrorResponse, sendSearchErrorResponse } from '../errors/error-response.js';
import { getRequestId } from '../request-id.js';
import { ErrorResponseSchema } from '../schemas/search-response.schema.js';
import { registerContractRoute } from './register-contract-route.js';
import { sendContractResponse } from './contract-response.js';
import { MAX_AGENT_HTTP_QUERY_CHARS } from '../constants.js';

/** Tier string length cap (covers longest benchmark tier label with headroom). */
const MAX_BENCHMARK_TIER_CHARS = 64;
/** Description line cap for UI catalog rows. */
const MAX_BENCHMARK_DESCRIPTION_CHARS = 500;
/** Upper bound on scenarios returned in one response (quick profile + margin). */
const MAX_BENCHMARK_SCENARIOS_IN_RESPONSE = 100;

const AgentBenchmarkUiScenarioSchema = z
  .object({
    id: z.number().int().positive(),
    tier: z.string().min(1).max(MAX_BENCHMARK_TIER_CHARS),
    query: z.string().min(1).max(MAX_AGENT_HTTP_QUERY_CHARS * 2),
    description: z.string().min(1).max(MAX_BENCHMARK_DESCRIPTION_CHARS),
    profile: z.literal('quick'),
  })
  .strict();

const AgentBenchmarkScenariosResponseSchema = z
  .object({
    scenarios: z.array(AgentBenchmarkUiScenarioSchema).max(MAX_BENCHMARK_SCENARIOS_IN_RESPONSE),
  })
  .strict();

export const AgentBenchmarkScenariosRouteContract = {
  operationId: 'agent.benchmarkScenarios.list',
  responses: {
    [HTTP_STATUS_OK]: AgentBenchmarkScenariosResponseSchema,
    [HTTP_STATUS_NOT_FOUND]: ErrorResponseSchema,
  },
} as const;

export interface AgentBenchmarkScenariosRouteOptions {
  readonly enabled: boolean;
}

export function registerAgentBenchmarkScenariosRoute(
  app: FastifyInstance,
  options: AgentBenchmarkScenariosRouteOptions,
): void {
  registerContractRoute(app, {
    method: 'GET',
    url: '/v1/agent/benchmark-scenarios',
    contract: AgentBenchmarkScenariosRouteContract,
    handler: async (request, reply) => {
      const requestId = getRequestId(request);
      if (!options.enabled) {
        sendSearchErrorResponse(
          request,
          reply,
          HTTP_STATUS_NOT_FOUND,
          buildSearchErrorResponse(
            requestId,
            'NOT_FOUND',
            'Agent benchmark scenario catalog is not enabled for this deployment.',
            null,
            false,
          ),
        );
        return;
      }

      const scenarios = AGENT_BENCHMARK_UI_SCENARIOS.map((s) => ({
        id: s.id,
        tier: s.tier,
        query: s.query,
        description: s.description,
        profile: 'quick' as const,
      }));

      sendContractResponse(
        request,
        reply,
        HTTP_STATUS_OK,
        AgentBenchmarkScenariosResponseSchema,
        { scenarios },
      );
    },
  });
}
