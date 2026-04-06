/**
 * Epic 17.1: Watchlist HTTP Routes
 *
 * Endpoints for watchlist CRUD:
 * - POST /v1/watchlist — Create entry
 * - DELETE /v1/watchlist/:id — Delete entry
 * - GET /v1/watchlist/:id/deliveries — List delivery logs
 */

import { type FastifyInstance } from 'fastify';
import type {
  WatchlistDeliveryLogEntry,
} from '../../../domain/watchlist/model/watchlist-entry.js';
import { toWatchlistTriggerResponse } from '../../../domain/watchlist/service/watchlist-policy.js';
import {
  CreateWatchlistResponseSchema,
  GetWatchlistResponseSchema,
  ListDeliveriesResponseSchema,
  WatchlistErrorResponseSchema,
} from '../schemas/watchlist.schema.js';
import type { WatchlistRouteDeps } from './route-deps.js';
import { registerContractRoute } from './register-contract-route.js';
import { sendRouteContractResponse } from './contract-response.js';
import {
  WatchlistCreateRouteContract,
  WatchlistDeleteRouteContract,
  WatchlistDeliveriesRouteContract,
  WatchlistGetRouteContract,
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

/**
 * Registers watchlist routes on the Fastify instance.
 */
export function registerWatchlistRoute(
  app: FastifyInstance,
  deps: WatchlistRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/watchlist',
    contract: WatchlistCreateRouteContract,
    handler: async (request, reply) => {
      const parsed = WatchlistCreateRouteContract.body.safeParse(request.body);
      if (!parsed.success) {
        sendRouteContractResponse(
          request,
          reply,
          WatchlistCreateRouteContract,
          400,
          createErrorResponse(
            getRequestId(request),
            'VALIDATION_ERROR',
            'Invalid watchlist request',
          ),
        );
        return;
      }

      try {
        const entry = await deps.watchlistService.create({
          userId: parsed.data.user_id,
          entityId: parsed.data.entity_id,
          triggerConditions: parsed.data.trigger_conditions,
          callbackUrl: parsed.data.callback_url,
          expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
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
        const entry = await deps.watchlistService.getById(id);

        if (entry === null) {
          sendRouteContractResponse(
            request,
            reply,
            WatchlistGetRouteContract,
            404,
            createErrorResponse(
              getRequestId(request),
              'NOT_FOUND',
              `Watchlist entry ${id} not found`,
            ),
          );
          return;
        }

        const response = GetWatchlistResponseSchema.parse({
          watchlist_id: entry.id,
          user_id: entry.userId,
          entity_id: entry.entityId,
          trigger_conditions: entry.triggerConditions.map(toWatchlistTriggerResponse),
          callback_url: entry.callbackUrl,
          created_at: entry.createdAt.toISOString(),
          expires_at: entry.expiresAt ? entry.expiresAt.toISOString() : null,
        });

        sendRouteContractResponse(request, reply, WatchlistGetRouteContract, 200, response);
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
      const deleted = await deps.watchlistService.delete(id);

      if (!deleted) {
        sendRouteContractResponse(
          request,
          reply,
          WatchlistDeleteRouteContract,
          404,
          createErrorResponse(
            getRequestId(request),
            'NOT_FOUND',
            `Watchlist entry ${id} not found`,
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
      const deliveries = await deps.watchlistService.listDeliveries(id);

      if (deliveries === null) {
        sendRouteContractResponse(
          request,
          reply,
          WatchlistDeliveriesRouteContract,
          404,
          createErrorResponse(
            getRequestId(request),
            'NOT_FOUND',
            `Watchlist entry ${id} not found`,
          ),
        );
        return;
      }

      const response = ListDeliveriesResponseSchema.parse({
        deliveries: deliveries.map((log: WatchlistDeliveryLogEntry) => ({
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
