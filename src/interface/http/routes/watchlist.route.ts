/**
 * Subject-scoped watchlist routes.
 *
 * Trusted auth is supplied by `X-Authenticated-Subject`; route handlers never
 * accept caller-provided `user_id` and hide cross-user resources behind 404s.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
} from '../../../domain/watchlist/model/watchlist-entry.js';
import { toWatchlistTriggerResponse } from '../../../domain/watchlist/service/watchlist-policy.js';
import { getAuthenticatedSubject } from '../authenticated-subject.js';
import {
  CreateWatchlistResponseSchema,
  GetWatchlistResponseSchema,
  ListDeliveriesResponseSchema,
  ListWatchlistResponseSchema,
  WatchlistErrorResponseSchema,
} from '../schemas/watchlist.schema.js';
import type { WatchlistRouteDeps } from './route-deps.js';
import { registerContractRoute } from './register-contract-route.js';
import { parseContractBody, sendRouteContractResponse } from './contract-response.js';
import {
  WatchlistCreateRouteContract,
  WatchlistDeleteRouteContract,
  WatchlistDeliveriesRouteContract,
  WatchlistGetRouteContract,
  WatchlistListRouteContract,
} from './route-contracts.js';
import { getRequestId } from '../request-id.js';

function createErrorResponse(requestId: string, code: string, message: string) {
  return WatchlistErrorResponseSchema.parse({
    error: {
      code,
      message,
      request_id: requestId,
    },
  });
}

function requireSubject(
  request: FastifyRequest,
  reply: FastifyReply,
  contract:
    | typeof WatchlistListRouteContract
    | typeof WatchlistCreateRouteContract
    | typeof WatchlistGetRouteContract
    | typeof WatchlistDeleteRouteContract
    | typeof WatchlistDeliveriesRouteContract,
): string | null {
  const subject = getAuthenticatedSubject(request);
  if (subject !== null) {
    return subject;
  }

  sendRouteContractResponse(
    request,
    reply,
    contract,
    401,
    createErrorResponse(
      getRequestId(request),
      'UNAUTHORIZED',
      'Missing authenticated subject header',
    ),
  );
  return null;
}

function toWatchlistEntryResponse(entry: WatchlistEntry) {
  return {
    watchlist_id: entry.id,
    user_id: entry.userId,
    entity_id: entry.entityId,
    trigger_conditions: entry.triggerConditions.map(toWatchlistTriggerResponse),
    callback_url: entry.callbackUrl,
    created_at: entry.createdAt.toISOString(),
    expires_at: entry.expiresAt ? entry.expiresAt.toISOString() : null,
  };
}

/**
 * Registers watchlist routes on the Fastify instance.
 */
export function registerWatchlistRoute(
  app: FastifyInstance,
  deps: WatchlistRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'GET',
    url: '/v1/watchlist',
    contract: WatchlistListRouteContract,
    handler: async (request, reply) => {
      const subject = requireSubject(request, reply, WatchlistListRouteContract);
      if (subject === null) {
        return;
      }

      try {
        const allEntries = await deps.watchlistService.listByUserId(subject);
        const queryParams = request.query as Record<string, unknown>;
        const limitParam = queryParams['limit'];
        const offsetParam = queryParams['offset'];
        const limit = Math.min(
          Math.max(1, Number(limitParam) || 50),
          200,
        );
        const offset = Math.max(0, Number(offsetParam) || 0);
        const entries = allEntries.slice(offset, offset + limit);
        const response = ListWatchlistResponseSchema.parse({
          entries: entries.map(toWatchlistEntryResponse),
          total: allEntries.length,
        });

        sendRouteContractResponse(request, reply, WatchlistListRouteContract, 200, response);
      } catch (err: unknown) {
        request.log.error({ err }, 'list_watchlist_failed');
        sendRouteContractResponse(
          request,
          reply,
          WatchlistListRouteContract,
          500,
          createErrorResponse(
            getRequestId(request),
            'INTERNAL_ERROR',
            'Failed to list watchlists',
          ),
        );
      }
    },
  });

  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/watchlist',
    contract: WatchlistCreateRouteContract,
    handler: async (request, reply) => {
      const subject = requireSubject(request, reply, WatchlistCreateRouteContract);
      if (subject === null) {
        return;
      }

      const body = parseContractBody(request, WatchlistCreateRouteContract);

      try {
        const entry = await deps.watchlistService.create({
          userId: subject,
          entityId: body.entity_id,
          triggerConditions: body.trigger_conditions,
          callbackUrl: body.callback_url,
          expiresAt: body.expires_at ? new Date(body.expires_at) : null,
        });

        const response = CreateWatchlistResponseSchema.parse({
          watchlist_id: entry.id,
        });

        sendRouteContractResponse(request, reply, WatchlistCreateRouteContract, 201, response);
      } catch (err: unknown) {
        request.log.error({ err }, 'create_watchlist_failed');
        sendRouteContractResponse(
          request,
          reply,
          WatchlistCreateRouteContract,
          500,
          createErrorResponse(
            getRequestId(request),
            'INTERNAL_ERROR',
            'Failed to create watchlist',
          ),
        );
      }
    },
  });

  registerContractRoute(app, {
    method: 'GET',
    url: '/v1/watchlist/:id',
    contract: WatchlistGetRouteContract,
    handler: async (request, reply) => {
      const subject = requireSubject(request, reply, WatchlistGetRouteContract);
      if (subject === null) {
        return;
      }

      const parsed = WatchlistGetRouteContract.params.safeParse(request.params);
      if (!parsed.success) {
        sendRouteContractResponse(
          request,
          reply,
          WatchlistGetRouteContract,
          400,
          createErrorResponse(
            getRequestId(request),
            'VALIDATION_ERROR',
            'Invalid watchlist id',
          ),
        );
        return;
      }

      try {
        const { id } = parsed.data;
        const entry = await deps.watchlistService.getByIdForUser({
          watchlistId: id,
          userId: subject,
        });

        if (entry === null) {
          sendRouteContractResponse(
            request,
            reply,
            WatchlistGetRouteContract,
            404,
            createErrorResponse(
              getRequestId(request),
              'NOT_FOUND',
              'Watchlist entry not found',
            ),
          );
          return;
        }

        sendRouteContractResponse(
          request,
          reply,
          WatchlistGetRouteContract,
          200,
          GetWatchlistResponseSchema.parse(toWatchlistEntryResponse(entry)),
        );
      } catch (err: unknown) {
        request.log.error({ err }, 'get_watchlist_failed');
        sendRouteContractResponse(
          request,
          reply,
          WatchlistGetRouteContract,
          500,
          createErrorResponse(
            getRequestId(request),
            'INTERNAL_ERROR',
            'Failed to retrieve watchlist',
          ),
        );
      }
    },
  });

  registerContractRoute(app, {
    method: 'DELETE',
    url: '/v1/watchlist/:id',
    contract: WatchlistDeleteRouteContract,
    handler: async (request, reply) => {
      const subject = requireSubject(request, reply, WatchlistDeleteRouteContract);
      if (subject === null) {
        return;
      }

      const parsed = WatchlistDeleteRouteContract.params.safeParse(request.params);
      if (!parsed.success) {
        sendRouteContractResponse(
          request,
          reply,
          WatchlistDeleteRouteContract,
          400,
          createErrorResponse(
            getRequestId(request),
            'VALIDATION_ERROR',
            'Invalid watchlist id',
          ),
        );
        return;
      }

      try {
        const { id } = parsed.data;
        const deleted = await deps.watchlistService.deleteForUser({
          watchlistId: id,
          userId: subject,
        });

        if (!deleted) {
          sendRouteContractResponse(
            request,
            reply,
            WatchlistDeleteRouteContract,
            404,
            createErrorResponse(
              getRequestId(request),
              'NOT_FOUND',
              'Watchlist entry not found',
            ),
          );
          return;
        }

        sendRouteContractResponse(request, reply, WatchlistDeleteRouteContract, 204);
      } catch (err: unknown) {
        request.log.error({ err }, 'delete_watchlist_failed');
        sendRouteContractResponse(
          request,
          reply,
          WatchlistDeleteRouteContract,
          500,
          createErrorResponse(
            getRequestId(request),
            'INTERNAL_ERROR',
            'Failed to delete watchlist',
          ),
        );
      }
    },
  });

  registerContractRoute(app, {
    method: 'GET',
    url: '/v1/watchlist/:id/deliveries',
    contract: WatchlistDeliveriesRouteContract,
    handler: async (request, reply) => {
      const subject = requireSubject(request, reply, WatchlistDeliveriesRouteContract);
      if (subject === null) {
        return;
      }

      const parsed = WatchlistDeliveriesRouteContract.params.safeParse(request.params);
      if (!parsed.success) {
        sendRouteContractResponse(
          request,
          reply,
          WatchlistDeliveriesRouteContract,
          400,
          createErrorResponse(
            getRequestId(request),
            'VALIDATION_ERROR',
            'Invalid watchlist id',
          ),
        );
        return;
      }

      try {
        const { id } = parsed.data;
        const deliveries = await deps.watchlistService.listDeliveries({
          watchlistId: id,
          userId: subject,
        });

        if (deliveries === null) {
          sendRouteContractResponse(
            request,
            reply,
            WatchlistDeliveriesRouteContract,
            404,
            createErrorResponse(
              getRequestId(request),
              'NOT_FOUND',
              'Watchlist entry not found',
            ),
          );
          return;
        }

        const dQueryParams = request.query as Record<string, unknown>;
        const dLimitParam = dQueryParams['limit'];
        const dOffsetParam = dQueryParams['offset'];
        const dLimit = Math.min(Math.max(1, Number(dLimitParam) || 50), 200);
        const dOffset = Math.max(0, Number(dOffsetParam) || 0);
        const pagedDeliveries = deliveries.slice(dOffset, dOffset + dLimit);
        const response = ListDeliveriesResponseSchema.parse({
          deliveries: pagedDeliveries.map((log: WatchlistDeliveryLogEntry) => ({
            id: log.id,
            watchlist_id: log.watchlistId,
            attempt: log.attempt,
            status_code: log.statusCode,
            error_message: log.errorMessage,
            delivered_at: log.deliveredAt.toISOString(),
          })),
          total: deliveries.length,
        });

        sendRouteContractResponse(request, reply, WatchlistDeliveriesRouteContract, 200, response);
      } catch (err: unknown) {
        request.log.error({ err }, 'list_watchlist_deliveries_failed');
        sendRouteContractResponse(
          request,
          reply,
          WatchlistDeliveriesRouteContract,
          500,
          createErrorResponse(
            getRequestId(request),
            'INTERNAL_ERROR',
            'Failed to list deliveries',
          ),
        );
      }
    },
  });
}
