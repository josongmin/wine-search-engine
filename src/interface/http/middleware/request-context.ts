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
export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const requestId = request.id;
    request.requestId = requestId;
    request.startTime = Date.now();

    reply.header('X-Request-Id', requestId);

    request.log.info(
      { requestId, method: request.method, url: request.url },
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
        url: request.url,
        statusCode: reply.statusCode,
        latencyMs,
      },
      'request_end',
    );
    done();
  });
}
