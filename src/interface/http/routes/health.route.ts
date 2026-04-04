import type { FastifyInstance } from 'fastify';

/**
 * Health check response shape.
 */
interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly timestamp: string;
  readonly uptime: number;
}

/**
 * Readiness check response shape.
 */
interface ReadyResponse {
  readonly ready: boolean;
  readonly timestamp: string;
}

/**
 * Registers GET /health and GET /ready endpoints.
 *
 * - /health — liveness probe; returns 200 if the process is running.
 * - /ready — readiness probe; returns 200 when the service can accept traffic.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async (_request, reply) => {
    const body: HealthResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };

    void reply.status(200).send(body);
  });

  app.get('/ready', async (_request, reply) => {
    // In production, this would check database connections, search index,
    // embedding service, etc. For now, always report ready.
    const body: ReadyResponse = {
      ready: true,
      timestamp: new Date().toISOString(),
    };

    void reply.status(200).send(body);
  });
}
