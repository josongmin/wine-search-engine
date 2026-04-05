import type { FastifyInstance } from 'fastify';

export type ReadinessStatus = 'up' | 'down' | 'skipped';

export interface ReadinessCheck {
  readonly required?: boolean;
  readonly check: () => Promise<ReadinessStatus> | ReadinessStatus;
}

export interface HealthRouteOptions {
  readonly readiness?: Readonly<Record<string, ReadinessCheck>>;
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
  readonly checks: Readonly<Record<string, {
    readonly status: ReadinessStatus;
    readonly required: boolean;
  }>>;
}

const DEFAULT_READINESS_CHECKS = ['postgres', 'redis'] as const;

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
    const readinessChecks = options?.readiness ?? {};
    const checkNames = Array.from(
      new Set<string>([
        ...DEFAULT_READINESS_CHECKS,
        ...Object.keys(readinessChecks),
      ]),
    );
    const checks = Object.fromEntries(
      await Promise.all(
        checkNames.map(async (checkName) => {
          const readinessCheck = readinessChecks[checkName];
          const status = await resolveStatus(readinessCheck);
          return [checkName, {
            status,
            required: readinessCheck?.required ?? false,
          }];
        }),
      ),
    ) as ReadyResponse['checks'];
    const ready = Object.values(checks).every((check) => !check.required || check.status !== 'down');

    const body: ReadyResponse = {
      ready,
      timestamp: new Date().toISOString(),
      checks,
    };

    reply.status(ready ? 200 : 503);
    return body;
  });
}
