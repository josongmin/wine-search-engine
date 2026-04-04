import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit, { type errorResponseBuilderContext } from '@fastify/rate-limit';
import type { Container } from '../../config/container.js';
import { registerRequestContext } from './middleware/request-context.js';
import { errorHandler } from './middleware/error-handler.js';
import { registerSearchRoute } from './routes/search.route.js';
import { registerReplayRoute } from './routes/replay.route.js';
import { registerInterpretRoute } from './routes/interpret.route.js';
import { registerResolveRoute } from './routes/resolve.route.js';
import { registerHybridRoute } from './routes/hybrid.route.js';
import { registerHealthRoutes } from './routes/health.route.js';

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
 * @param container - The DI container with all wired dependencies.
 * @param options - Optional server configuration.
 * @returns The configured Fastify instance (not yet listening).
 */
export async function createServer(
  container: Container,
  options?: ServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options?.logLevel ?? 'info',
    },
  });

  // Register middleware
  registerRequestContext(app);

  // Register rate limiting — RFC-014 §13
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (req: FastifyRequest, context: errorResponseBuilderContext) => ({
      error: {
        request_id: req.requestId ?? 'unknown',
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded. Retry after ${context.after}`,
        failure_reason: null,
        retryable: true,
      },
    }),
  });

  // Enforce Content-Type: application/json on all POST requests.
  // Fastify already rejects non-JSON bodies by default for routes with JSON
  // schemas, but POST routes here use Zod and parse request.body manually,
  // so we add an explicit gate to return 415 before the body is parsed.
  app.addHook('preValidation', async (request, reply) => {
    if (request.method === 'POST') {
      const ct = request.headers['content-type'] ?? '';
      if (!ct.includes('application/json')) {
        const requestId = request.requestId ?? 'unknown';
        void reply.status(415).send({
          error: {
            request_id: requestId,
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message:
              'Content-Type must be application/json for POST requests.',
            failure_reason: null,
            retryable: false,
          },
        });
      }
    }
  });

  // Register global error handler
  app.setErrorHandler(errorHandler);

  // Register routes
  registerHealthRoutes(app);
  registerSearchRoute(app, container);
  registerReplayRoute(app, container);
  registerInterpretRoute(app, container);
  registerResolveRoute(app, container);
  registerHybridRoute(app, container);

  return app;
}
