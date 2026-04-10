import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  context as otelContext,
  trace,
  type Span,
  SpanStatusCode,
  type Tracer,
} from '@opentelemetry/api';
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
  registerHealthRoutes,
  startEventLoopHeartbeat,
  type HealthRouteOptions,
} from './routes/health.route.js';
import { registerClaudeToolsRoute } from './routes/claude-tools.route.js';
import { registerWatchlistRoute } from './routes/watchlist.route.js';
import { registerFeedbackRoute } from './routes/feedback.route.js';
import { registerAgentRoute } from './routes/agent.route.js';
import { registerAgentBenchmarkScenariosRoute } from './routes/agent-benchmark-scenarios.route.js';
import { registerOpenApiRoute } from './routes/openapi.route.js';
import type { HttpServerDeps } from './routes/route-deps.js';
import { getRequestId, resolveIncomingRequestId } from './request-id.js';
import { getAuthenticatedSubject, configureAuthenticatedSubjectTrust } from './authenticated-subject.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { EvalRunnerContract } from '../../config/container-eval-contracts.js';
import { runEvaluation } from '../../infrastructure/eval/eval-initializer.js';
import {
  CORS_PREFLIGHT_MAX_AGE_SECONDS,
  HTTP_DEFAULT_BODY_LIMIT_BYTES,
  HTTP_DEFAULT_CONNECTION_TIMEOUT_MS,
  HTTP_DEFAULT_REQUEST_TIMEOUT_MS,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
} from './constants.js';

const serverLog = bootstrapLogger.child({ component: 'HttpServer' });

declare module 'fastify' {
  interface FastifyRequest {
    otelSpan?: Span;
  }
  interface FastifyReply {
    snakeCaseApplied?: boolean;
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
  /**
   * Maximum time (ms) to wait for a TCP connection to be established before closing it.
   * @default 10000
   */
  readonly connectionTimeout?: number;
  /**
   * Maximum time (ms) to process a request before responding with a 503.
   * @default 30000
   */
  readonly requestTimeout?: number;
  /**
   * Expose GET /v1/agent/benchmark-scenarios (quick-profile scenario list for web lab).
   * When omitted, enabled for non-production NODE_ENV.
   */
  readonly enableAgentBenchmarkUi?: boolean;
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

  // Localhost-only allowlist for non-production: prevents arbitrary cross-origin
  // pages from making credentialed requests against a developer machine.
  const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

  await app.register(cors, {
    hook: 'preHandler',
    origin(origin, callback) {
      // Requests without an Origin header (server-to-server, curl, load-balancer
      // health checks) are not browser CORS requests.  Allow them through
      // unconditionally; CORS headers simply won't be set, which is correct.
      if (origin === undefined) {
        callback(null, true);
        return;
      }

      if (options.nodeEnv !== 'production') {
        // Only reflect localhost origins in dev/test to prevent staging XSS exfil.
        callback(null, LOCALHOST_ORIGIN_RE.test(origin));
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
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
    strictPreflight: true,
  });
}

function registerTelemetryHooks(app: FastifyInstance, tracer: Tracer): void {
  // NOTE: this hook runs after registerRequestContext so request.requestId is
  // already populated. If it were registered before registerRequestContext we
  // would have to fall back to request.id (which Fastify always sets via
  // genReqId before any onRequest hook runs).
  //
  // OTEL context propagation:
  //   1. Create the HTTP span with `tracer.startSpan` (not startActiveSpan) —
  //      we need to end it manually in the onResponse hook.
  //   2. Derive a Context with the span installed via `trace.setSpan`.
  //   3. Invoke `done()` INSIDE `otelContext.with(ctx, done)` so the rest of
  //      the request lifecycle (preHandler → handler → onResponse) inherits the
  //      context through Node's AsyncLocalStorage-backed context manager
  //      (sdk-node installs AsyncHooksContextManager by default, which tracks
  //      async_hooks init events and propagates context across await points).
  //   4. Child spans created inside handlers via `tracer.startActiveSpan` will
  //      find the HTTP span as `trace.getActiveSpan()` and parent to it.
  //
  // Without step 3 the HTTP span exists but is not in the active context, so
  // the GenAI spans created in src/infrastructure/telemetry/gen-ai-tracing.ts
  // become orphan root spans instead of children of the HTTP request.
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
    const ctx = trace.setSpan(otelContext.active(), span);
    otelContext.with(ctx, done);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const { otelSpan } = request;
    if (otelSpan !== undefined) {
      otelSpan.setAttribute('http.status_code', reply.statusCode);
      if (reply.statusCode >= HTTP_STATUS_INTERNAL_SERVER_ERROR) {
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
    bodyLimit: options?.bodyLimitBytes ?? HTTP_DEFAULT_BODY_LIMIT_BYTES,
    // Close idle keep-alive connections when server.close() is called so that
    // the process can exit cleanly during graceful shutdown (SIGTERM/SIGINT).
    // Without this, open keep-alive connections with no active request prevent
    // the server from finishing its close sequence, causing a hang or forceful
    // kill.  'idle' only affects connections with no in-flight request;
    // connections that are mid-request are drained normally.
    forceCloseConnections: 'idle',
    // TCP connection handshake timeout — prevents slow-connect attacks from
    // holding sockets open indefinitely.
    connectionTimeout: options?.connectionTimeout ?? HTTP_DEFAULT_CONNECTION_TIMEOUT_MS,
    // Per-request processing deadline — returns 503 if a route handler takes
    // longer than this to reply, preventing runaway requests from accumulating.
    requestTimeout: options?.requestTimeout ?? HTTP_DEFAULT_REQUEST_TIMEOUT_MS,
  });

  if (options?.enableSecurityHeaders ?? true) {
    // JSON-only API: lock down CSP to deny all subresource loads and
    // frame-ancestors. Even error pages or accidental HTML responses
    // cannot execute scripts or be framed by malicious pages.
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    });
  }

  // CORS headers (G-46).
  // In development/test: allow only localhost origins.
  // In production: allow only explicit CORS_ALLOWED_ORIGINS entries.
  // Uses @fastify/cors via registerCorsSupport.
  const nodeEnv = options?.nodeEnv ?? 'development';
  const enableAgentBenchmarkUi = options?.enableAgentBenchmarkUi ?? nodeEnv !== 'production';
  const allowedOrigins = options?.corsAllowedOrigins ?? '';
  if (options?.enableCors ?? true) {
    await registerCorsSupport(app, { nodeEnv, allowedOrigins });
  }

  // Configure trust for the X-Authenticated-Subject header. Without an
  // upstream verifying proxy (trustProxy=false) the header is client-supplied
  // and must be ignored to prevent impersonation.
  configureAuthenticatedSubjectTrust(app, options?.trustProxy ?? false);

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
        // Only trust X-Authenticated-Subject for rate-limit keying when a
        // trusted reverse proxy is in front (trustProxy=true). Without a proxy
        // the header is client-supplied and trivially forgeable.
        if (options?.trustProxy === true) {
          const subject = getAuthenticatedSubject(request);
          if (subject !== null) {
            return `subject:${subject}`;
          }
        }
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
  const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);
  app.addHook('preParsing', async (request, reply) => {
    if (METHODS_WITH_BODY.has(request.method)) {
      const rawCt = request.headers['content-type'] ?? '';
      const mediaType = rawCt.split(';')[0]?.trim().toLowerCase() ?? '';
      if (mediaType !== 'application/json') {
        const requestId = getRequestId(request);
        await reply.status(HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE).send({
          error: {
            request_id: requestId,
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message:
              'Content-Type must be application/json for POST/PUT/PATCH requests.',
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
  // Skips payloads already converted by sendRouteContractResponse to avoid
  // redundant traversals.
  app.addHook('preSerialization', async (_request, reply, payload) => {
    if (reply.snakeCaseApplied) {
      return payload;
    }
    return deepKeysToSnake(payload);
  });

  // Register global error handler
  app.setErrorHandler(errorHandler);

  // Start event-loop heartbeat for /health liveness check.
  // The interval is cleared when the server closes so the process can exit cleanly.
  const heartbeatInterval = startEventLoopHeartbeat();
  app.addHook('onClose', (_instance, done) => {
    clearInterval(heartbeatInterval);
    done();
  });

  // Register routes
  registerHealthRoutes(app, {
    ...(options?.health ?? {}),
    ...(options?.httpDebugSecret !== undefined ? { metricsDebugSecret: options.httpDebugSecret } : {}),
  });
  registerClaudeToolsRoute(app, deps);
  registerSearchRoute(app, deps);
  registerBatchSearchRoute(app, deps);
  registerReplayRoute(app, deps);
  registerInterpretRoute(app, deps);
  registerResolveRoute(app, deps);
  registerHybridRoute(app, deps);
  registerWatchlistRoute(app, deps);
  registerFeedbackRoute(app, deps);
  if (deps.agentOrchestrator !== undefined) {
    registerAgentRoute(app, { agentOrchestrator: deps.agentOrchestrator });
  }
  registerAgentBenchmarkScenariosRoute(app, { enabled: enableAgentBenchmarkUi });
  registerOpenApiRoute(app);

  // Epic 3: Optional evaluation run at startup (fire-and-forget)
  // Runs when env var EVAL_RUN_AT_STARTUP=true (requires Postgres)
  // MUST NOT block server readiness — eval can take minutes on large gold sets.
  if (options?.runEvalAtStartup === true) {
    if (nodeEnv === 'production') {
      throw new Error(
        'EVAL_RUN_AT_STARTUP=true is not permitted in production (startup workload contention risk).',
      );
    }
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
