import type { FastifyInstance } from 'fastify';
import {
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import {
  HealthRouteContract,
  ReadyRouteContract,
} from './route-contracts.js';

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
  registerContractRoute(app, {
    method: 'GET',
    url: '/health',
    contract: HealthRouteContract,
    handler: async (request, reply) => {
      const body: HealthResponse = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };

      sendRouteContractResponse(request, reply, HealthRouteContract, 200, body);
    },
  });

  registerContractRoute(app, {
    method: 'GET',
    url: '/ready',
    contract: ReadyRouteContract,
    handler: async (request, reply) => {
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

      sendRouteContractResponse(
        request,
        reply,
        ReadyRouteContract,
        ready ? 200 : 503,
        body,
      );
    },
  });
}
