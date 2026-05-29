/**
 * Agent surface — T-IR-02 route contracts.
 *
 * `agent.run` is the canonical single-shot agent endpoint (caller-managed
 * history). `agent.session.create` and `agent.session.turn` are the
 * server-managed surfaces; their persistence layer lands in T-IR-03.
 *
 * Response shape reuses `WineSearchResponseSchema` for now — the existing
 * orchestrator output is the right wire shape; T-IR-03 may augment it with
 * `session.id` / `session.version` / `history_applied` echo blocks.
 */

import {
  AgentRunRequestSchema,
} from '../schemas/agent.schema.js';
import { WineSearchResponseSchema } from '../schemas/wine-search.schema.js';
import { ErrorResponseSchema } from '../schemas/search-response.schema.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '../constants.js';

export const AgentRunRouteContract = {
  operationId: 'agent.run',
  body: AgentRunRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: WineSearchResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
} as const;
