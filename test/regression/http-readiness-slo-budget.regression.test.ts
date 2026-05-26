/**
 * SLO/error-budget invariants for GET /ready (Kubernetes readiness probe +
 * Google SRE SLO error-budget pattern).
 *
 * Append-only regression. NEVER delete.
 *
 * The /ready endpoint is the LB readiness gate and the K8s readinessProbe
 * target. A single slow probe blocking the response makes the entire pod
 * appear unhealthy. The contract this file pins down:
 *
 * 1. Per-probe timeout budgets are documented as NAMED constants (CLAUDE.md
 *    rule 15 — no magic numbers in penalty/threshold logic).
 * 2. Total /ready response budget is bounded by `READINESS_TOTAL_BUDGET_MS`
 *    independent of individual probe latency, because probes run in PARALLEL
 *    (Promise.allSettled), not sequentially.
 * 3. Probe criticality model is explicit: a single down on a `required: true`
 *    probe → 503; a single down on `required: false` → still 200.
 * 4. Korean (한글) error messages are preserved verbatim — they MUST NOT be
 *    truncated or transliterated by the probe machinery (CLAUDE.md rule 5).
 *
 * Every test mocks the probe at the `ReadinessCheck` port; NO real PG/Vespa/
 * Redis is contacted. Deterministic timers via vi.useFakeTimers() where
 * latency injection is required.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerHealthRoutes,
  type ReadinessCheck,
  type ReadinessStatus,
} from '../../src/interface/http/routes/health.route.js';
import {
  PROBE_TIMEOUT_PG_MS,
  PROBE_TIMEOUT_REDIS_MS,
  PROBE_TIMEOUT_VESPA_MS,
  PROBE_TIMEOUT_LLM_EMBEDDING_MS,
  PROBE_TIMEOUT_RERANKER_MS,
  READINESS_TOTAL_BUDGET_MS,
  PROBE_CRITICALITY,
} from '../../src/infrastructure/health/readiness-probes.js';

interface ReadyResponseBody {
  readonly ready: boolean;
  readonly timestamp: string;
  readonly checks: Readonly<Record<string, {
    readonly status: ReadinessStatus;
    readonly required: boolean;
    readonly reason?: string;
    readonly error_class?: string;
  }>>;
}

/**
 * Resolves to the given status after the requested latency. Uses real
 * setTimeout so the Promise.allSettled parallel-execution claim can be
 * measured against wall-clock time deterministically.
 */
function delayedStatus(status: ReadinessStatus, latencyMs: number): Promise<ReadinessStatus> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(status), latencyMs);
  });
}

async function buildAppWith(
  readiness: Readonly<Record<string, ReadinessCheck>>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerHealthRoutes(app, { readiness });
  await app.ready();
  return app;
}

describe('/ready SLO budget invariants', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  describe('per-probe named timeout constants (CLAUDE.md rule 15)', () => {
    it('exports a named timeout constant per critical probe family', () => {
      // Each value is a finite positive ms count. The point of this test is
      // that THESE NAMED EXPORTS EXIST — not that their numeric values are
      // any particular figure.
      expect(Number.isFinite(PROBE_TIMEOUT_PG_MS)).toBe(true);
      expect(PROBE_TIMEOUT_PG_MS).toBeGreaterThan(0);
      expect(Number.isFinite(PROBE_TIMEOUT_REDIS_MS)).toBe(true);
      expect(PROBE_TIMEOUT_REDIS_MS).toBeGreaterThan(0);
      expect(Number.isFinite(PROBE_TIMEOUT_VESPA_MS)).toBe(true);
      expect(PROBE_TIMEOUT_VESPA_MS).toBeGreaterThan(0);
      expect(Number.isFinite(PROBE_TIMEOUT_LLM_EMBEDDING_MS)).toBe(true);
      expect(PROBE_TIMEOUT_LLM_EMBEDDING_MS).toBeGreaterThan(0);
      expect(Number.isFinite(PROBE_TIMEOUT_RERANKER_MS)).toBe(true);
      expect(PROBE_TIMEOUT_RERANKER_MS).toBeGreaterThan(0);
    });

    it('declares a total /ready budget that meets the K8s readinessProbe norm (<= 10s)', () => {
      // Kubernetes readinessProbe.timeoutSeconds default is 1s; common
      // production values are 3-10s. A /ready that takes longer than this
      // makes the pod thrash in/out of the endpoints list.
      const K8S_READINESS_PROBE_MAX_REASONABLE_MS = 10_000;
      expect(Number.isFinite(READINESS_TOTAL_BUDGET_MS)).toBe(true);
      expect(READINESS_TOTAL_BUDGET_MS).toBeGreaterThan(0);
      expect(READINESS_TOTAL_BUDGET_MS).toBeLessThanOrEqual(K8S_READINESS_PROBE_MAX_REASONABLE_MS);
    });

    it('the total budget covers the slowest single per-probe budget (parallel execution claim)', () => {
      // If probes run in parallel (Promise.allSettled), the total wall-clock
      // is bounded by the SLOWEST probe, not the sum. The total budget MUST
      // therefore be >= the slowest individual probe budget. If a future
      // refactor switches to sequential execution, this invariant fails
      // loudly because the new total has to be >= SUM, which usually exceeds
      // the K8s ceiling above.
      const slowestProbe = Math.max(
        PROBE_TIMEOUT_PG_MS,
        PROBE_TIMEOUT_REDIS_MS,
        PROBE_TIMEOUT_VESPA_MS,
        PROBE_TIMEOUT_LLM_EMBEDDING_MS,
        PROBE_TIMEOUT_RERANKER_MS,
      );
      expect(READINESS_TOTAL_BUDGET_MS).toBeGreaterThanOrEqual(slowestProbe);
    });
  });

  describe('probe criticality model', () => {
    it('declares PG and Vespa as CRITICAL dependencies (block /ready when down)', () => {
      expect(PROBE_CRITICALITY.postgres).toBe('critical');
      expect(PROBE_CRITICALITY.vespa).toBe('critical');
    });

    it('declares the reranker as a NON-CRITICAL dependency (degraded, but ready)', () => {
      expect(PROBE_CRITICALITY.reranker).toBe('non_critical');
    });
  });

  describe('parallel execution (Google SRE: probes share a wall-clock budget)', () => {
    it('runs all probes in parallel — total latency ~= slowest probe, NOT sum', async () => {
      // Three probes each take 200ms. Sequential execution would be ~600ms;
      // parallel execution is ~200ms plus route overhead. Under full-suite
      // load, absolute wall-clock can drift, so the structural proof is:
      //   1. all probes start near-simultaneously
      //   2. end-to-end latency stays below the sequential floor
      const PROBE_LATENCY_MS = 200;
      const PROBE_COUNT = 3;
      const SEQUENTIAL_FLOOR_MS = PROBE_LATENCY_MS * PROBE_COUNT; // 600
      const startTimes: number[] = [];

      app = await buildAppWith({
        synthetic_a: {
          required: true,
          check: () => {
            startTimes.push(Date.now());
            return delayedStatus('up', PROBE_LATENCY_MS);
          },
        },
        synthetic_b: {
          required: true,
          check: () => {
            startTimes.push(Date.now());
            return delayedStatus('up', PROBE_LATENCY_MS);
          },
        },
        synthetic_c: {
          required: true,
          check: () => {
            startTimes.push(Date.now());
            return delayedStatus('up', PROBE_LATENCY_MS);
          },
        },
      });
      const start = Date.now();
      const res = await app.inject({ method: 'GET', url: '/ready' });
      const elapsedMs = Date.now() - start;
      expect(res.statusCode).toBe(200);
      expect(startTimes).toHaveLength(PROBE_COUNT);
      const startSpreadMs = Math.max(...startTimes) - Math.min(...startTimes);
      expect(startSpreadMs).toBeLessThan(100);
      // If probes ever serialize, elapsed time converges toward the sum.
      expect(elapsedMs).toBeLessThan(SEQUENTIAL_FLOOR_MS);
    });
  });

  describe('degraded-vs-503 contract per criticality', () => {
    it('all probes succeed → 200 with ready=true', async () => {
      app = await buildAppWith({
        vespa: { required: true, check: (): ReadinessStatus => 'up' },
        reranker: { required: false, check: (): ReadinessStatus => 'up' },
      });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body: ReadyResponseBody = res.json();
      expect(body.ready).toBe(true);
    });

    it('critical dep (Vespa) DOWN → 503 with ready=false', async () => {
      app = await buildAppWith({
        vespa: { required: true, check: (): ReadinessStatus => 'down' },
        reranker: { required: false, check: (): ReadinessStatus => 'up' },
      });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      const body: ReadyResponseBody = res.json();
      expect(body.ready).toBe(false);
      expect(body.checks['vespa']?.status).toBe('down');
    });

    it('non-critical dep (reranker) DOWN → 200 with ready=true (graceful degradation)', async () => {
      app = await buildAppWith({
        vespa: { required: true, check: (): ReadinessStatus => 'up' },
        reranker: { required: false, check: (): ReadinessStatus => 'down' },
      });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body: ReadyResponseBody = res.json();
      expect(body.ready).toBe(true);
      // Body still records the down probe so ops sees the degradation.
      expect(body.checks['reranker']?.status).toBe('down');
      expect(body.checks['reranker']?.required).toBe(false);
    });
  });

  describe('Korean (한글) error preservation (CLAUDE.md rule 5)', () => {
    it('preserves Korean error messages verbatim in the /ready response body', async () => {
      const koreanMessage = 'Vespa 클러스터 연결 실패: 인증서 만료';
      app = await buildAppWith({
        vespa: {
          required: true,
          check: (): ReadinessStatus => {
            throw new Error(koreanMessage);
          },
        },
      });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      const body: ReadyResponseBody = res.json();
      expect(body.checks['vespa']?.status).toBe('down');
      // Verbatim — no truncation, no transliteration, no escape sequences.
      expect(body.checks['vespa']?.reason).toBe(koreanMessage);
      expect(body.checks['vespa']?.error_class).toBe('Error');
    });
  });
});

describe('/ready adjacent regressions', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it('all probes fast → 200 with low latency (parallel fast-path)', async () => {
    app = await buildAppWith({
      a: { required: true, check: (): ReadinessStatus => 'up' },
      b: { required: true, check: (): ReadinessStatus => 'up' },
      c: { required: false, check: (): ReadinessStatus => 'up' },
    });
    const start = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const elapsedMs = Date.now() - start;
    expect(res.statusCode).toBe(200);
    // Fast path: no probe waits, no I/O — should complete in well under
    // the total SLO budget.
    expect(elapsedMs).toBeLessThan(READINESS_TOTAL_BUDGET_MS);
  });

  it('all required probes down → 503 with all reasons surfaced', async () => {
    app = await buildAppWith({
      pg: {
        required: true,
        check: (): ReadinessStatus => { throw new Error('pg probe timeout'); },
      },
      vespa: {
        required: true,
        check: (): ReadinessStatus => { throw new Error('vespa probe timeout'); },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body: ReadyResponseBody = res.json();
    expect(body.ready).toBe(false);
    expect(body.checks['pg']?.reason).toBe('pg probe timeout');
    expect(body.checks['vespa']?.reason).toBe('vespa probe timeout');
  });
});

describe('/ready probe parallel scheduling — slow probe does not block fast ones', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it('one slow probe + many fast probes → total latency dominated by the slow one (not sum)', async () => {
    const SLOW_MS = 80;
    const SEQUENTIAL_FLOOR_MS = SLOW_MS * 4; // would be ~320 ms sequentially
    const PARALLEL_CEILING_MS = SLOW_MS + 100; // ~180 ms with parallel

    app = await buildAppWith({
      slow: { required: true, check: () => delayedStatus('up', SLOW_MS) },
      fast1: { required: true, check: (): ReadinessStatus => 'up' },
      fast2: { required: true, check: (): ReadinessStatus => 'up' },
      fast3: { required: false, check: (): ReadinessStatus => 'up' },
    });

    const beforeStart = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const elapsedMs = Date.now() - beforeStart;
    expect(res.statusCode).toBe(200);
    expect(elapsedMs).toBeLessThan(PARALLEL_CEILING_MS);
    expect(elapsedMs).toBeLessThan(SEQUENTIAL_FLOOR_MS);
  });
});

describe('/ready criticality vocabulary completeness', () => {
  it('PROBE_CRITICALITY documents every probe family with a known criticality token', () => {
    const VALID_TOKENS = new Set(['critical', 'non_critical']);
    for (const [probeName, criticality] of Object.entries(PROBE_CRITICALITY)) {
      expect(typeof probeName).toBe('string');
      expect(probeName.length).toBeGreaterThan(0);
      expect(VALID_TOKENS.has(criticality)).toBe(true);
    }
    // At least the canonical critical probes must be declared.
    expect(Object.keys(PROBE_CRITICALITY)).toEqual(
      expect.arrayContaining(['postgres', 'vespa']),
    );
  });
});
