import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { buildSearchErrorResponse, sendSearchErrorResponse } from '../errors/error-response.js';
import { HTTP_STATUS_OK, HTTP_STATUS_SERVICE_UNAVAILABLE, MAX_AGENT_STEPS_CAP } from '../constants.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import type {
  WineSearchRequestSchema,
  WineSearchResponseSchema,
} from '../schemas/wine-search.schema.js';
import { mapWineSearchResultToResponse } from './wine-search-response-mapper.js';
import { sendRouteContractResponse } from './contract-response.js';
import type { HttpRouteContract } from './route-contracts.js';
import type {
  WineSearchOrchestratorContract as WineSearchOrchestrator,
} from '@app/wine-search/wine-search-orchestrator.js';

function clampMaxSteps(requested: number | undefined): number {
  if (requested === undefined) {
    return MAX_AGENT_STEPS_CAP;
  }
  const floored = Math.floor(requested);
  if (!Number.isFinite(floored) || floored < 1) {
    return MAX_AGENT_STEPS_CAP;
  }
  return Math.min(floored, MAX_AGENT_STEPS_CAP);
}

export function mapResultToResponse(
  result: Parameters<typeof mapWineSearchResultToResponse>[0],
  requestId: string,
): z.infer<typeof WineSearchResponseSchema> {
  return mapWineSearchResultToResponse(result, requestId);
}

function sendFrontDoorUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = getRequestId(request);
  const body = buildSearchErrorResponse(
    requestId,
    'SERVICE_UNAVAILABLE',
    'Agentic search front door is unavailable.',
    null,
    true,
  );
  sendSearchErrorResponse(request, reply, HTTP_STATUS_SERVICE_UNAVAILABLE, body);
}

export async function executeWineSearchHttpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  parsed: z.output<typeof WineSearchRequestSchema>,
  routeContract: HttpRouteContract,
  orchestrator: WineSearchOrchestrator | undefined,
): Promise<void> {
  if (orchestrator === undefined) {
    sendFrontDoorUnavailable(request, reply);
    return;
  }

  const requestId = getRequestId(request);
  const requestAbortSignal = abortSignalFromFastifyRequest(request, reply);
  const lifecycleController = new AbortController();
  const executionAbortSignal = AbortSignal.any([
    requestAbortSignal,
    lifecycleController.signal,
  ]);

  try {
    const result = await raceWithRequestAbort(
      orchestrator.execute({
        query: parsed.query,
        requestId,
        maxSteps: clampMaxSteps(parsed.options?.max_steps),
        ...(parsed.options?.per_step_timeout_ms !== undefined
          ? { perStepTimeoutMs: parsed.options.per_step_timeout_ms }
          : {}),
        ...(parsed.options?.agent_timeout_ms !== undefined
          ? { agentTimeoutMs: parsed.options.agent_timeout_ms }
          : {}),
        ...(parsed.options?.max_total_tokens !== undefined
          ? { maxTotalTokens: parsed.options.max_total_tokens }
          : {}),
        abortSignal: executionAbortSignal,
      }),
      executionAbortSignal,
      'Wine search request aborted',
    );

    sendRouteContractResponse(
      request,
      reply,
      routeContract,
      HTTP_STATUS_OK,
      mapResultToResponse(result, requestId),
    );
  } finally {
    lifecycleController.abort();
  }
}
