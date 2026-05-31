import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { registerContractRoute } from './register-contract-route.js';
import { parseContractBody, sendRouteContractResponse } from './contract-response.js';
import {
  AgentRunRouteContract,
  AgentSessionCreateRouteContract,
  AgentSessionTurnRouteContract,
} from './agent.contract.js';
import type {
  AgentOptions,
  AgentSessionCreateResponseBody,
  AgentSessionTurnParams,
} from '../schemas/agent.schema.js';
import {
  mapWineSearchResultToResponse,
  buildSessionDescriptor,
  buildTurnResponse,
} from '@app/wine-search/presentation/agent-presentation.js';
import {
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_CREATED,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
  MAX_AGENT_STEPS_CAP,
} from '../constants.js';
import { buildSearchErrorResponse, sendSearchErrorResponse } from '../errors/error-response.js';
import { getRequestId } from '../request-id.js';
import { abortSignalFromFastifyRequest, raceWithRequestAbort } from '../request-abort-signal.js';
import type { AgentRequestOptions } from '@app/wine-search/wine-search-schemas.js';
import type { AgentUseCasePort } from '@app/wine-search/port/agent-usecase.port.js';

/**
 * Agent HTTP surface — `POST /v1/agent` (run), `POST /v1/agent/sessions`
 * (create), `POST /v1/agent/sessions/:sessionId/turns` (turn).
 *
 * These handlers are THIN: parse the wire body → map snake_case → the single
 * {@link AgentUseCasePort} → shape the response (presentation) / map the
 * outcome union to a status. ALL business logic (validation, history custody,
 * planning, store availability) lives behind the use case. The local CLI
 * facade calls the SAME use case, so the two transports cannot drift.
 */
export interface AgentRouteDeps {
  readonly agentUseCase: AgentUseCasePort;
}

/** Clamp inbound `max_steps` to the hard cap as defense-in-depth at the edge.
 *  The orchestrator re-clamps (the runtime SSoT); this just rejects an absurd
 *  request shape early. */
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

/** Map the HTTP snake_case options bag → the application's camelCase
 *  {@link AgentRequestOptions}. The SINGLE option-mapping site on the HTTP
 *  edge (run + sessions share it). Returns `undefined` when nothing is set so
 *  the use case / service can layer defaults. */
function toAgentRequestOptions(options: AgentOptions | undefined): AgentRequestOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  const mapped: AgentRequestOptions = {
    ...(options.max_steps !== undefined ? { maxSteps: clampMaxSteps(options.max_steps) } : {}),
    ...(options.per_step_timeout_ms !== undefined ? { perStepTimeoutMs: options.per_step_timeout_ms } : {}),
    ...(options.agent_timeout_ms !== undefined ? { agentTimeoutMs: options.agent_timeout_ms } : {}),
    ...(options.max_total_tokens !== undefined ? { maxTotalTokens: options.max_total_tokens } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function sendSessionNotFound(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
): void {
  sendSearchErrorResponse(
    request,
    reply,
    HTTP_STATUS_NOT_FOUND,
    buildSearchErrorResponse(
      getRequestId(request),
      'NOT_FOUND',
      `agent session "${sessionId}" was not found`,
      'session_not_found',
      false,
    ),
  );
}

function sendSessionVersionConflict(
  request: FastifyRequest,
  reply: FastifyReply,
  currentVersion: number,
): void {
  sendSearchErrorResponse(
    request,
    reply,
    HTTP_STATUS_CONFLICT,
    buildSearchErrorResponse(
      getRequestId(request),
      'CONFLICT',
      `agent session version conflict; current version is ${String(currentVersion)}`,
      'version_conflict',
      false,
    ),
  );
}

/** Run the use-case call under a request-scoped abort lifecycle: the execution
 *  signal is the union of the inbound request abort + a lifecycle controller
 *  that is always aborted in `finally` (no orphaned work). Shared by run + turn
 *  so the lifecycle pattern is written once. */
async function withAbortLifecycle<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  message: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const requestAbortSignal = abortSignalFromFastifyRequest(request, reply);
  const lifecycleController = new AbortController();
  const executionAbortSignal = AbortSignal.any([requestAbortSignal, lifecycleController.signal]);
  try {
    return await raceWithRequestAbort(run(executionAbortSignal), executionAbortSignal, message);
  } finally {
    lifecycleController.abort();
  }
}

export function registerAgentRunRoute(app: FastifyInstance, deps: AgentRouteDeps): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/agent',
    contract: AgentRunRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, AgentRunRouteContract);
      const requestId = getRequestId(request);
      const options = toAgentRequestOptions(parsed.options);
      const result = await withAbortLifecycle(
        request,
        reply,
        'Wine search request aborted',
        (signal) =>
          deps.agentUseCase.run({
            messages: parsed.messages,
            requestId,
            ...(parsed.context !== undefined ? { context: parsed.context } : {}),
            ...(options !== undefined ? { options } : {}),
            abortSignal: signal,
          }),
      );
      sendRouteContractResponse(
        request,
        reply,
        AgentRunRouteContract,
        HTTP_STATUS_OK,
        mapWineSearchResultToResponse(result, requestId),
      );
    },
  });
}

export function registerAgentSessionCreateRoute(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/agent/sessions',
    contract: AgentSessionCreateRouteContract,
    handler: async (request, reply) => {
      const parsed = parseContractBody(request, AgentSessionCreateRouteContract);
      const options = toAgentRequestOptions(parsed.options);
      const created = await deps.agentUseCase.createSession({
        ...(parsed.client_session_id !== undefined ? { clientSessionId: parsed.client_session_id } : {}),
        ...(parsed.context !== undefined ? { context: parsed.context } : {}),
        ...(options !== undefined ? { options } : {}),
      });
      const body: AgentSessionCreateResponseBody = {
        session: buildSessionDescriptor(created.session),
        replayed: created.kind === 'idempotent_replay',
      };
      sendRouteContractResponse(
        request,
        reply,
        AgentSessionCreateRouteContract,
        created.kind === 'created' ? HTTP_STATUS_CREATED : HTTP_STATUS_OK,
        body,
      );
    },
  });
}

export function registerAgentSessionTurnRoute(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/agent/sessions/:sessionId/turns',
    contract: AgentSessionTurnRouteContract,
    handler: async (request, reply) => {
      const params: AgentSessionTurnParams = AgentSessionTurnRouteContract.params.parse(request.params);
      const parsed = parseContractBody(request, AgentSessionTurnRouteContract);
      const requestId = getRequestId(request);
      const options = toAgentRequestOptions(parsed.options);

      const outcome = await withAbortLifecycle(
        request,
        reply,
        'Wine search request aborted',
        (signal) =>
          deps.agentUseCase.runTurn({
            sessionId: params.sessionId,
            clientTurnId: parsed.client_turn_id,
            messages: parsed.messages,
            requestId,
            abortSignal: signal,
            ...(parsed.expected_session_version !== undefined
              ? { expectedSessionVersion: parsed.expected_session_version }
              : {}),
            ...(options !== undefined ? { options } : {}),
          }),
      );

      switch (outcome.kind) {
        case 'appended':
        case 'idempotent_replay': {
          const response = mapWineSearchResultToResponse(outcome.result, requestId);
          sendRouteContractResponse(
            request,
            reply,
            AgentSessionTurnRouteContract,
            outcome.replayed ? HTTP_STATUS_OK : HTTP_STATUS_CREATED,
            buildTurnResponse(response, outcome.session, outcome.turn, outcome.replayed),
          );
          return;
        }
        case 'version_conflict':
          sendSessionVersionConflict(request, reply, outcome.currentVersion);
          return;
        case 'session_not_found':
          sendSessionNotFound(request, reply, params.sessionId);
          return;
      }
    },
  });
}
