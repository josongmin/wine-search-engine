import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { type Span, SpanStatusCode } from '@opentelemetry/api';
import { config } from '../../config/env.js';
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
import { registerHealthRoutes } from './routes/health.route.js';
import { registerClaudeToolsRoute } from './routes/claude-tools.route.js';
import { registerWatchlistRoute } from './routes/watchlist.route.js';
import type { HttpServerDeps } from './routes/route-deps.js';
import { runEvaluation } from '../../infrastructure/eval/eval-initializer.js';

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

  // Register middleware
  registerRequestContext(app);

  // Add OpenTelemetry root span per request.
  // The span is started in onRequest (after request-context assigns requestId)
  // and closed in onResponse so it covers the full request lifecycle.
  app.addHook('onRequest', (request) => {
    const spanName = `${request.method} ${request.url}`;
    const span = getTracer().startSpan(spanName, {
      attributes: {
        'http.method': request.method,
        'http.url': request.url,
        'request.id': request.requestId,
      },
    });
    request.otelSpan = span;
  });

  app.addHook('onResponse', async (request, reply) => {
    const { otelSpan } = request;
    if (otelSpan !== undefined) {
      otelSpan.setAttribute('http.status_code', reply.statusCode);
      if (reply.statusCode >= 500) {
        otelSpan.setStatus({ code: SpanStatusCode.ERROR });
      }
      otelSpan.end();
    }
  });

  // Register rate limiting — RFC-014 §13
  // errorResponseBuilder is intentionally omitted: in @fastify/rate-limit v10 it replaces the
  // thrown error object, stripping statusCode and causing setErrorHandler to see an unknown
  // object and fall back to 500. The 429 branch is handled in the global error handler instead.
  if (config.httpRateLimit.max > 0) {
    await app.register(rateLimit, {
      max: config.httpRateLimit.max,
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
        const requestId = request.requestId;
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
  registerHealthRoutes(app);
  registerClaudeToolsRoute(app, deps);
  registerSearchRoute(app, deps);
  registerBatchSearchRoute(app, deps);
  registerReplayRoute(app, deps);
  registerInterpretRoute(app, deps);
  registerResolveRoute(app, deps);
  registerHybridRoute(app, deps);
  registerWatchlistRoute(app);

  // Epic 3: Optional evaluation run at startup (fire-and-forget)
  // Runs when env var EVAL_RUN_AT_STARTUP=true (requires Postgres)
  // MUST NOT block server readiness — eval can take minutes on large gold sets.
  if (process.env.EVAL_RUN_AT_STARTUP === 'true') {
    if (deps.evalRunner) {
      const evalRunnerRef = deps.evalRunner;
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
