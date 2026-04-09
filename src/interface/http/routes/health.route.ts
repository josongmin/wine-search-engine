import type { FastifyInstance } from 'fastify';
import {
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import {
  AgentMetricsRouteContract,
  HealthRouteContract,
  ReadyRouteContract,
} from './route-contracts.js';
import {
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_OK,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
} from '../constants.js';
import { getAgentExecutionMetricsCollector } from '../../../infrastructure/observability/agent-execution-metrics.js';
import { getRequestId } from '../request-id.js';
import { buildSearchErrorResponse } from '../errors/error-response.js';

/**
 * Tracks the last time the event loop was responsive.
 * Updated by startEventLoopHeartbeat(); checked by the /health handler.
 */
let lastHeartbeatMs: number = Date.now();

/** Maximum allowed event-loop silence before /health returns 503 (ms). */
const HEARTBEAT_STALE_THRESHOLD_MS = 30_000;

/**
 * Starts a 1-second interval that updates lastHeartbeatMs.
 * Returns the interval handle so callers can clear it on shutdown.
 * Safe to call multiple times — each call starts an independent interval,
 * so callers should store and clear the handle when appropriate.
 */
export function startEventLoopHeartbeat(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    lastHeartbeatMs = Date.now();
  }, 1_000);
}

export type ReadinessStatus = 'up' | 'down' | 'skipped';

export interface ReadinessCheck {
  readonly required?: boolean;
  readonly check: () => Promise<ReadinessStatus> | ReadinessStatus;
}

export interface HealthRouteOptions {
  readonly readiness?: Readonly<Record<string, ReadinessCheck>>;
  /** Optional secret to gate /metrics/agent (expects matching X-Debug-Key). */
  readonly metricsDebugSecret?: string | undefined;
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
      const heartbeatAgeMs = Date.now() - lastHeartbeatMs;
      const isStuck = heartbeatAgeMs > HEARTBEAT_STALE_THRESHOLD_MS;

      const body: HealthResponse = {
        status: isStuck ? 'degraded' : 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };

      sendRouteContractResponse(
        request,
        reply,
        HealthRouteContract,
        isStuck ? HTTP_STATUS_SERVICE_UNAVAILABLE : HTTP_STATUS_OK,
        body,
      );
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
            // Default-required checks (postgres, redis) are required unless the
            // caller explicitly opts them out via required:false in the readiness map.
            const isDefaultCheck = (DEFAULT_READINESS_CHECKS as readonly string[]).includes(checkName);
            return [checkName, {
              status,
              required: readinessCheck?.required ?? isDefaultCheck,
            }];
          }),
        ),
      ) as ReadyResponse['checks'];
      // A required check blocks readiness only when its checker actively
      // reports 'down'. 'skipped' means no checker was registered — treat it
      // the same as 'up' so environments that omit optional infra (e.g. tests)
      // don't fail readiness unnecessarily.
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
        ready ? HTTP_STATUS_OK : HTTP_STATUS_SERVICE_UNAVAILABLE,
        body,
      );
    },
  });

  registerContractRoute(app, {
    method: 'GET',
    url: '/metrics/agent',
    contract: AgentMetricsRouteContract,
    handler: async (request, reply) => {
      const expectedSecret = options?.metricsDebugSecret;
      const rawDebugKey = request.headers['x-debug-key'];
      const providedDebugKey = Array.isArray(rawDebugKey) ? rawDebugKey[0] : rawDebugKey;
      if (
        typeof expectedSecret === 'string' &&
        expectedSecret.length > 0 &&
        providedDebugKey !== expectedSecret
      ) {
        sendRouteContractResponse(
          request,
          reply,
          AgentMetricsRouteContract,
          HTTP_STATUS_FORBIDDEN,
          buildSearchErrorResponse(
            getRequestId(request),
            'FORBIDDEN',
            'Metrics endpoint requires a valid X-Debug-Key.',
            null,
            false,
          ),
        );
        return;
      }
      const metrics = getAgentExecutionMetricsCollector().getMetrics();
      sendRouteContractResponse(
        request,
        reply,
        AgentMetricsRouteContract,
        HTTP_STATUS_OK,
        {
          timestamp: new Date().toISOString(),
          agent: {
            runs: metrics.runs,
            by_termination_reason: metrics.byTerminationReason,
            fallback_runs: metrics.fallbackRuns,
            fallback_rate: metrics.fallbackRate,
            total_tool_calls: metrics.totalToolCalls,
            avg_duration_ms: metrics.avgDurationMs,
            timeouts: {
              llm_step: metrics.timeouts.llmStep,
              tool: metrics.timeouts.tool,
              parallel_batch: metrics.timeouts.parallelBatch,
              event_rate_per_run: metrics.timeouts.eventRatePerRun,
            },
            alerts: metrics.alerts,
          },
        },
      );
    },
  });
}
