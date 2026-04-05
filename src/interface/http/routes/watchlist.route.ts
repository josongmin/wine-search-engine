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
  WatchlistTrigger,
} from '../../../domain/watchlist/model/watchlist-entry.js';
import {
  CreateWatchlistRequestSchema,
  CreateWatchlistResponseSchema,
  GetWatchlistResponseSchema,
  ListDeliveriesResponseSchema,
  WatchlistErrorResponseSchema,
  WatchlistIdParamsSchema,
  type WatchlistTriggerResponse,
} from '../schemas/watchlist.schema.js';
import type { WatchlistRouteDeps } from './route-deps.js';
import { sendContractResponse, sendRouteContractResponse } from './contract-response.js';
import {
  WatchlistCreateRouteContract,
  WatchlistDeleteRouteContract,
  WatchlistDeliveriesRouteContract,
  WatchlistGetRouteContract,
} from './route-contracts.js';

function getRequestId(request: { requestId?: string; id: string }): string {
  return request.requestId ?? request.id;
}

function createErrorResponse(requestId: string, code: string, message: string) {
  return WatchlistErrorResponseSchema.parse({
    error: {
      code,
      message,
      request_id: requestId,
    },
  });
}

function toTriggerResponse(trigger: WatchlistTrigger): WatchlistTriggerResponse {
  switch (trigger.type) {
    case 'new_vintage':
      return {
        type: trigger.type,
        min_vintage: trigger.minVintage,
      };
    case 'price_drop':
      return {
        type: trigger.type,
        threshold: trigger.threshold,
        baseline_price: trigger.baselinePrice,
      };
    case 'stock_available':
      return {
        type: trigger.type,
        min_qty: trigger.minQty,
      };
    case 'critic_score_above':
      return {
        type: trigger.type,
        threshold: trigger.threshold,
      };
  }
}

/**
 * Registers watchlist routes on the Fastify instance.
 */
export function registerWatchlistRoute(
  app: FastifyInstance,
  deps: WatchlistRouteDeps,
): void {
  app.post('/v1/watchlist', async (request, reply) => {
    const parsed = WatchlistCreateRouteContract.body.safeParse(request.body);
    if (!parsed.success) {
      sendContractResponse(
        request,
        reply,
        400,
        WatchlistErrorResponseSchema,
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
      sendContractResponse(
        request,
        reply,
        500,
        WatchlistErrorResponseSchema,
        createErrorResponse(
          getRequestId(request),
          'INTERNAL_ERROR',
          'Failed to create watchlist',
        ),
      );
    }
  });

  app.get('/v1/watchlist/:id', async (request, reply) => {
    const parsed = WatchlistGetRouteContract.params.safeParse(request.params);
    if (!parsed.success) {
      sendContractResponse(
        request,
        reply,
        400,
        WatchlistErrorResponseSchema,
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
        sendContractResponse(
          request,
          reply,
          404,
          WatchlistErrorResponseSchema,
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
        trigger_conditions: entry.triggerConditions.map(toTriggerResponse),
        callback_url: entry.callbackUrl,
        created_at: entry.createdAt.toISOString(),
        expires_at: entry.expiresAt ? entry.expiresAt.toISOString() : null,
      });

      sendRouteContractResponse(request, reply, WatchlistGetRouteContract, 200, response);
    } catch (err: unknown) {
      request.log.error({ err }, 'get_watchlist_failed');
      sendContractResponse(
        request,
        reply,
        500,
        WatchlistErrorResponseSchema,
        createErrorResponse(
          getRequestId(request),
          'INTERNAL_ERROR',
          'Failed to retrieve watchlist',
        ),
      );
    }
  });

  app.delete('/v1/watchlist/:id', async (request, reply) => {
    const parsed = WatchlistDeleteRouteContract.params.safeParse(request.params);
    if (!parsed.success) {
      sendContractResponse(
        request,
        reply,
        400,
        WatchlistErrorResponseSchema,
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
        sendContractResponse(
          request,
          reply,
          404,
          WatchlistErrorResponseSchema,
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
      sendContractResponse(
        request,
        reply,
        500,
        WatchlistErrorResponseSchema,
        createErrorResponse(
          getRequestId(request),
          'INTERNAL_ERROR',
          'Failed to delete watchlist',
        ),
      );
    }
  });

  app.get('/v1/watchlist/:id/deliveries', async (request, reply) => {
    const parsed = WatchlistDeliveriesRouteContract.params.safeParse(request.params);
    if (!parsed.success) {
      sendContractResponse(
        request,
        reply,
        400,
        WatchlistErrorResponseSchema,
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
        sendContractResponse(
          request,
          reply,
          404,
          WatchlistErrorResponseSchema,
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
      sendContractResponse(
        request,
        reply,
        500,
        WatchlistErrorResponseSchema,
        createErrorResponse(
          getRequestId(request),
          'INTERNAL_ERROR',
          'Failed to list deliveries',
        ),
      );
    }
  });
}
