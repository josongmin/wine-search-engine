import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import {
  AgentMetricsRouteContract,
  HealthRouteContract,
  ReadyRouteContract,
  RetrievalDegradationMetricsRouteContract,
} from './route-contracts.js';
import {
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_OK,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
} from '../constants.js';
import { getAgentExecutionMetricsCollector } from '../../../infrastructure/observability/agent-execution-metrics.js';
import { getRetrievalDegradationCollector } from '../../../infrastructure/observability/retrieval-degradation-metrics.js';
import { globalSilentSkipCounter } from '../../../observability/silent-skip-counters.js';
import { globalCircuitBreakerRegistry } from '../../../observability/circuit-breaker-registry.js';
import { getRequestId } from '../request-id.js';
import { buildSearchErrorResponse } from '../errors/error-response.js';
import { headerKeysEqualConstantTime } from '../middleware/http-debug-mode.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';

/**
 * Extracts the `X-Debug-Key` header (handling Fastify's `string | string[]`
 * type) and compares it against the configured secret with constant-time
 * equality. Returns `true` only when the secret is configured AND the header
 * matches; returns `false` otherwise so callers can fall through to a
 * generic 403 response without leaking which condition failed.
 *
 * Both `expectedSecret` validity and the comparison itself must avoid
 * length-leaking branches. We early-return on missing/empty secret because
 * those represent "feature disabled" rather than "wrong key" — they are
 * already covered by `isValidMetricsSecret` upstream.
 */
function isMetricsHeaderAuthorized(
  rawDebugKey: string | string[] | undefined,
  expectedSecret: string,
): boolean {
  const providedDebugKey = Array.isArray(rawDebugKey) ? rawDebugKey[0] : rawDebugKey;
  if (typeof providedDebugKey !== 'string' || providedDebugKey.length === 0) {
    return false;
  }
  return headerKeysEqualConstantTime(providedDebugKey, expectedSecret);
}

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
  /**
   * Optional secret to gate /metrics/* endpoints (expects matching X-Debug-Key).
   *
   * When METRICS_DEBUG_SECRET is unset or empty, the metrics endpoints are OPEN
   * (intended for local dev / read-only deploys). Set the secret to gate
   * metrics behind the X-Debug-Key header in production.
   */
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
    // intentional: individual probe implementations log their own failures;
    // this is a last-resort guard so a throwing check() degrades to 'down'.
    return 'down';
  }
}

function isValidMetricsSecret(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length > 0;
}

function denyMetricsAccess(
  request: FastifyRequest,
): ReturnType<typeof buildSearchErrorResponse> {
  return buildSearchErrorResponse(
    getRequestId(request),
    'FORBIDDEN',
    'Metrics endpoint requires a valid X-Debug-Key and an enabled metrics secret.',
    null,
    false,
  );
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
  if (!isValidMetricsSecret(options?.metricsDebugSecret) && process.env['NODE_ENV'] === 'production') {
    bootstrapLogger.warn(
      'METRICS_DEBUG_SECRET is unset or empty in production — /metrics/* endpoints are OPEN without authentication. '
      + 'Set METRICS_DEBUG_SECRET to gate metrics behind the X-Debug-Key header.',
    );
  }

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
      // Use Promise.allSettled so that an unexpected throw from any single
      // probe never collapses the entire readiness response. resolveStatus
      // already catches its own errors and returns 'down'; the allSettled
      // here is defense-in-depth against future probes that may not.
      const settled = await Promise.allSettled(
        checkNames.map(async (checkName) => {
          const readinessCheck = readinessChecks[checkName];
          const status = await resolveStatus(readinessCheck);
          // Default-required checks (postgres, redis) are required unless the
          // caller explicitly opts them out via required:false in the readiness map.
          const isDefaultCheck = (DEFAULT_READINESS_CHECKS as readonly string[]).includes(checkName);
          return [
            checkName,
            {
              status,
              required: readinessCheck?.required ?? isDefaultCheck,
            },
          ] as const;
        }),
      );
      const checks = Object.fromEntries(
        settled.map((result, index) => {
          if (result.status === 'fulfilled') return result.value;
          // Probe threw despite resolveStatus's catch — surface as 'down'.
          const checkName = checkNames[index] ?? 'unknown';
          const readinessCheck = readinessChecks[checkName];
          const isDefaultCheck = (DEFAULT_READINESS_CHECKS as readonly string[]).includes(checkName);
          return [
            checkName,
            {
              status: 'down' as const,
              required: readinessCheck?.required ?? isDefaultCheck,
            },
          ] as const;
        }),
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
      // When METRICS_DEBUG_SECRET is unset or empty, the metrics endpoint is
      // OPEN (intended for local dev / read-only deploys). Set the secret to
      // gate metrics behind the X-Debug-Key header.
      const expectedSecret = options?.metricsDebugSecret;
      if (isValidMetricsSecret(expectedSecret)) {
        if (!isMetricsHeaderAuthorized(request.headers['x-debug-key'], expectedSecret)) {
          sendRouteContractResponse(
            request,
            reply,
            AgentMetricsRouteContract,
            HTTP_STATUS_FORBIDDEN,
            denyMetricsAccess(request),
          );
          return;
        }
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

  registerContractRoute(app, {
    method: 'GET',
    url: '/metrics/retrieval-degradation',
    contract: RetrievalDegradationMetricsRouteContract,
    handler: async (request, reply) => {
      // When METRICS_DEBUG_SECRET is unset or empty, the metrics endpoint is
      // OPEN (intended for local dev / read-only deploys). Set the secret to
      // gate metrics behind the X-Debug-Key header.
      const expectedSecret = options?.metricsDebugSecret;
      if (isValidMetricsSecret(expectedSecret)) {
        if (!isMetricsHeaderAuthorized(request.headers['x-debug-key'], expectedSecret)) {
          sendRouteContractResponse(
            request,
            reply,
            RetrievalDegradationMetricsRouteContract,
            HTTP_STATUS_FORBIDDEN,
            denyMetricsAccess(request),
          );
          return;
        }
      }
      const metrics = getRetrievalDegradationCollector().getMetrics();
      const silentSkips = globalSilentSkipCounter.snapshot();
      const breakers = globalCircuitBreakerRegistry.snapshot().map((b) => ({
        name: b.name,
        state: b.state,
        failure_count: b.metrics.failureCount,
        open_count: b.metrics.openCount,
      }));
      sendRouteContractResponse(
        request,
        reply,
        RetrievalDegradationMetricsRouteContract,
        HTTP_STATUS_OK,
        {
          timestamp: new Date().toISOString(),
          retrieval: {
            total_retrievals: metrics.totalRetrievals,
            degradations: metrics.degradations,
            degradation_rate: metrics.degradationRate,
            alerts: metrics.alerts,
          },
          silent_skips: silentSkips,
          circuit_breakers: breakers,
        },
      );
    },
  });
}
