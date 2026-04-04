import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';

/**
 * Augment Fastify request with a typed request_id property.
 */
declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startTime: number;
  }
}

/**
 * Registers a Fastify hook that:
 * 1. Generates a request_id via nanoid
 * 2. Attaches it to the request object
 * 3. Sets the X-Request-Id response header
 * 4. Logs request start/end with latency
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const requestId = nanoid();
    request.requestId = requestId;
    request.startTime = Date.now();

    void reply.header('X-Request-Id', requestId);

    request.log.info(
      { requestId, method: request.method, url: request.url },
      'request_start',
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    const latencyMs = Date.now() - request.startTime;

    request.log.info(
      {
        requestId: request.requestId,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        latencyMs,
      },
      'request_end',
    );
  });
}
