import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { type Span, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { getTracer } from '../../infrastructure/telemetry/tracer.js';
import { registerHttpDebugMode } from './middleware/http-debug-mode.js';
import { registerRequestContext } from './middleware/request-context.js';
import { errorHandler } from './middleware/error-handler.js';
import { deepKeysToSnake } from './middleware/snake-case-hook.js';
import { registerSearchRoute } from './routes/search.route.js';
import { registerBatchSearchRoute } from './routes/batch-search.route.js';
import { registerReplayRoute } from './routes/replay.route.js';
import { registerInterpretRoute } from './routes/interpret.route.js';
import { registerResolveRoute } from './routes/resolve.route.js';
import { registerHybridRoute } from './routes/hybrid.route.js';
import {
  registerSearchV2Route,
  registerHybridV2Route,
  registerInterpretV2Route,
} from './routes/search-v2.route.js';
import {
  registerHealthRoutes,
  type HealthRouteOptions,
} from './routes/health.route.js';
import { registerClaudeToolsRoute } from './routes/claude-tools.route.js';
import { registerWatchlistRoute } from './routes/watchlist.route.js';
import { registerFeedbackRoute } from './routes/feedback.route.js';
import { registerOpenApiRoute } from './routes/openapi.route.js';
import type { HttpServerDeps } from './routes/route-deps.js';
import { getRequestId, resolveIncomingRequestId } from './request-id.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { EvalRunnerContract } from '../../config/container-eval-contracts.js';
import { runEvaluation } from '../../infrastructure/eval/eval-initializer.js';

const serverLog = bootstrapLogger.child({ component: 'HttpServer' });

declare module 'fastify' {
  interface FastifyRequest {
    otelSpan?: Span;
  }
}

/**
 * Options for creating the Fastify server.
 */
export interface ServerOptions {
  readonly logLevel?: string;
  readonly nodeEnv?: 'development' | 'production' | 'test';
  readonly rateLimitMax?: number;
  readonly corsAllowedOrigins?: string;
  readonly runEvalAtStartup?: boolean;
  readonly health?: HealthRouteOptions;
  readonly enableCors?: boolean;
  readonly enableTelemetry?: boolean;
  readonly tracer?: Tracer;
  /**
   * When true, trust `X-Forwarded-For` / `X-Forwarded-Host` (reverse proxy in front).
   * @default false
   */
  readonly trustProxy?: boolean;
  /** Fastify JSON body size cap in bytes. @default 1_048_576 */
  readonly bodyLimitBytes?: number;
  /** Register `@fastify/helmet` (CSP disabled for JSON API). @default true */
  readonly enableSecurityHeaders?: boolean;
  /**
   * When set, requests with matching `X-Debug-Key` get per-request log level `debug`.
   * @see registerHttpDebugMode
   */
  readonly httpDebugSecret?: string | undefined;
}

async function registerCorsSupport(
  app: FastifyInstance,
  options: {
    readonly nodeEnv: 'development' | 'production' | 'test';
    readonly allowedOrigins: string;
  },
): Promise<void> {
  const originList = options.allowedOrigins
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  await app.register(cors, {
    hook: 'preHandler',
    origin(origin, callback) {
      if (options.nodeEnv !== 'production') {
        callback(null, true);
        return;
      }

      // Requests without an Origin header (server-to-server, curl, load-balancer
      // health checks) are not browser CORS requests.  Allow them through
      // unconditionally; CORS headers simply won't be set, which is correct.
      if (origin === undefined) {
        callback(null, true);
        return;
      }

      callback(null, originList.includes(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Correlation-Id',
      'X-Debug-Key',
    ],
    exposedHeaders: ['X-Request-Id', 'X-Debug-Active', 'Retry-After'],
    maxAge: 86400,
    strictPreflight: false,
  });
}

function registerTelemetryHooks(app: FastifyInstance, tracer: Tracer): void {
  // NOTE: this hook runs after registerRequestContext so request.requestId is
  // already populated. If it were registered before registerRequestContext we
  // would have to fall back to request.id (which Fastify always sets via
  // genReqId before any onRequest hook runs).
  app.addHook('onRequest', (request, _reply, done) => {
    const spanName = `${request.method} ${request.url}`;
    const span = tracer.startSpan(spanName, {
      attributes: {
        'http.method': request.method,
        'http.url': request.url,
        // request.id is always present (set by Fastify genReqId before hooks).
        // request.requestId is an alias populated by registerRequestContext; use
        // request.id as the canonical source so this hook is order-independent.
        'request.id': request.id,
      },
    });
    request.otelSpan = span;
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const { otelSpan } = request;
    if (otelSpan !== undefined) {
      otelSpan.setAttribute('http.status_code', reply.statusCode);
      if (reply.statusCode >= 500) {
        otelSpan.setStatus({ code: SpanStatusCode.ERROR });
      }
      otelSpan.end();
    }
    done();
  });
}

/**
 * Creates and configures a Fastify server instance.
 *
 * - Registers pino logger
 * - Registers request context middleware (request_id, latency)
 * - Registers rate limiting (RFC-014 §13)
 * - Enforces Content-Type: application/json on POST requests
 * - Registers global error handler (RFC-014 error contract)
 * - Registers all API routes
 * - Configures graceful shutdown
 *
 * @param deps - The wired HTTP dependencies.
 * @param options - Optional server configuration.
 * @returns The configured Fastify instance (not yet listening).
 */
export async function createServer(
  deps: HttpServerDeps,
  options?: ServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options?.logLevel ?? 'info',
    },
    genReqId: (req) => resolveIncomingRequestId(req.headers),
    trustProxy: options?.trustProxy ?? false,
    bodyLimit: options?.bodyLimitBytes ?? 1_048_576,
    // Close idle keep-alive connections when server.close() is called so that
    // the process can exit cleanly during graceful shutdown (SIGTERM/SIGINT).
    // Without this, open keep-alive connections with no active request prevent
    // the server from finishing its close sequence, causing a hang or forceful
    // kill.  'idle' only affects connections with no in-flight request;
    // connections that are mid-request are drained normally.
    forceCloseConnections: 'idle',
  });

  if (options?.enableSecurityHeaders ?? true) {
    await app.register(helmet, {
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    });
  }

  // CORS headers (G-46).
  // In development/test: allow all origins, echoing the request origin when present.
  // In production: restrict to CORS_ALLOWED_ORIGINS env var.
  // Uses a manual hook instead of @fastify/cors to avoid an extra dependency.
  const nodeEnv = options?.nodeEnv ?? 'development';
  const allowedOrigins = options?.corsAllowedOrigins ?? '';
  if (options?.enableCors ?? true) {
    await registerCorsSupport(app, { nodeEnv, allowedOrigins });
  }

  // Register middleware (debug mode first so request_start uses per-request log level)
  registerHttpDebugMode(app, { secret: options?.httpDebugSecret });
  registerRequestContext(app);

  if (options?.enableTelemetry ?? true) {
    registerTelemetryHooks(app, options?.tracer ?? getTracer());
  }

  // Register rate limiting — RFC-014 §13
  // errorResponseBuilder is intentionally omitted: in @fastify/rate-limit v10 it replaces the
  // thrown error object, stripping statusCode and causing setErrorHandler to see an unknown
  // object and fall back to 500. The 429 branch is handled in the global error handler instead.
  //
  // Key strategy: prefer x-authenticated-subject (the API-key principal set by the upstream
  // proxy) over raw IP.  IP-only keying is bypassable via IPv6 rotation; principal-based
  // keying enforces the limit per identity even when an attacker cycles source addresses.
  // Fall back to IP when no authenticated subject header is present (unauthenticated paths).
  if ((options?.rateLimitMax ?? 100) > 0) {
    await app.register(rateLimit, {
      max: options?.rateLimitMax ?? 100,
      timeWindow: '1 minute',
      keyGenerator(request) {
        const subject = request.headers['x-authenticated-subject'];
        const subjectStr = Array.isArray(subject) ? subject[0] : subject;
        if (subjectStr !== undefined && subjectStr.trim().length > 0) {
          return `subject:${subjectStr.trim()}`;
        }
        // Fall back to IP (works with trustProxy: the right IP is already resolved).
        return request.ip;
      },
    });
  }

  // Enforce Content-Type: application/json on all POST requests.
  // Must run in preParsing (before the body parser) so that missing or
  // wrong Content-Type headers never reach the JSON parser and cause a 500.
  // RFC 2046: media types are case-insensitive, so we lowercase before checking.
  //
  // We extract the media-type token (the part before the first semicolon) and
  // compare it exactly to 'application/json'.  This correctly:
  //   - accepts   "application/json"
  //   - accepts   "application/json; charset=utf-8"
  //   - rejects   "text/plain"
  //   - rejects   "not-application/json"   (would pass a naive .includes() check)
  app.addHook('preParsing', async (request, reply) => {
    if (request.method === 'POST') {
      const rawCt = request.headers['content-type'] ?? '';
      const mediaType = rawCt.split(';')[0]?.trim().toLowerCase() ?? '';
      if (mediaType !== 'application/json') {
        const requestId = getRequestId(request);
        await reply.status(415).send({
          error: {
            request_id: requestId,
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message:
              'Content-Type must be application/json for POST requests.',
            failure_reason: null,
            retryable: false,
          },
        });
        return;
      }
    }
  });

  // Convert all response body keys from camelCase to snake_case (RFC-014 §4.2).
  // Applied once at the serialization boundary so domain objects can use
  // TypeScript-idiomatic camelCase while external consumers receive snake_case.
  app.addHook('preSerialization', async (_request, _reply, payload) => {
    return deepKeysToSnake(payload);
  });

  // Register global error handler
  app.setErrorHandler(errorHandler);

  // Register routes
  registerHealthRoutes(app, options?.health);
  registerClaudeToolsRoute(app, deps);
  registerSearchRoute(app, deps);
  registerBatchSearchRoute(app, deps);
  registerReplayRoute(app, deps);
  registerInterpretRoute(app, deps);
  registerResolveRoute(app, deps);
  registerHybridRoute(app, deps);
  registerWatchlistRoute(app, deps);
  registerFeedbackRoute(app, deps);
  registerSearchV2Route(app, deps);
  registerHybridV2Route(app, deps);
  registerInterpretV2Route(app, deps);
  registerOpenApiRoute(app);

  // Epic 3: Optional evaluation run at startup (fire-and-forget)
  // Runs when env var EVAL_RUN_AT_STARTUP=true (requires Postgres)
  // MUST NOT block server readiness — eval can take minutes on large gold sets.
  if (options?.runEvalAtStartup === true) {
    if (deps.evalRunner) {
      const evalRunnerRef: EvalRunnerContract = deps.evalRunner;
      app.addHook('onReady', () => {
        const evalStart = Date.now();
        serverLog.warn('starting background evaluation per EVAL_RUN_AT_STARTUP');
        void runEvaluation(evalRunnerRef, { verbose: true }).then(
          (result) => {
            const durationMs = Date.now() - evalStart;
            serverLog.warn(
              { durationMs, message: result.message },
              'background evaluation completed',
            );
          },
          (err: unknown) => {
            const durationMs = Date.now() - evalStart;
            serverLog.error(
              { err, durationMs },
              'background evaluation failed',
            );
          },
        );
      });
    } else {
      serverLog.warn(
        'EVAL_RUN_AT_STARTUP=true but evalRunner not available; skipping',
      );
    }
  }

  return app;
}
