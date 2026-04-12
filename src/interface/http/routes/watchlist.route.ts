/**
 * Subject-scoped watchlist routes.
 *
 * Trusted auth is supplied by `X-Authenticated-Subject`; route handlers never
 * accept caller-provided `user_id` and hide cross-user resources behind 404s.
 */

import { promises as dnsPromises } from 'node:dns';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
} from '../../../domain/watchlist/model/watchlist-entry.js';
import { isPrivateOrReservedIp } from '../../../infrastructure/watchlist/ssrf-guard.js';
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
import { toFiniteNumber } from '../../../domain/shared/utils/safe-number.js';
import { parseContractBody, sendRouteContractResponse } from './contract-response.js';
import {
  WatchlistCreateRouteContract,
  WatchlistDeleteRouteContract,
  WatchlistDeliveriesRouteContract,
  WatchlistGetRouteContract,
  WatchlistListRouteContract,
} from './route-contracts.js';
import { getRequestId } from '../request-id.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_CREATED,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_NO_CONTENT,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  WATCHLIST_OFFSET_MIN,
  WATCHLIST_PAGE_DEFAULT_LIMIT,
  WATCHLIST_PAGE_MAX_LIMIT,
  WATCHLIST_PAGE_MIN_LIMIT,
} from '../constants.js';

/**
 * Build a 5-field RFC-014 error envelope. Only used for enumerated 4xx
 * branches (validation, auth, user-input failures); 5xx paths must throw
 * to the central error-handler instead of fabricating their own envelope.
 */
function createErrorResponse(
  requestId: string,
  code: string,
  message: string,
  failureReason: string | null,
  retryable: boolean,
) {
  return WatchlistErrorResponseSchema.parse({
    error: {
      code,
      message,
      request_id: requestId,
      failure_reason: failureReason,
      retryable,
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
  // Guard empty-string subject: a misconfigured upstream proxy may send
  // X-Authenticated-Subject: "" which would pass the null check but route
  // all watchlist operations to the same empty-string user bucket.
  if (subject !== null && subject.length > 0) {
    return subject;
  }

  sendRouteContractResponse(
    request,
    reply,
    contract,
    HTTP_STATUS_UNAUTHORIZED,
    createErrorResponse(
      getRequestId(request),
      'UNAUTHORIZED',
      'Missing authenticated subject header',
      'missing_auth_subject',
      false,
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
        const rawLimit = toFiniteNumber(queryParams['limit']);
        const rawOffset = toFiniteNumber(queryParams['offset']);
        const limit = Math.min(
          Math.max(WATCHLIST_PAGE_MIN_LIMIT, rawLimit ?? WATCHLIST_PAGE_DEFAULT_LIMIT),
          WATCHLIST_PAGE_MAX_LIMIT,
        );
        const offset = Math.max(WATCHLIST_OFFSET_MIN, rawOffset ?? WATCHLIST_OFFSET_MIN);
        const entries = allEntries.slice(offset, offset + limit);
        const response = ListWatchlistResponseSchema.parse({
          entries: entries.map(toWatchlistEntryResponse),
          total: allEntries.length,
        });

        sendRouteContractResponse(
          request,
          reply,
          WatchlistListRouteContract,
          HTTP_STATUS_OK,
          response,
        );
      } catch (err: unknown) {
        // CLAUDE.md: do NOT fabricate a 200/500 envelope from unexpected
        // errors. Propagate to the central error-handler middleware which
        // emits the canonical RFC-014 envelope.
        request.log.error({ err }, 'list_watchlist_failed');
        throw err;
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

      // Defense-in-depth SSRF check at creation time (DNS rebinding mitigation).
      // webhook-delivery.ts re-checks at each delivery attempt; checking here prevents
      // storing a URL that will always fail and surfaces the error to the caller early.
      try {
        const parsedUrl = new URL(body.callback_url);
        if (parsedUrl.protocol !== 'https:') {
          sendRouteContractResponse(
            request,
            reply,
            WatchlistCreateRouteContract,
            HTTP_STATUS_BAD_REQUEST,
            createErrorResponse(
              getRequestId(request),
              'INVALID_CALLBACK_URL',
              'Callback URL must use https',
              'callback_scheme_not_https',
              false,
            ),
          );
          return;
        }
        const lookups = await dnsPromises.lookup(parsedUrl.hostname, { all: true });
        for (const { address } of lookups) {
          if (isPrivateOrReservedIp(address)) {
            sendRouteContractResponse(
              request,
              reply,
              WatchlistCreateRouteContract,
              HTTP_STATUS_BAD_REQUEST,
              createErrorResponse(
                getRequestId(request),
                'INVALID_CALLBACK_URL',
                'Callback host resolves to private/reserved IP',
                'callback_host_private_ip',
                false,
              ),
            );
            return;
          }
        }
      } catch (dnsErr: unknown) {
        if (dnsErr instanceof Error && dnsErr.message.startsWith('INVALID_CALLBACK_URL')) {
          // Already sent response above — do not fall through to the generic error handler.
          return;
        }
        const msg = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
        if (msg.includes('ENOTFOUND') || msg.includes('ENODATA') || msg.includes('EAI_')) {
          sendRouteContractResponse(
            request,
            reply,
            WatchlistCreateRouteContract,
            HTTP_STATUS_BAD_REQUEST,
            createErrorResponse(
              getRequestId(request),
              'INVALID_CALLBACK_URL',
              'Callback hostname could not be resolved',
              'callback_host_unresolved',
              false,
            ),
          );
          return;
        }
        // Unexpected DNS error — fall through to creation attempt
        request.log.warn({ err: dnsErr }, 'watchlist create: DNS preflight failed unexpectedly');
      }

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

        sendRouteContractResponse(
          request,
          reply,
          WatchlistCreateRouteContract,
          HTTP_STATUS_CREATED,
          response,
        );
      } catch (err: unknown) {
        request.log.error({ err }, 'create_watchlist_failed');
        throw err;
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
          HTTP_STATUS_BAD_REQUEST,
          createErrorResponse(
            getRequestId(request),
            'VALIDATION_ERROR',
            'Invalid watchlist id',
            'watchlist_id_invalid',
            false,
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
            HTTP_STATUS_NOT_FOUND,
            createErrorResponse(
              getRequestId(request),
              'NOT_FOUND',
              'Watchlist entry not found',
              null,
              false,
            ),
          );
          return;
        }

        sendRouteContractResponse(
          request,
          reply,
          WatchlistGetRouteContract,
          HTTP_STATUS_OK,
          GetWatchlistResponseSchema.parse(toWatchlistEntryResponse(entry)),
        );
      } catch (err: unknown) {
        request.log.error({ err }, 'get_watchlist_failed');
        throw err;
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
          HTTP_STATUS_BAD_REQUEST,
          createErrorResponse(
            getRequestId(request),
            'VALIDATION_ERROR',
            'Invalid watchlist id',
            'watchlist_id_invalid',
            false,
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
            HTTP_STATUS_NOT_FOUND,
            createErrorResponse(
              getRequestId(request),
              'NOT_FOUND',
              'Watchlist entry not found',
              null,
              false,
            ),
          );
          return;
        }

        sendRouteContractResponse(
          request,
          reply,
          WatchlistDeleteRouteContract,
          HTTP_STATUS_NO_CONTENT,
        );
      } catch (err: unknown) {
        request.log.error({ err }, 'delete_watchlist_failed');
        throw err;
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
          HTTP_STATUS_BAD_REQUEST,
          createErrorResponse(
            getRequestId(request),
            'VALIDATION_ERROR',
            'Invalid watchlist id',
            'watchlist_id_invalid',
            false,
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
            HTTP_STATUS_NOT_FOUND,
            createErrorResponse(
              getRequestId(request),
              'NOT_FOUND',
              'Watchlist entry not found',
              null,
              false,
            ),
          );
          return;
        }

        const dQueryParams = request.query as Record<string, unknown>;
        const rawDLimit = toFiniteNumber(dQueryParams['limit']);
        const rawDOffset = toFiniteNumber(dQueryParams['offset']);
        const dLimit = Math.min(
          Math.max(WATCHLIST_PAGE_MIN_LIMIT, rawDLimit ?? WATCHLIST_PAGE_DEFAULT_LIMIT),
          WATCHLIST_PAGE_MAX_LIMIT,
        );
        const dOffset = Math.max(WATCHLIST_OFFSET_MIN, rawDOffset ?? WATCHLIST_OFFSET_MIN);
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

        sendRouteContractResponse(
          request,
          reply,
          WatchlistDeliveriesRouteContract,
          HTTP_STATUS_OK,
          response,
        );
      } catch (err: unknown) {
        request.log.error({ err }, 'list_watchlist_deliveries_failed');
        throw err;
      }
    },
  });
}
