/**
 * Epic 17.1: Watchlist HTTP Routes
 *
 * Endpoints for watchlist CRUD:
 * - POST /v1/watchlist — Create entry
 * - DELETE /v1/watchlist/:id — Delete entry
 * - GET /v1/watchlist/:id/deliveries — List delivery logs
 */

import { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { nanoid } from 'nanoid';
import {
  CreateWatchlistRequestSchema,
  ListDeliveriesResponseSchema,
} from '../schemas/watchlist.schema.js';
import type { WatchlistEntry, WatchlistTrigger } from '../../../domain/watchlist/model/watchlist-entry.js';

/**
 * In-memory store for watchlist entries (v0.1; replace with DB in production).
 * Maps: watchlist_id → WatchlistEntry
 */
const watchlistStore = new Map<string, WatchlistEntry>();

/**
 * In-memory delivery log store (v0.1; replace with DB in production).
 * Maps: watchlist_id → array of logs
 */
const deliveryLogStore = new Map<string, Array<{
  id: string;
  watchlist_id: string;
  attempt: number;
  status_code: number | null;
  error_message: string | null;
  delivered_at: Date;
}>>();

/**
 * Registers watchlist routes on the Fastify instance.
 *
 * @param app - Fastify app instance.
 */
export function registerWatchlistRoute(app: FastifyInstance): void {
  /**
   * POST /v1/watchlist — Create a new watchlist entry.
   * Returns 201 with { watchlist_id }.
   */
  app.post('/v1/watchlist', async (request, reply) => {
    try {
      const parsed = CreateWatchlistRequestSchema.parse(request.body);
      const watchlistId = nanoid();

      const entry: WatchlistEntry = {
        id: watchlistId,
        userId: parsed.user_id,
        entityId: parsed.entity_id,
        triggerConditions: parsed.trigger_conditions as readonly WatchlistTrigger[],
        callbackUrl: parsed.callback_url,
        createdAt: new Date(),
        expiresAt: parsed.expires_at ? new Date(parsed.expires_at) : null,
      };

      watchlistStore.set(watchlistId, entry);
      deliveryLogStore.set(watchlistId, []);

      void reply.status(201).send({ watchlist_id: watchlistId });
    } catch (err: unknown) {
      if (err instanceof ZodError) {
        void reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: err.errors,
          },
        });
        return;
      }

      console.error('Create watchlist error:', err);
      void reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to create watchlist',
        },
      });
    }
  });

  /**
   * GET /v1/watchlist/:id — Retrieve watchlist entry.
   * Returns 200 with full entry, or 404 if not found.
   */
  app.get<{ Params: { id: string } }>('/v1/watchlist/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const entry = watchlistStore.get(id);

      if (!entry) {
        void reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Watchlist entry ${id} not found`,
          },
        });
        return;
      }

      const response = {
        id: entry.id,
        user_id: entry.userId,
        entity_id: entry.entityId,
        trigger_conditions: entry.triggerConditions,
        callback_url: entry.callbackUrl,
        created_at: entry.createdAt.toISOString(),
        expires_at: entry.expiresAt ? entry.expiresAt.toISOString() : null,
      };

      void reply.status(200).send(response);
    } catch (err: unknown) {
      console.error('Get watchlist error:', err);
      void reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to retrieve watchlist',
        },
      });
    }
  });

  /**
   * DELETE /v1/watchlist/:id — Delete watchlist entry.
   * Returns 204 No Content on success, 404 if not found.
   */
  app.delete<{ Params: { id: string } }>('/v1/watchlist/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      if (!watchlistStore.has(id)) {
        void reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Watchlist entry ${id} not found`,
          },
        });
        return;
      }

      watchlistStore.delete(id);
      deliveryLogStore.delete(id);

      void reply.status(204).send();
    } catch (err: unknown) {
      console.error('Delete watchlist error:', err);
      void reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to delete watchlist',
        },
      });
    }
  });

  /**
   * GET /v1/watchlist/:id/deliveries — List delivery logs.
   * Returns 200 with { deliveries: [], total }.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/watchlist/:id/deliveries',
    async (request, reply) => {
      try {
        const { id } = request.params;

        if (!watchlistStore.has(id)) {
          void reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: `Watchlist entry ${id} not found`,
            },
          });
          return;
        }

        const logs = deliveryLogStore.get(id) ?? [];
        const deliveries = logs.map((log) => ({
          id: log.id,
          watchlist_id: log.watchlist_id,
          attempt: log.attempt,
          status_code: log.status_code,
          error_message: log.error_message,
          delivered_at: log.delivered_at.toISOString(),
        }));

        const response = ListDeliveriesResponseSchema.parse({
          deliveries,
          total: deliveries.length,
        });

        void reply.status(200).send(response);
      } catch (err: unknown) {
        console.error('List deliveries error:', err);
        void reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to list deliveries',
          },
        });
      }
    },
  );
}

/**
 * Adds a delivery log entry for a watchlist event.
 * (Exposed for testing and integration.)
 */
export function recordDeliveryLog(
  watchlistId: string,
  attempt: number,
  statusCode: number | null,
  errorMessage: string | null,
): void {
  const logs = deliveryLogStore.get(watchlistId) ?? [];
  logs.push({
    id: nanoid(),
    watchlist_id: watchlistId,
    attempt,
    status_code: statusCode,
    error_message: errorMessage,
    delivered_at: new Date(),
  });
  deliveryLogStore.set(watchlistId, logs);
}

/**
 * Retrieves a watchlist entry by ID (for testing).
 */
export function getWatchlistEntry(id: string): WatchlistEntry | undefined {
  return watchlistStore.get(id);
}

/**
 * Clears all in-memory stores (for testing).
 */
export function clearWatchlistStores(): void {
  watchlistStore.clear();
  deliveryLogStore.clear();
}
