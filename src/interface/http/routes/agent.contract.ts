import { ErrorResponseSchema } from '../schemas/search-response.schema.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '../constants.js';
import {
  AgentRequestSchema,
  AgentResponseSchema,
} from '../schemas/agent.schema.js';

export const AgentRouteContract = {
  operationId: 'agent.execute',
  body: AgentRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: AgentResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
} as const;
