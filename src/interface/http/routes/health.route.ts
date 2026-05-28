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
import { globalSilentSkipCounter } from '../../../domain/observability/silent-skip-counters.js';
import { globalCircuitBreakerRegistry } from '../../../domain/observability/circuit-breaker-registry.js';
import { getRequestId } from '../request-id.js';
import { buildSearchErrorResponse } from '../errors/error-response.js';
import { headerKeysEqualConstantTime } from '../middleware/http-debug-mode.js';
import { bootstrapLogger } from '../../../domain/shared/bootstrap-logger.js';

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
export const SNAPSHOT_HEALTH_READER_TIMEOUT_MS = 750;

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
  /**
   * Runtime plane composite-PK migration (016): optional reader that returns
   * the `snapshot_health` block for /ready. Must not be required so tests and
   * dev environments without PG still boot cleanly. When provided and it
   * returns a value, the handler embeds it in the response body.
   */
  readonly snapshotHealthReader?: () => Promise<SnapshotHealth | undefined>;
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
interface SnapshotHealth {
  readonly active_snapshot_id: string;
  readonly previous_snapshot_id: string | null;
  readonly stale_row_count: number;
  readonly pointer_age_seconds: number;
}

interface ReadyResponse {
  readonly ready: boolean;
  readonly timestamp: string;
  readonly checks: Readonly<Record<string, {
    readonly status: ReadinessStatus;
    readonly required: boolean;
    // Wave 3 / H13 fail-loud: structured failure attribution per probe.
    // Wire contract uses snake_case `error_class` (ReadyResponseSchema).
    readonly reason?: string;
    readonly error_class?: string;
  }>>;
  // Runtime plane composite-PK migration (016): optional observability block
  // surfacing cross-snapshot row count + pointer age. Omitted when the reader
  // is not wired or PG is down.
  readonly snapshot_health?: SnapshotHealth;
}

const DEFAULT_READINESS_CHECKS = ['postgres', 'redis'] as const;

/**
 * Wave 3 (fail-loud): structured probe outcome. The /ready endpoint
 * surfaces `reason` and `errorClass` so ops can immediately see WHICH
 * probe died and HOW, rather than just an opaque 'down'.
 */
interface ProbeOutcome {
  readonly status: ReadinessStatus;
  readonly reason?: string;
  readonly errorClass?: string;
}

async function resolveProbeOutcome(
  name: string,
  readinessCheck?: ReadinessCheck,
): Promise<ProbeOutcome> {
  if (readinessCheck === undefined) {
    return { status: 'skipped' };
  }
  try {
    const status = await readinessCheck.check();
    return { status };
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : typeof err;
    const reason = err instanceof Error ? err.message : String(err);
    bootstrapLogger.error(
      { probe: name, errorClass, err },
      `[health] readiness probe '${name}' threw — reporting 'down' with structured reason`,
    );
    return { status: 'down', reason, errorClass };
  }
}

/**
 * Backwards-compatible wrapper. Retained (exported) for future callers; the
 * /ready route handler in this file uses resolveProbeOutcome directly to
 * preserve reason/errorClass.
 */
export async function resolveStatus(readinessCheck?: ReadinessCheck): Promise<ReadinessStatus> {
  const outcome = await resolveProbeOutcome('legacy', readinessCheck);
  return outcome.status;
}

async function readSnapshotHealthWithTimeout(
  snapshotHealthReader: () => Promise<SnapshotHealth | undefined>,
): Promise<SnapshotHealth | undefined> {
  const timeoutSentinel = Symbol('snapshot_health_timeout');
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race<
      SnapshotHealth | undefined | typeof timeoutSentinel
    >([
      snapshotHealthReader(),
      new Promise<typeof timeoutSentinel>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(timeoutSentinel);
        }, SNAPSHOT_HEALTH_READER_TIMEOUT_MS);
      }),
    ]);

    if (result === timeoutSentinel) {
      bootstrapLogger.warn(
        { timeoutMs: SNAPSHOT_HEALTH_READER_TIMEOUT_MS },
        '[health] snapshot_health reader timed out — omitting from response',
      );
      return undefined;
    }
    return result;
  } catch (err: unknown) {
    bootstrapLogger.warn(
      { err },
      '[health] snapshot_health reader threw — omitting from response',
    );
    return undefined;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
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
  if (!isValidMetricsSecret(options?.metricsDebugSecret)) {
    bootstrapLogger.warn(
      'METRICS_DEBUG_SECRET is unset or empty — /metrics/* endpoints are disabled until a debug secret is configured.',
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
      // Wave 3 / H13 fail-loud: call resolveProbeOutcome directly to get
      // { status, reason?, errorClass? } per probe. Using Promise.allSettled
      // as defense-in-depth for future probes that bypass resolveProbeOutcome.
      const settled = await Promise.allSettled(
        checkNames.map(async (checkName) => {
          const readinessCheck = readinessChecks[checkName];
          const outcome = await resolveProbeOutcome(checkName, readinessCheck);
          const isDefaultCheck = (DEFAULT_READINESS_CHECKS as readonly string[]).includes(checkName);
          return [
            checkName,
            {
              status: outcome.status,
              required: readinessCheck?.required ?? isDefaultCheck,
              ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
              ...(outcome.errorClass !== undefined ? { error_class: outcome.errorClass } : {}),
            },
          ] as const;
        }),
      );
      const checks = Object.fromEntries(
        settled.map((result, index) => {
          if (result.status === 'fulfilled') return result.value;
          // Last-resort: probe threw AFTER resolveProbeOutcome's catch (should
          // be impossible but defend against future refactors). Surface a
          // synthetic reason so ops see that this bucket is unreachable.
          const checkName = checkNames[index] ?? 'unknown';
          const readinessCheck = readinessChecks[checkName];
          const isDefaultCheck = (DEFAULT_READINESS_CHECKS as readonly string[]).includes(checkName);
          const rej = result.reason as unknown;
          const errorClass = rej instanceof Error ? rej.constructor.name : typeof rej;
          const reason = rej instanceof Error ? rej.message : String(rej);
          return [
            checkName,
            {
              status: 'down' as const,
              required: readinessCheck?.required ?? isDefaultCheck,
              reason,
              error_class: errorClass,
            },
          ] as const;
        }),
      ) as ReadyResponse['checks'];
      // A required check blocks readiness only when its checker actively
      // reports 'down'. 'skipped' means no checker was registered — treat it
      // the same as 'up' so environments that omit optional infra (e.g. tests)
      // don't fail readiness unnecessarily.
      const ready = Object.values(checks).every((check) => !check.required || check.status !== 'down');

      let snapshotHealth: SnapshotHealth | undefined;
      if (options?.snapshotHealthReader !== undefined) {
        snapshotHealth = await readSnapshotHealthWithTimeout(options.snapshotHealthReader);
      }

      const body: ReadyResponse = {
        ready,
        timestamp: new Date().toISOString(),
        checks,
        ...(snapshotHealth !== undefined ? { snapshot_health: snapshotHealth } : {}),
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
      if (!isValidMetricsSecret(expectedSecret) || !isMetricsHeaderAuthorized(request.headers['x-debug-key'], expectedSecret)) {
        sendRouteContractResponse(
          request,
          reply,
          AgentMetricsRouteContract,
          HTTP_STATUS_FORBIDDEN,
          denyMetricsAccess(request),
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
            fallback_by_layer: metrics.fallbackByLayer,
            reasoning_failure_runs: metrics.reasoningFailureRuns,
            total_tool_calls: metrics.totalToolCalls,
            avg_duration_ms: metrics.avgDurationMs,
            tool_outcome_kinds: metrics.toolOutcomeKinds,
            failed_outcome_kinds: metrics.failedOutcomeKinds,
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
      const expectedSecret = options?.metricsDebugSecret;
      if (!isValidMetricsSecret(expectedSecret) || !isMetricsHeaderAuthorized(request.headers['x-debug-key'], expectedSecret)) {
        sendRouteContractResponse(
          request,
          reply,
          RetrievalDegradationMetricsRouteContract,
          HTTP_STATUS_FORBIDDEN,
          denyMetricsAccess(request),
        );
        return;
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
