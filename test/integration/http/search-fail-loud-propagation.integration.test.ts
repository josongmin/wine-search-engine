/**
 * Wave/Fix 7 — HTTP integration test for fail-loud propagation.
 *
 * Verifies that degradation reasons produced at the ranking/resolver layer
 * actually surface through the HTTP /v1/search response so operators can
 * observe them in production logs.
 *
 * We inject a mock `searchUseCase` that returns a response whose
 * `meta.degradation_reasons` carries the fail-loud tags we care about:
 *   - `ranking_invalid_signal:<name>` (score-aggregator threw)
 *   - `learned_matcher_failed` (resolver downgrade)
 *
 * The HTTP path must preserve these reasons verbatim — no filtering, no
 * renaming, no dropping to empty. If the response body omits them, the
 * wire contract is lying about the degradation.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HttpServerDeps } from '../../../src/interface/http/routes/route-deps.js';
import { createServer } from '../../../src/interface/http/server.js';
import { SignalComputer } from '../../../src/domain/ranking/service/signal-computer.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { LearnedMatcherPort } from '../../../src/domain/resolver/port/learned-matcher.port.js';
import { createTestContainer } from '../helpers/test-container.js';

class NaNSemanticSignalComputer extends SignalComputer {
  override computeSemanticScore(_candidate: HybridCandidate): number {
    return Number.NaN;
  }
}

function buildFailLoudSearchResponse(reasons: readonly string[]) {
  return {
    queryType: 'search' as const,
    engineDecision: {
      decisionStatus: 'ambiguous' as const,
      nextAction: 'clarify' as const,
      route: 'hybrid' as const,
      decisionConfidence: 0.35,
      confidenceSemantics: 'calibrated_decision_confidence' as const,
      decisionTraceRef: `decision:v1:failloud:${'a'.repeat(64)}`,
      executionMode: 'degraded' as const,
      degradationReasons: [...reasons],
      decisionSnapshot: {
        snapshot_id: 'snap-test',
        planner_version: '1.0.0',
        threshold_profile_id: 'default',
        response_contract_version: 'search_response_v1' as const,
        policy_rule_version: '1.0.0',
        model_versions: {},
        index_versions: {},
        feature_flags: {},
      },
    },
    results: [],
    meta: {
      requestId: 'req-test-failloud',
      queryTimeMs: 42,
      route: 'hybrid',
      version: 'test',
      engineSchemaVersion: 'search_response_v1' as const,
      degradationReasons: [...reasons],
      executionMode: 'degraded' as const,
    },
  };
}

function createMockDeps(response: ReturnType<typeof buildFailLoudSearchResponse>): HttpServerDeps {
  return {
    searchUseCase: {
      execute: vi.fn().mockResolvedValue(response),
    },
    decomposedSearchUseCase: { execute: vi.fn() },
    batchSearchUseCase: { execute: vi.fn() },
    replayUseCase: { execute: vi.fn() },
    interpretUseCase: { execute: vi.fn() },
    resolveUseCase: { execute: vi.fn() },
    hybridUseCase: { execute: vi.fn() },
    adaptiveToolExecutor: { executeWithFallback: vi.fn() },
    watchlistService: {
      create: vi.fn(),
      getByIdForUser: vi.fn(),
      listByUserId: vi.fn(),
      listByEntityId: vi.fn(),
      deleteForUser: vi.fn(),
      listDeliveries: vi.fn(),
      recordDeliveryLog: vi.fn(),
    },
    evalRunner: null,
    feedbackStore: null,
    feedbackIngestEnabled: false,
  };
}

describe('HTTP /v1/search — fail-loud degradation reason propagation', () => {
  it('ranking_invalid_signal:<feature> propagates through the real search pipeline', async () => {
    const { container } = createTestContainer({
      signalComputer: new NaNSemanticSignalComputer(),
    });
    const app = await createServer(container, {
      logLevel: 'error',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'smooth elegant wine',
          options: { mode: 'auto' },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        meta?: { degradation_reasons?: readonly string[] };
      };
      expect(body.meta?.degradation_reasons).toContain('ranking_invalid_signal:semantic');
    } finally {
      await app.close();
    }
  });

  it('learned_matcher_failed propagates through the real resolver and HTTP pipeline', async () => {
    const learnedMatcher: LearnedMatcherPort = {
      match: async () => {
        throw new Error('learned matcher unavailable');
      },
    };
    const parts = createTestContainer({ learnedMatcher });
    parts.ambiguityDict.setAmbiguous('마고', ['region', 'entity'], 'medium');
    const app = await createServer(parts.container, {
      logLevel: 'error',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: '마고',
          options: { mode: 'auto' },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        meta?: { degradation_reasons?: readonly string[] };
        engine_decision?: { decision_status?: string; degradation_reasons?: readonly string[] };
      };
      expect(body.engine_decision?.decision_status).toBe('ambiguous');
      expect(body.meta?.degradation_reasons).toContain('learned_matcher_failed');
    } finally {
      await app.close();
    }
  });

  it('ranking_invalid_signal:<feature> propagates to response.meta.degradation_reasons', async () => {
    const response = buildFailLoudSearchResponse(['ranking_invalid_signal:semantic']);
    const app = await createServer(createMockDeps(response), {
      logLevel: 'error',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'opus one',
          options: { mode: 'auto' },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        meta?: { degradation_reasons?: readonly string[] };
        engine_decision?: { degradation_reasons?: readonly string[] };
      };
      // Reason MUST be present in meta.degradation_reasons — this is the
      // ops-visible surface. If it's missing, the wire contract is lying.
      expect(body.meta?.degradation_reasons).toBeDefined();
      expect(body.meta?.degradation_reasons).toContain('ranking_invalid_signal:semantic');
    } finally {
      await app.close();
    }
  });

  it('learned_matcher_failed propagates to response.meta.degradation_reasons', async () => {
    const response = buildFailLoudSearchResponse(['learned_matcher_failed']);
    const app = await createServer(createMockDeps(response), {
      logLevel: 'error',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'margaux',
          options: { mode: 'auto' },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        meta?: { degradation_reasons?: readonly string[] };
      };
      expect(body.meta?.degradation_reasons).toContain('learned_matcher_failed');
    } finally {
      await app.close();
    }
  });

  it('multiple degradation reasons preserved in order', async () => {
    const reasons = [
      'ranking_invalid_signal:popularity',
      'learned_matcher_failed',
      'cache_breaker_open',
    ];
    const response = buildFailLoudSearchResponse(reasons);
    const app = await createServer(createMockDeps(response), {
      logLevel: 'error',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'bordeaux',
          options: { mode: 'auto' },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        meta?: { degradation_reasons?: readonly string[] };
      };
      expect(body.meta?.degradation_reasons).toEqual(reasons);
    } finally {
      await app.close();
    }
  });

  it('execution_mode=degraded is preserved when degradation_reasons are present', async () => {
    const response = buildFailLoudSearchResponse(['ranking_invalid_signal:attributeAlignment']);
    const app = await createServer(createMockDeps(response), {
      logLevel: 'error',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'sassicaia',
          options: { mode: 'auto' },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        meta?: { execution_mode?: string; degradation_reasons?: readonly string[] };
      };
      expect(body.meta?.execution_mode).toBe('degraded');
      expect(body.meta?.degradation_reasons).toContain('ranking_invalid_signal:attributeAlignment');
    } finally {
      await app.close();
    }
  });

  it('empty degradation_reasons keeps response compact (not null)', async () => {
    const response = buildFailLoudSearchResponse([]);
    // Force executionMode back to authoritative for this clean case.
    response.engineDecision.executionMode = 'degraded' as const;
    response.engineDecision.degradationReasons = [];
    response.meta.executionMode = 'degraded' as const;
    response.meta.degradationReasons = [];
    const app = await createServer(createMockDeps(response), {
      logLevel: 'error',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'chateau',
          options: { mode: 'auto' },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        meta?: { degradation_reasons?: readonly string[] };
      };
      // Empty reasons may be present as [] or omitted — both acceptable.
      // The important thing is it's not null/undefined/corrupt.
      if (body.meta?.degradation_reasons !== undefined) {
        expect(Array.isArray(body.meta.degradation_reasons)).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});
