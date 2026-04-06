import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { type Span, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { getTracer } from '../../infrastructure/telemetry/tracer.js';
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
  type HealthRouteOptions,
} from './routes/health.route.js';
import { registerClaudeToolsRoute } from './routes/claude-tools.route.js';
import { registerWatchlistRoute } from './routes/watchlist.route.js';
import { registerFeedbackRoute } from './routes/feedback.route.js';
import { registerOpenApiRoute } from './routes/openapi.route.js';
import type { HttpServerDeps } from './routes/route-deps.js';
import { getRequestId } from './request-id.js';
import { runEvaluation } from '../../infrastructure/eval/eval-initializer.js';
import type { EvalRunnerContract } from '../../config/container-eval-contracts.js';

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
}

function registerCorsSupport(
  app: FastifyInstance,
  options: {
    readonly nodeEnv: 'development' | 'production' | 'test';
    readonly allowedOrigins: string;
  },
): void {
  app.options('*', async (_request, reply) => {
    return reply.status(204).send();
  });

  app.addHook('preHandler', (request, reply, done) => {
    const origin = request.headers.origin ?? '';
    if (options.nodeEnv !== 'production') {
      reply.header('Access-Control-Allow-Origin', origin || '*');
    } else if (options.allowedOrigins.length > 0) {
      const originList = options.allowedOrigins.split(',').map((o) => o.trim());
      if (originList.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
      }
    }
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.header('Access-Control-Max-Age', '86400');
    done();
  });
}

function registerTelemetryHooks(app: FastifyInstance, tracer: Tracer): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const spanName = `${request.method} ${request.url}`;
    const span = tracer.startSpan(spanName, {
      attributes: {
        'http.method': request.method,
        'http.url': request.url,
        'request.id': request.requestId,
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
  });

  // CORS headers (G-46).
  // In development: allow all origins. In production: restrict to CORS_ALLOWED_ORIGINS env var.
  // Uses a manual hook instead of @fastify/cors to avoid an extra dependency.
  const nodeEnv = options?.nodeEnv ?? 'development';
  const allowedOrigins = options?.corsAllowedOrigins ?? '';
  if (options?.enableCors ?? true) {
    registerCorsSupport(app, { nodeEnv, allowedOrigins });
  }

  // Register middleware
  registerRequestContext(app);

  if (options?.enableTelemetry ?? true) {
    registerTelemetryHooks(app, options?.tracer ?? getTracer());
  }

  // Register rate limiting — RFC-014 §13
  // errorResponseBuilder is intentionally omitted: in @fastify/rate-limit v10 it replaces the
  // thrown error object, stripping statusCode and causing setErrorHandler to see an unknown
  // object and fall back to 500. The 429 branch is handled in the global error handler instead.
  if ((options?.rateLimitMax ?? 100) > 0) {
    await app.register(rateLimit, {
      max: options?.rateLimitMax ?? 100,
      timeWindow: '1 minute',
    });
  }

  // Enforce Content-Type: application/json on all POST requests.
  // Must run in preParsing (before the body parser) so that missing or
  // wrong Content-Type headers never reach the JSON parser and cause a 500.
  // RFC 2046: media types are case-insensitive, so we lowercase before checking.
  app.addHook('preParsing', async (request, reply) => {
    if (request.method === 'POST') {
      const ct = (request.headers['content-type'] ?? '').toLowerCase();
      if (!ct.includes('application/json')) {
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
  registerOpenApiRoute(app);

  // Epic 3: Optional evaluation run at startup (fire-and-forget)
  // Runs when env var EVAL_RUN_AT_STARTUP=true (requires Postgres)
  // MUST NOT block server readiness — eval can take minutes on large gold sets.
  if (options?.runEvalAtStartup === true) {
    if (deps.evalRunner) {
      const evalRunnerRef: EvalRunnerContract = deps.evalRunner;
      app.addHook('onReady', () => {
        const evalStart = Date.now();
        console.warn('[Server] Starting background evaluation per EVAL_RUN_AT_STARTUP...');
        void runEvaluation(evalRunnerRef, { verbose: true }).then(
          (result) => {
            const durationMs = Date.now() - evalStart;
            console.warn(`[Server] Background evaluation completed in ${durationMs}ms: ${result.message}`);
          },
          (err: unknown) => {
            const durationMs = Date.now() - evalStart;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Server] Background evaluation FAILED after ${durationMs}ms: ${msg}`);
          },
        );
      });
    } else {
      console.warn('[Server] EVAL_RUN_AT_STARTUP=true but evalRunner not available; skipping');
    }
  }

  return app;
}
