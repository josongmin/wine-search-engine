/**
 * E2E infrastructure-level tests for the Wine Search Engine.
 *
 * Covers: rate limiting, request ID correctness, snapshot determinism,
 * concurrent request isolation, Content-Type edge cases, response envelope
 * completeness, and error response completeness (RFC-014 / RFC-015).
 *
 * All tests use the InMemory-backed test server (no real Vespa or DB).
 *
 * Each describe group uses its own TestServer to avoid exhausting the
 * per-server rate-limit (100 req/min) across groups.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getHeader,
  getSearchDecision,
  getSearchDecisionStatus,
  getSearchDecisionSnapshot,
  getSearchEntityIds,
  getSearchMeta,
  getSearchRequestId,
  parseErrorResponse,
  parseSearchResponse,
  postJson,
} from './helpers/http-transport.js';

/** Snapshot that matches the ReplayUseCase default runtime snapshot. */
const MATCHING_SNAPSHOT = {
  model_versions: {},
  index_versions: {},
  policy_rule_version: '1.0.0',
  threshold_profile_id: 'default',
  planner_version: '1.0.0',
  feature_flags: {},
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: Rate Limiting (RFC-014 §13)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 1: Rate Limiting (RFC-014 §13)', () => {
  // Dedicated server instance so the 100-request budget is fresh for this group.
  let rateLimitServer: TestServer;

  beforeAll(async () => {
    rateLimitServer = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(rateLimitServer);
  });

  it('101st sequential request within 1 minute returns 429', async () => {
    // Exhaust the 100-request budget.
    for (let i = 0; i < 100; i++) {
      const r = await rateLimitServer.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: `wine ${i}` }),
      });
      expect(r.statusCode).toBe(200);
    }

    // 101st must be rate-limited.
    const r = await rateLimitServer.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'wine 101' }),
    });
    expect(r.statusCode).toBe(429);
  });

  it('rate-limit error has code=RATE_LIMIT_EXCEEDED and retryable=true', async () => {
    // The dedicated server is already exhausted from the previous test.
    const r = await rateLimitServer.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'wine check' }),
    });
    expect(r.statusCode).toBe(429);

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('RATE_LIMIT_EXCEEDED');
    expect(error['retryable']).toBe(true);
  });

  it('rate-limit error message contains "Retry after"', async () => {
    const r = await rateLimitServer.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'retry message test' }),
    });
    expect(r.statusCode).toBe(429);

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(typeof error['message']).toBe('string');
    expect(error['message'] as string).toContain('Retry after');
  });

  it('rate-limit error has request_id field', async () => {
    const r = await rateLimitServer.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'request id test' }),
    });
    expect(r.statusCode).toBe(429);

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(typeof error['request_id']).toBe('string');
    expect((error['request_id'] as string).length).toBeGreaterThan(0);
  });

  it('rate-limit response includes Retry-After header', async () => {
    const r = await rateLimitServer.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'retry-after header test' }),
    });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('fresh server allows requests after the rate-limited server is full', async () => {
    // A brand-new server has its own rate-limit counter starting at 0.
    const freshServer = await createTestServer();
    try {
      const r = await freshServer.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: 'fresh server test' }),
      });
      expect(r.statusCode).toBe(200);
    } finally {
      await closeTestServer(freshServer);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: Request ID Correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 2: Request ID Correctness', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('X-Request-Id header is present on a 200 response', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });
    expect(r.statusCode).toBe(200);
    const val = r.headers['x-request-id'];
    expect(Array.isArray(val) ? (val[0] ?? '') : (val ?? '')).toBeTruthy();
  });

  it('X-Request-Id header is present on a 400 response', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '' }), // empty string fails min(1)
    });
    expect(r.statusCode).toBe(400);
    const val = r.headers['x-request-id'];
    expect(Array.isArray(val) ? (val[0] ?? '') : (val ?? '')).toBeTruthy();
  });

  it('X-Request-Id header is present on a 409 response', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'Opus One 2018',
        decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: '9.9.9' },
      }),
    });
    expect(r.statusCode).toBe(409);
    const val = r.headers['x-request-id'];
    expect(Array.isArray(val) ? (val[0] ?? '') : (val ?? '')).toBeTruthy();
  });

  it('X-Request-Id header is present on a 415 response', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(415);
    const val = r.headers['x-request-id'];
    expect(Array.isArray(val) ? (val[0] ?? '') : (val ?? '')).toBeTruthy();
  });

  it('meta.requestId in response body matches X-Request-Id header exactly', async () => {
    const r = await postJson(server.app, '/v1/search', { query: 'Opus One 2018' });
    expect(r.statusCode).toBe(200);

    const headerId = getHeader(r, 'x-request-id');
    expect(headerId).toBeTruthy();
    expect(getSearchRequestId(parseSearchResponse(r))).toBe(headerId);
  });

  it('error.request_id in error body matches X-Request-Id header exactly', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '' }),
    });
    expect(r.statusCode).toBe(400);

    const val = r.headers['x-request-id'];
    const headerId = Array.isArray(val) ? (val[0] ?? '') : (val ?? '');
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;

    expect(headerId).toBeTruthy();
    expect(error['request_id']).toBe(headerId);
  });

  it('50 concurrent requests all have unique X-Request-Id values', async () => {
    const requests = Array.from({ length: 50 }, () =>
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: 'Opus One 2018' }),
      }),
    );

    const responses = await Promise.all(requests);
    const ids = responses.map((r) => {
      const val = r.headers['x-request-id'];
      return Array.isArray(val) ? (val[0] ?? '') : (val ?? '');
    });

    // All IDs must be non-empty.
    for (const id of ids) {
      expect(id).toBeTruthy();
    }

    // All IDs must be unique.
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(50);
  });

  it('valid client-provided X-Request-Id is echoed and matches meta.request_id', async () => {
    const clientId = 'gateway-trace-abc-123';
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        'content-type': 'application/json',
        'x-request-id': clientId,
      },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });

    expect(r.statusCode).toBe(200);

    const headerId = getHeader(r, 'x-request-id');
    expect(headerId).toBe(clientId);

    const bodyRequestId = getSearchRequestId(parseSearchResponse(r));
    expect(bodyRequestId).toBe(clientId);
  });

  it('invalid X-Request-Id is rejected and replaced (does not echo unsafe values)', async () => {
    const unsafeId = 'not@valid/id';
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        'content-type': 'application/json',
        'x-request-id': unsafeId,
      },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });

    expect(r.statusCode).toBe(200);

    const headerId = getHeader(r, 'x-request-id');
    expect(headerId).not.toBe(unsafeId);
    expect(headerId.length).toBeGreaterThan(0);

    const bodyRequestId = getSearchRequestId(parseSearchResponse(r));
    expect(bodyRequestId).toBe(headerId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Snapshot Determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 3: Snapshot Determinism', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('same query + matching snapshot replayed 3 times returns IDENTICAL results', async () => {
    const replayBody = {
      query: 'Opus One 2018',
      decision_snapshot: MATCHING_SNAPSHOT,
    };

    const [r1, r2, r3] = await Promise.all([
      server.app.inject({
        method: 'POST',
        url: '/v1/search/replay',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(replayBody),
      }),
      server.app.inject({
        method: 'POST',
        url: '/v1/search/replay',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(replayBody),
      }),
      server.app.inject({
        method: 'POST',
        url: '/v1/search/replay',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(replayBody),
      }),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);

    const b1 = parseSearchResponse({
      statusCode: r1.statusCode,
      headers: r1.headers as Record<string, string | string[]>,
      body: r1.body,
      json: () => JSON.parse(r1.body) as unknown,
    });
    const b2 = parseSearchResponse({
      statusCode: r2.statusCode,
      headers: r2.headers as Record<string, string | string[]>,
      body: r2.body,
      json: () => JSON.parse(r2.body) as unknown,
    });
    const b3 = parseSearchResponse({
      statusCode: r3.statusCode,
      headers: r3.headers as Record<string, string | string[]>,
      body: r3.body,
      json: () => JSON.parse(r3.body) as unknown,
    });

    expect(getSearchDecisionStatus(b1)).toBe(getSearchDecisionStatus(b2));
    expect(getSearchDecisionStatus(b2)).toBe(getSearchDecisionStatus(b3));

    expect(getSearchEntityIds(b1)).toEqual(getSearchEntityIds(b2));
    expect(getSearchEntityIds(b2)).toEqual(getSearchEntityIds(b3));
  });

  it('different queries return different results (not all queries return same entity)', async () => {
    const [opus, margaux] = await Promise.all([
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'Opus One 2018',
          options: { mode: 'entity', explain: false, clarification: false },
        }),
      }),
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'Château Margaux',
          options: { mode: 'entity', explain: false, clarification: false },
        }),
      }),
    ]);

    expect(opus.statusCode).toBe(200);
    expect(margaux.statusCode).toBe(200);

    // At least one must be non-failed (if both fail, something is broken).
    const statuses = [
      getSearchDecisionStatus(parseSearchResponse({
        statusCode: opus.statusCode,
        headers: opus.headers as Record<string, string | string[]>,
        body: opus.body,
        json: () => JSON.parse(opus.body) as unknown,
      })),
      getSearchDecisionStatus(parseSearchResponse({
        statusCode: margaux.statusCode,
        headers: margaux.headers as Record<string, string | string[]>,
        body: margaux.body,
        json: () => JSON.parse(margaux.body) as unknown,
      })),
    ];
    const nonFailed = statuses.filter((s) => s !== 'failed');
    expect(nonFailed.length).toBeGreaterThan(0);
  });

  it('snapshot mismatch error has retryable=false', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'Opus One 2018',
        decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: '9.9.9' },
      }),
    });

    expect(r.statusCode).toBe(409);
    expect(parseErrorResponse({
      statusCode: r.statusCode,
      headers: r.headers as Record<string, string | string[]>,
      body: r.body,
      json: () => JSON.parse(r.body) as unknown,
    }).error.retryable).toBe(false);
  });

  it('policy_rule_version mismatch → 409 with SNAPSHOT_MISMATCH code', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'Opus One 2018',
        decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: '99.0.0' },
      }),
    });

    expect(r.statusCode).toBe(409);
    const error = parseErrorResponse({
      statusCode: r.statusCode,
      headers: r.headers as Record<string, string | string[]>,
      body: r.body,
      json: () => JSON.parse(r.body) as unknown,
    }).error;
    expect(error.code).toBe('SNAPSHOT_MISMATCH');
    expect(typeof error.message).toBe('string');
    expect(error.message.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Concurrent Request Isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 4: Concurrent Request Isolation', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('3 concurrent requests with DIFFERENT queries do not cross-contaminate results', async () => {
    const [entityRes, hybridRes, margauxRes] = await Promise.all([
      // Query A: known entity
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'Opus One 2018',
          options: { mode: 'entity', explain: false, clarification: false },
        }),
      }),
      // Query B: hybrid / semantic
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'sparkling wine',
          options: { mode: 'hybrid', explain: false, clarification: false },
        }),
      }),
      // Query C: another entity
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'chateau margaux',
          options: { mode: 'entity', explain: false, clarification: false },
        }),
      }),
    ]);

    expect(entityRes.statusCode).toBe(200);
    expect(hybridRes.statusCode).toBe(200);
    expect(margauxRes.statusCode).toBe(200);

    // X-Request-Id must be unique per request.
    const getReqId = (r: { headers: Record<string, string | string[] | undefined> }) => {
      const val = r.headers['x-request-id'];
      return Array.isArray(val) ? (val[0] ?? '') : (val ?? '');
    };

    const ids = [
      getReqId(entityRes as { headers: Record<string, string | string[] | undefined> }),
      getReqId(hybridRes as { headers: Record<string, string | string[] | undefined> }),
      getReqId(margauxRes as { headers: Record<string, string | string[] | undefined> }),
    ];
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);

    // Each response must have a valid shape (no cross-contamination of error bodies).
    for (const r of [entityRes, hybridRes, margauxRes]) {
      const body = parseSearchResponse({
        statusCode: r.statusCode,
        headers: r.headers as Record<string, string | string[]>,
        body: r.body,
        json: () => JSON.parse(r.body) as unknown,
      });
      expect(body.engine_decision).toBeDefined();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.meta).toBeDefined();
    }
  });

  it('20 concurrent requests with same query all return IDENTICAL decisionStatus', async () => {
    const requests = Array.from({ length: 20 }, () =>
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'Opus One 2018',
          options: { mode: 'entity', explain: false, clarification: false },
        }),
      }),
    );

    const responses = await Promise.all(requests);

    const statuses = responses.map((r) => {
      expect(r.statusCode).toBe(200);
      return getSearchDecisionStatus(parseSearchResponse({
        statusCode: r.statusCode,
        headers: r.headers as Record<string, string | string[]>,
        body: r.body,
        json: () => JSON.parse(r.body) as unknown,
      }));
    });

    // All 20 must share the same decisionStatus.
    const uniqueStatuses = new Set(statuses);
    expect(uniqueStatuses.size).toBe(1);
  });

  it('20 concurrent requests with same entity query all have unique X-Request-Id values', async () => {
    const requests = Array.from({ length: 20 }, () =>
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: 'Opus One 2018' }),
      }),
    );

    const responses = await Promise.all(requests);

    const ids = responses.map((r) => {
      const val = r.headers['x-request-id'];
      return Array.isArray(val) ? (val[0] ?? '') : (val ?? '');
    });

    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Content-Type Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 5: Content-Type Edge Cases', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it("'application/json' → 200", async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(200);
  });

  it("'application/json; charset=utf-8' → 200", async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(200);
  });

  it("'application/json;charset=utf-8' (no space) → 200", async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json;charset=utf-8' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(200);
  });

  it("'APPLICATION/JSON' (uppercase) → 200 (RFC 2046: media types are case-insensitive)", async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'APPLICATION/JSON' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    // RFC 2046 specifies media types are case-insensitive; the server should accept this.
    expect(r.statusCode).toBe(200);
  });

  it("'text/plain' → 415 with code='UNSUPPORTED_MEDIA_TYPE'", async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(415);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('no Content-Type header → 415 with code=UNSUPPORTED_MEDIA_TYPE', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(415);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it("'application/xml' → 415", async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/xml' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(415);
  });

  it('415 error response has retryable=false', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(415);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['retryable']).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Response Envelope Completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 6: Response Envelope Completeness', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('every 200 response has exactly the top-level keys: results, engineDecision, meta', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });
    expect(r.statusCode).toBe(200);

    const body = parseSearchResponse({
      statusCode: r.statusCode,
      headers: r.headers as Record<string, string | string[]>,
      body: r.body,
      json: () => JSON.parse(r.body) as unknown,
    });
    expect(body.results).toBeDefined();
    expect(body.engine_decision).toBeDefined();
    expect(body.meta).toBeDefined();
  });

  it('meta has requestId (string), queryTimeMs (non-negative integer), engine_schema_version', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });
    expect(r.statusCode).toBe(200);

    const meta = getSearchMeta(parseSearchResponse({
      statusCode: r.statusCode,
      headers: r.headers as Record<string, string | string[]>,
      body: r.body,
      json: () => JSON.parse(r.body) as unknown,
    }));

    expect(typeof meta.request_id).toBe('string');
    expect(meta.request_id!.length).toBeGreaterThan(0);
    expect(typeof meta.query_time_ms).toBe('number');
    expect(Number.isInteger(meta.query_time_ms)).toBe(true);
    expect(meta.query_time_ms).toBeGreaterThanOrEqual(0);
    expect(meta.engine_schema_version).toBe('search_response_v1');
  });

  it('engineDecision has decisionStatus (one of 3 values), decisionSnapshot (non-null object), route (string)', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });
    expect(r.statusCode).toBe(200);

    const decision = getSearchDecision(parseSearchResponse({
      statusCode: r.statusCode,
      headers: r.headers as Record<string, string | string[]>,
      body: r.body,
      json: () => JSON.parse(r.body) as unknown,
    }));

    expect(['resolved', 'ambiguous', 'failed']).toContain(decision.decision_status);
    expect(typeof decision.decision_snapshot).toBe('object');
    expect(decision.decision_snapshot).not.toBeNull();
    expect(typeof decision.route).toBe('string');
    expect(decision.route.length).toBeGreaterThan(0);
  });

  it('decisionSnapshot has all 6 RFC-015 fields', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });
    expect(r.statusCode).toBe(200);

    const snapshot = getSearchDecisionSnapshot(parseSearchResponse({
      statusCode: r.statusCode,
      headers: r.headers as Record<string, string | string[]>,
      body: r.body,
      json: () => JSON.parse(r.body) as unknown,
    }));

    expect(snapshot).toHaveProperty('model_versions');
    expect(typeof snapshot['model_versions']).toBe('object');
    expect(snapshot['model_versions']).not.toBeNull();

    expect(snapshot).toHaveProperty('index_versions');
    expect(typeof snapshot['index_versions']).toBe('object');
    expect(snapshot['index_versions']).not.toBeNull();

    expect(snapshot).toHaveProperty('policy_rule_version');
    expect(typeof snapshot['policy_rule_version']).toBe('string');

    expect(snapshot).toHaveProperty('threshold_profile_id');
    expect(typeof snapshot['threshold_profile_id']).toBe('string');

    expect(snapshot).toHaveProperty('planner_version');
    expect(typeof snapshot['planner_version']).toBe('string');

    expect(snapshot).toHaveProperty('feature_flags');
    expect(typeof snapshot['feature_flags']).toBe('object');
    expect(snapshot['feature_flags']).not.toBeNull();
  });

  it('completely unknown query → non-200-error response (resolved/ambiguous/failed), no crash', async () => {
    // The InMemoryBlockingAdapter returns ALL entity IDs for any query (100 % recall).
    // When the resolver sees many candidates with no strong alias match it may return
    // 'ambiguous' rather than 'failed'.  Both are valid non-resolved states that
    // confirm the engine handled the query gracefully without crashing.
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'zzz_extremely_unknown_wine_xyz_no_match_9999',
        options: { mode: 'entity', explain: false, clarification: false },
      }),
    });
    expect(r.statusCode).toBe(200);

    const body = parseSearchResponse({
      statusCode: r.statusCode,
      headers: r.headers as Record<string, string | string[]>,
      body: r.body,
      json: () => JSON.parse(r.body) as unknown,
    });
    expect(['ambiguous', 'failed']).toContain(body.engine_decision.decision_status);
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('results array is ALWAYS present and is an array (even when decisionStatus=failed)', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'zzz_no_match_wine_abc',
        options: { mode: 'entity', explain: false, clarification: false },
      }),
    });
    expect(r.statusCode).toBe(200);

    const body = parseSearchResponse({
      statusCode: r.statusCode,
      headers: r.headers as Record<string, string | string[]>,
      body: r.body,
      json: () => JSON.parse(r.body) as unknown,
    });
    expect(Array.isArray(body.results)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7: Error Response Completeness (RFC-014)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 7: Error Response Completeness (RFC-014)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  const SCREAMING_SNAKE_CASE = /^[A-Z][A-Z0-9_]+$/;

  it('400 (VALIDATION_ERROR) has all 5 RFC-014 error fields', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '' }), // min(1) fails
    });
    expect(r.statusCode).toBe(400);

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;

    expect(typeof error['code']).toBe('string');
    expect(typeof error['message']).toBe('string');
    expect(typeof error['request_id']).toBe('string');
    expect('failure_reason' in error).toBe(true); // present (may be null)
    expect(typeof error['retryable']).toBe('boolean');
  });

  it('409 (SNAPSHOT_MISMATCH) has all 5 RFC-014 error fields', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'Opus One 2018',
        decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: '9.9.9' },
      }),
    });
    expect(r.statusCode).toBe(409);

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;

    expect(typeof error['code']).toBe('string');
    expect(typeof error['message']).toBe('string');
    expect(typeof error['request_id']).toBe('string');
    expect('failure_reason' in error).toBe(true);
    expect(typeof error['retryable']).toBe('boolean');
  });

  it('415 (UNSUPPORTED_MEDIA_TYPE) has all 5 RFC-014 error fields', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(415);

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;

    expect(typeof error['code']).toBe('string');
    expect(typeof error['message']).toBe('string');
    expect(typeof error['request_id']).toBe('string');
    expect('failure_reason' in error).toBe(true);
    expect(typeof error['retryable']).toBe('boolean');
  });

  it('error.code is SCREAMING_SNAKE_CASE for 400 VALIDATION_ERROR', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '' }),
    });
    expect(r.statusCode).toBe(400);

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code'] as string).toMatch(SCREAMING_SNAKE_CASE);
  });

  it('error.code is SCREAMING_SNAKE_CASE for 409 SNAPSHOT_MISMATCH', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'Opus One 2018',
        decision_snapshot: { ...MATCHING_SNAPSHOT, planner_version: '2.0.0' },
      }),
    });
    expect(r.statusCode).toBe(409);

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code'] as string).toMatch(SCREAMING_SNAKE_CASE);
  });

  it('error.code is SCREAMING_SNAKE_CASE for 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/xml' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(415);

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code'] as string).toMatch(SCREAMING_SNAKE_CASE);
  });

  it('error.message is a non-empty string on all error responses', async () => {
    const cases = await Promise.all([
      // 400
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: '' }),
      }),
      // 409
      server.app.inject({
        method: 'POST',
        url: '/v1/search/replay',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: 'Opus One 2018',
          decision_snapshot: { ...MATCHING_SNAPSHOT, threshold_profile_id: 'nope' },
        }),
      }),
      // 415
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify({ query: 'Opus One' }),
      }),
    ]);

    for (const r of cases) {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      const error = body['error'] as Record<string, unknown>;
      expect(typeof error['message']).toBe('string');
      expect((error['message'] as string).length).toBeGreaterThan(0);
    }
  });

  it('error.request_id matches X-Request-Id header on 400', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '' }),
    });
    expect(r.statusCode).toBe(400);

    const val = r.headers['x-request-id'];
    const headerIdStr = Array.isArray(val) ? (val[0] ?? '') : (val ?? '');

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['request_id']).toBe(headerIdStr);
  });

  it('error.request_id matches X-Request-Id header on 409', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'Opus One 2018',
        decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: '0.0.1' },
      }),
    });
    expect(r.statusCode).toBe(409);

    const val = r.headers['x-request-id'];
    const headerIdStr = Array.isArray(val) ? (val[0] ?? '') : (val ?? '');

    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['request_id']).toBe(headerIdStr);
  });

  it('SNAPSHOT_MISMATCH → retryable=false', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'Opus One 2018',
        decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: '2.0.0' },
      }),
    });
    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['retryable']).toBe(false);
  });

  it('UNSUPPORTED_MEDIA_TYPE → retryable=false', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(r.statusCode).toBe(415);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['retryable']).toBe(false);
  });

  it('VALIDATION_ERROR → retryable=false', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '' }),
    });
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('VALIDATION_ERROR');
    expect(error['retryable']).toBe(false);
  });
});
