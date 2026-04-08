import type { FastifyInstance } from 'fastify';

/**
 * Augment Fastify request with a typed request_id property.
 */
declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startTime: number;
    /**
     * True when `HTTP_DEBUG_SECRET` is set and `X-Debug-Key` matched (see `registerHttpDebugMode`).
     */
    debugRequest: boolean;
  }
}

/**
 * Registers a Fastify hook that:
 * 1. Copies `request.id` (from Fastify `genReqId`, see server) to `request.requestId`
 * 2. Sets the X-Request-Id response header
 * 3. Logs request start/end with latency
 */
/**
 * Returns the route template (e.g. `/v1/watchlist/:id`) when available, or
 * the URL path WITHOUT query string. We never log raw `request.url` because
 * it can carry user PII (search params, tokens) into structured logs.
 *
 * Fastify exposes the route template differently across versions:
 * - v3: `request.routerPath`
 * - v4: `request.routeOptions.url` (routerPath still works as alias)
 * - v5: `request.routeOptions.url` (routerPath removed)
 *
 * Without the v4/v5 path, every log line falls back to a path-with-IDs string,
 * silently leaking IDs into observability and inflating log cardinality.
 */
function safeRoutePath(request: {
  url: string;
  routerPath?: string | undefined;
  routeOptions?: { url?: string | undefined } | undefined;
}): string {
  const fromRouteOptions = request.routeOptions?.url;
  if (typeof fromRouteOptions === 'string' && fromRouteOptions.length > 0) {
    return fromRouteOptions;
  }
  if (typeof request.routerPath === 'string' && request.routerPath.length > 0) {
    return request.routerPath;
  }
  // Strip query string from raw URL as a last-resort fallback. The path may
  // still contain user IDs, but at least query strings (tokens, secrets) are
  // never logged.
  const url = request.url;
  const qIndex = url.indexOf('?');
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const requestId = request.id;
    request.requestId = requestId;
    request.startTime = Date.now();

    reply.header('X-Request-Id', requestId);

    request.log.info(
      { requestId, method: request.method, route: safeRoutePath(request) },
      'request_start',
    );
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const latencyMs = Date.now() - request.startTime;

    request.log.info(
      {
        requestId: request.requestId,
        method: request.method,
        route: safeRoutePath(request),
        statusCode: reply.statusCode,
        latencyMs,
      },
      'request_end',
    );
    done();
  });
}
