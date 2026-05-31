/**
 * Agent surface contracts.
 *
 * `agent.run` is the caller-managed single-shot endpoint.
 * `agent.session.create` and `agent.session.turn` are the canonical
 * server-managed history-custody endpoints.
 *
 * All three surfaces reuse the existing orchestrator answer contract.
 * Session-managed responses extend that answer shape with explicit session
 * and `history_applied` echo blocks so the caller can audit the exact
 * context the planner saw.
 */

import {
  AgentSessionCreateRequestSchema,
  AgentSessionCreateResponseSchema,
  AgentSessionTurnParamsSchema,
  AgentSessionTurnRequestSchema,
  AgentSessionTurnResponseSchema,
  AgentRunRequestSchema,
} from '../schemas/agent.schema.js';
import { ErrorResponseSchema } from '../schemas/search-response.schema.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_CREATED,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '../constants.js';

export const AgentRunRouteContract = {
  operationId: 'agent.run',
  body: AgentRunRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: AgentSessionTurnResponseSchema.omit({
      session: true,
      turn: true,
      history_applied: true,
    }),
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
} as const;

export const AgentSessionCreateRouteContract = {
  operationId: 'agent.session.create',
  body: AgentSessionCreateRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: AgentSessionCreateResponseSchema,
    [HTTP_STATUS_CREATED]: AgentSessionCreateResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
} as const;

export const AgentSessionTurnRouteContract = {
  operationId: 'agent.session.turn',
  body: AgentSessionTurnRequestSchema,
  params: AgentSessionTurnParamsSchema,
  responses: {
    [HTTP_STATUS_OK]: AgentSessionTurnResponseSchema,
    [HTTP_STATUS_CREATED]: AgentSessionTurnResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_NOT_FOUND]: ErrorResponseSchema,
    [HTTP_STATUS_CONFLICT]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
} as const;
