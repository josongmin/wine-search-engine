import type { FastifyInstance } from 'fastify';

export type ReadinessStatus = 'up' | 'down' | 'skipped';

export interface ReadinessCheck {
  readonly required?: boolean;
  readonly check: () => Promise<ReadinessStatus> | ReadinessStatus;
}

export interface HealthRouteOptions {
  readonly readiness?: {
    readonly postgres?: ReadinessCheck;
    readonly redis?: ReadinessCheck;
  };
}

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
  readonly checks: {
    readonly postgres: {
      readonly status: ReadinessStatus;
      readonly required: boolean;
    };
    readonly redis: {
      readonly status: ReadinessStatus;
      readonly required: boolean;
    };
  };
}

async function resolveStatus(readinessCheck?: ReadinessCheck): Promise<ReadinessStatus> {
  if (readinessCheck === undefined) {
    return 'skipped';
  }

  try {
    return await readinessCheck.check();
  } catch {
    return 'down';
  }
}

/**
 * Registers GET /health and GET /ready endpoints.
 *
 * - /health — liveness probe; returns 200 if the process is running.
 * - /ready — readiness probe; returns 200 when the service can accept traffic.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  options?: HealthRouteOptions,
): void {
  app.get('/health', async (_request, reply) => {
    const body: HealthResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };

    reply.status(200);
    return body;
  });

  app.get('/ready', async (_request, reply) => {
    const postgres = await resolveStatus(options?.readiness?.postgres);
    const redis = await resolveStatus(options?.readiness?.redis);
    const postgresRequired = options?.readiness?.postgres?.required ?? false;
    const redisRequired = options?.readiness?.redis?.required ?? false;
    const ready = (!postgresRequired || postgres !== 'down')
      && (!redisRequired || redis !== 'down');

    const body: ReadyResponse = {
      ready,
      timestamp: new Date().toISOString(),
      checks: {
        postgres: {
          status: postgres,
          required: postgresRequired,
        },
        redis: {
          status: redis,
          required: redisRequired,
        },
      },
    };

    reply.status(ready ? 200 : 503);
    return body;
  });
}
