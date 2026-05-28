import type { FastifyInstance } from 'fastify';
import '../fastify-augmentations.js';

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
/**
 * Operational probe routes that are polled at high frequency by load balancers,
 * orchestrators (k8s liveness/readiness), and metrics scrapers. Logging two
 * `info` lines (request_start + request_end) per poll floods structured logs
 * and inflates log-volume cost without observability value (R6 H7). For these
 * routes we drop the routine start/end lines to `debug`; genuine failures
 * (5xx) are still surfaced at `warn` regardless of route.
 *
 * Matched against `safeRoutePath` (route template, query-stripped) so it is
 * stable across Fastify versions and never depends on raw user input.
 */
const OPS_ROUTE_EXACT: ReadonlySet<string> = new Set(['/health', '/ready']);
const OPS_ROUTE_PREFIXES: readonly string[] = ['/metrics/'];

/** HTTP status at/above which a response is treated as a server-side failure. */
const SERVER_ERROR_STATUS_THRESHOLD = 500;

export function isOpsRoute(route: string): boolean {
  if (OPS_ROUTE_EXACT.has(route)) {
    return true;
  }
  for (const prefix of OPS_ROUTE_PREFIXES) {
    if (route.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

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

    const route = safeRoutePath(request);
    const startFields = { requestId, method: request.method, route };
    // High-frequency probe routes log at debug to avoid flooding (R6 H7).
    if (isOpsRoute(route)) {
      request.log.debug(startFields, 'request_start');
    } else {
      request.log.info(startFields, 'request_start');
    }
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const latencyMs = Date.now() - request.startTime;
    const route = safeRoutePath(request);
    const endFields = {
      requestId: request.requestId,
      method: request.method,
      route,
      statusCode: reply.statusCode,
      latencyMs,
    };
    // Server-side failures always surface at warn, regardless of route.
    // Routine ops-probe traffic drops to debug; everything else stays at info.
    if (reply.statusCode >= SERVER_ERROR_STATUS_THRESHOLD) {
      request.log.warn(endFields, 'request_end');
    } else if (isOpsRoute(route)) {
      request.log.debug(endFields, 'request_end');
    } else {
      request.log.info(endFields, 'request_end');
    }
    done();
  });
}
