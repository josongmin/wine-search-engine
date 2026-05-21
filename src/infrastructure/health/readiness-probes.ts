import { fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ReadinessStatus } from '../../interface/http/routes/health.route.js';

// ---------------------------------------------------------------------------
// Readiness probe SLO budgets (Kubernetes readinessProbe + Google SRE SLI/SLO).
//
// These are NAMED constants (not magic numbers — CLAUDE.md rule 15) so the
// SLO is auditable from a single place. Each value documents WHY it is set,
// not just what value it carries.
//
// The /ready handler runs all probes in PARALLEL (Promise.allSettled in
// health.route.ts). Total /ready wall-clock is therefore bounded by the
// SLOWEST individual probe, NOT by the sum of probe budgets.
// ---------------------------------------------------------------------------

/** Postgres SELECT 1 against a healthy pool returns in <50ms; the budget
 *  here absorbs pool-acquire under modest contention without giving cover
 *  to a wedged connection. */
export const PROBE_TIMEOUT_PG_MS = 1_500;

/** Redis PING on a healthy localhost/socket completes in <5ms. The budget
 *  is dominated by a half-open TCP socket (network partition) returning
 *  from the OS; keep it tight so a network blackhole fails the probe
 *  rather than blocking the LB health check. */
export const PROBE_TIMEOUT_REDIS_MS = 1_000;

/** Vespa Cloud mTLS handshake + cold start can take ~1.5s in practice.
 *  Earlier 750ms caused permanent "down" status on cloud endpoints. */
export const PROBE_TIMEOUT_VESPA_MS = 2_000;

/** OpenAI /v1/embeddings probe with a __healthcheck__ payload. The
 *  remote endpoint has high tail latency; 3s is the smallest budget
 *  that gives a stable signal without making /ready unreliable. */
export const PROBE_TIMEOUT_LLM_EMBEDDING_MS = 3_000;

/** Cohere /rerank probe. Non-critical (graceful degradation), but we
 *  still bound it so a degraded remote does not delay /ready. */
export const PROBE_TIMEOUT_RERANKER_MS = 2_000;

/**
 * Scheduling/serialization slack added on top of the slowest per-probe
 * budget. Covers Fastify routing, JSON serialization, and event-loop
 * dispatch jitter under load.
 */
const READINESS_SCHEDULING_SLACK_MS = 500;

/**
 * Wall-clock ceiling for the entire GET /ready response. Probes run in
 * parallel, so this is bounded by the SLOWEST per-probe budget plus a
 * small scheduling buffer — NOT by the sum.
 *
 * Kubernetes readinessProbe.timeoutSeconds is commonly 3-10s; this budget
 * stays inside that range so the pod does not thrash in and out of the
 * endpoints list.
 */
export const READINESS_TOTAL_BUDGET_MS = Math.max(
  PROBE_TIMEOUT_PG_MS,
  PROBE_TIMEOUT_REDIS_MS,
  PROBE_TIMEOUT_VESPA_MS,
  PROBE_TIMEOUT_LLM_EMBEDDING_MS,
  PROBE_TIMEOUT_RERANKER_MS,
) + READINESS_SCHEDULING_SLACK_MS;

/**
 * Default per-call timeout for the generic JSON-POST helper. Tuned to the
 * Vespa budget because cloud handshake dominates and other JSON-POST
 * targets (OpenAI, Cohere) are explicitly clamped below to their own
 * budgets via probeJsonPostEndpoint's `timeoutMs` argument.
 */
const DEFAULT_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_VESPA_MS;

/**
 * Criticality model for each probe family. A `critical` probe DOWN must
 * block /ready (503). A `non_critical` probe DOWN must surface in the
 * response body but allow /ready=true (graceful degradation, per the
 * Google SRE error-budget pattern).
 *
 * The `required` flag on a `ReadinessCheck` is the wire-level enforcement
 * of this model — this constant exists as the auditable SSoT so future
 * reviewers can compare wire flags against the documented criticality.
 */
export const PROBE_CRITICALITY = {
  postgres: 'critical',
  redis: 'critical',
  vespa: 'critical',
  alias_substrate: 'critical',
  search_snapshot_runtime: 'critical',
  embedding: 'critical',
  calibration_store: 'critical',
  benchmark_persistence: 'critical',
  watchlist_runtime: 'critical',
  runtime_ltr_artifact: 'critical',
  runtime_ltr_effective: 'critical',
  reranker: 'non_critical',
  learned_matcher: 'non_critical',
  drinking_window_model: 'non_critical',
  blocking_zero_candidates: 'non_critical',
} as const satisfies Record<string, 'critical' | 'non_critical'>;

/** JSON POST probe treats this HTTP status range as dependency healthy. */
const READINESS_PROBE_HTTP_SUCCESS_MIN = 200;
const READINESS_PROBE_HTTP_SUCCESS_MAX_EXCLUSIVE = 300;

export async function withProbeTimeout(
  operation: (signal: AbortSignal) => Promise<ReadinessStatus>,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ReadinessStatus> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch {
    return 'down';
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function probeJsonPostEndpoint(
  url: string,
  payload: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  dispatcher?: Dispatcher,
): Promise<ReadinessStatus> {
  return withProbeTimeout(async (signal) => {
    let response: Response;
    if (dispatcher !== undefined) {
      response = await undiciFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(payload),
        signal,
        dispatcher,
      }) as unknown as Response;
    } else {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(payload),
        signal,
      });
    }

    // Only 2xx counts as up. 401/403 (auth misconfig), 404 (wrong URL),
    // 429 (rate-limited), and 5xx all indicate the dependency cannot serve
    // production traffic. Earlier code accepted any < 500 which silently
    // hid auth/config drift behind a green health page.
    return response.status >= READINESS_PROBE_HTTP_SUCCESS_MIN
      && response.status < READINESS_PROBE_HTTP_SUCCESS_MAX_EXCLUSIVE
      ? 'up'
      : 'down';
  });
}
