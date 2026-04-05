/**
 * E2E edge-case tests for the Wine Search Engine.
 *
 * Covers Unicode/special character queries, input validation boundaries,
 * HTTP method/routing, response body integrity, concurrency isolation,
 * header/protocol edge cases, and endpoint-specific edge cases.
 *
 * Does NOT duplicate tests already in search-api.test.ts or hard-scenarios.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  json: () => unknown;
}

async function post(path: string, body: unknown): Promise<InjectResponse> {
  const response = await server.app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string | string[]>,
    body: response.body,
    json: () => JSON.parse(response.body) as unknown,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: Unicode and special character queries
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 1: Unicode and special character queries', () => {
  it('ASCII control characters in query — no 500 (null byte)', async () => {
    const res = await post('/v1/search', { query: 'Opus\x00One' });
    expect(res.statusCode).not.toBe(500);
    expect([200, 400]).toContain(res.statusCode);
  });

  it('ASCII control characters in query — no 500 (newline)', async () => {
    const res = await post('/v1/search', { query: 'test\nquery' });
    expect(res.statusCode).not.toBe(500);
    expect([200, 400]).toContain(res.statusCode);
  });

  it('ASCII control characters in query — no 500 (tab)', async () => {
    const res = await post('/v1/search', { query: 'test\tquery' });
    expect(res.statusCode).not.toBe(500);
    expect([200, 400]).toContain(res.statusCode);
  });

  it('XSS payload in query — sanitized, no 500', async () => {
    const res = await post('/v1/search', { query: '<script>alert("xss")</script>' });
    expect(res.statusCode).not.toBe(500);
    expect([200, 400]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const bodyStr = JSON.stringify(res.json());
      expect(bodyStr).not.toContain('<script>');
      expect(bodyStr).not.toContain('alert(');
    }
  });

  it('SQL injection payload — no 500', async () => {
    const res = await post('/v1/search', { query: "'; DROP TABLE entities; --" });
    expect(res.statusCode).not.toBe(500);
    expect([200, 400]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const bodyStr = JSON.stringify(res.json());
      expect(bodyStr).not.toContain('DROP TABLE');
      expect(bodyStr).not.toContain("'; ");
    }
  });

  it('very long query (2000 chars) — no 500', async () => {
    const res = await post('/v1/search', { query: '와인 '.repeat(400) });
    expect(res.statusCode).not.toBe(500);
    expect([200, 400]).toContain(res.statusCode);
  });

  it('emoji in query — processed without error', async () => {
    const res = await post('/v1/search', { query: '🍷 red wine recommendation' });
    expect(res.statusCode).toBe(200);
  });

  it('RTL characters (Arabic mixed with English) — no 500', async () => {
    const res = await post('/v1/search', { query: 'wine نبيذ أحمر' });
    expect(res.statusCode).not.toBe(500);
    expect([200, 400]).toContain(res.statusCode);
  });

  it('only digits — no 500 (vintage-style query)', async () => {
    const res = await post('/v1/search', { query: '2018' });
    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(200);
  });

  it('only punctuation — validated correctly (min(1) passes for 3 chars)', async () => {
    const res = await post('/v1/search', { query: '!!!' });
    expect(res.statusCode).not.toBe(500);
    // Zod min(1) checks length, '!!!' is 3 chars → valid string → 200
    expect([200, 400]).toContain(res.statusCode);
  });

  it('repeated Unicode whitespace (ideographic spaces) — not 500', async () => {
    // U+3000 = ideographic space; Zod min(1) passes raw length
    const res = await post('/v1/search', { query: '\u3000\u3000\u3000' });
    expect(res.statusCode).not.toBe(500);
  });

  it('Korean-English code-switching — returns 200', async () => {
    const res = await post('/v1/search', { query: '오푸스원 2018 Napa Valley' });
    expect(res.statusCode).toBe(200);
  });

  it('combining diacritical characters (NFD form) — NFC normalization handles it', async () => {
    // Construct a string with a combining grave accent after 'e' (Latin base)
    // 'Chateau\u0300 Margaux' — the \u0300 is a combining grave accent
    const nfdQuery = 'Chateau\u0300 Margaux';
    const res = await post('/v1/search', { query: nfdQuery });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const decision = body['engineDecision'] as Record<string, unknown>;
    expect(decision['decisionStatus']).not.toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: Input validation edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 2: Input validation edge cases', () => {
  it('query field is number type — Zod rejects with 400', async () => {
    const res = await post('/v1/search', { query: 42 });
    expect(res.statusCode).toBe(400);
  });

  it('query field is array — Zod rejects with 400', async () => {
    const res = await post('/v1/search', { query: ['Opus One'] });
    expect(res.statusCode).toBe(400);
  });

  it('query field is boolean — Zod rejects with 400', async () => {
    const res = await post('/v1/search', { query: true });
    expect(res.statusCode).toBe(400);
  });

  it('context with empty locale — Zod rejects with 400 (min(1))', async () => {
    const res = await post('/v1/search', {
      query: 'Opus One',
      context: { locale: '', currency: 'KRW' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('queryBudget with negative maxLatencyMs — Zod rejects with 400 (positive())', async () => {
    const res = await post('/v1/search', {
      query: 'Opus One',
      queryBudget: { maxLatencyMs: -100, maxCandidates: 10, rerankLimit: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('queryBudget with zero maxCandidates — Zod rejects with 400 (positive() means > 0)', async () => {
    const res = await post('/v1/search', {
      query: 'Opus One',
      queryBudget: { maxLatencyMs: 1000, maxCandidates: 0, rerankLimit: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('replay missing all required snapshot fields — returns 400', async () => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One',
      decision_snapshot: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('replay snapshot with wrong types (model_versions as string) — returns 400', async () => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One',
      decision_snapshot: {
        model_versions: 'not-an-object',
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: HTTP method and routing
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 3: HTTP method and routing', () => {
  it('GET /v1/search returns 404 (only POST supported)', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/search',
    });
    expect(response.statusCode).toBe(404);
  });

  it('PUT /v1/search returns 404', async () => {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(response.statusCode).toBe(404);
  });

  it('non-existent route returns 404', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/nonexistent',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(response.statusCode).toBe(404);
  });

  it('/v1/search with trailing slash — handled (not 500)', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search/',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });
    expect(response.statusCode).not.toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Response body integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 4: Response body integrity', () => {
  const MATCHING_SNAPSHOT = {
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
  };

  it('POST /v1/search response body is always valid JSON', async () => {
    const res = await post('/v1/search', { query: 'Opus One 2018' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error('Response is not valid JSON');
    }
    expect(parsed).toBeDefined();
  });

  it('POST /v1/search/hybrid response body is always valid JSON', async () => {
    const res = await post('/v1/search/hybrid', { query: '풀바디 레드 와인' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error('Response is not valid JSON');
    }
    expect(parsed).toBeDefined();
  });

  it('POST /v1/search/interpret response body is always valid JSON', async () => {
    const res = await post('/v1/search/interpret', { query: 'Opus One' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error('Response is not valid JSON');
    }
    expect(parsed).toBeDefined();
  });

  it('POST /v1/entity/resolve response body is always valid JSON', async () => {
    const res = await post('/v1/entity/resolve', { query: 'Opus One 2018' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error('Response is not valid JSON');
    }
    expect(parsed).toBeDefined();
  });

  it('POST /v1/search/replay response body is always valid JSON', async () => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: MATCHING_SNAPSHOT,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error('Response is not valid JSON');
    }
    expect(parsed).toBeDefined();
  });

  it('error response body is always valid JSON for bad requests', async () => {
    const res = await post('/v1/search', {});
    expect(res.statusCode).toBe(400);

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error('Response is not valid JSON');
    }

    const body = parsed as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(typeof error['code']).toBe('string');
    expect(typeof error['message']).toBe('string');
  });

  it('415 error response is valid JSON with UNSUPPORTED_MEDIA_TYPE code', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });

    expect(response.statusCode).toBe(415);

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error('Response is not valid JSON');
    }

    const body = parsed as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Concurrency and isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 5: Concurrency and isolation', () => {
  it('20 concurrent identical requests all return valid responses with unique X-Request-Id', async () => {
    const requests = Array.from({ length: 20 }, () =>
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: 'Opus One 2018' }),
      }),
    );

    const responses = await Promise.all(requests);

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body).toHaveProperty('engineDecision');
      expect(body).toHaveProperty('results');
    }

    const requestIds = responses.map((r) => {
      const val = r.headers['x-request-id'];
      return Array.isArray(val) ? (val[0] ?? '') : (val ?? '');
    });

    const uniqueIds = new Set(requestIds);
    expect(uniqueIds.size).toBe(20);
  });

  it('concurrent requests with different queries each return correct shape and unique X-Request-Id', async () => {
    const [entityRes, hybridRes, koreanRes] = await Promise.all([
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: 'Opus One 2018' }),
      }),
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: '풀바디 레드',
          options: { mode: 'hybrid' },
        }),
      }),
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: '마고' }),
      }),
    ]);

    expect(entityRes.statusCode).toBe(200);
    expect(hybridRes.statusCode).toBe(200);
    expect(koreanRes.statusCode).toBe(200);

    const getReqId = (r: { headers: Record<string, string | string[] | undefined> }) => {
      const val = r.headers['x-request-id'];
      return Array.isArray(val) ? (val[0] ?? '') : (val ?? '');
    };

    const ids = [getReqId(entityRes), getReqId(hybridRes), getReqId(koreanRes)];
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });

  it('concurrent replay requests are isolated — matching vs mismatched snapshots', async () => {
    const matchingSnapshot = {
      model_versions: {},
      index_versions: {},
      policy_rule_version: '1.0.0',
      threshold_profile_id: 'default',
      planner_version: '1.0.0',
      feature_flags: {},
    };

    const mismatchedSnapshot = {
      model_versions: { embedding: 'bge-m3-v2.0' },
      index_versions: {},
      policy_rule_version: '9.9.9',
      threshold_profile_id: 'custom',
      planner_version: '2.0.0',
      feature_flags: {},
    };

    const [matchingRes, mismatchedRes] = await Promise.all([
      server.app.inject({
        method: 'POST',
        url: '/v1/search/replay',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: 'Opus One 2018', decision_snapshot: matchingSnapshot }),
      }),
      server.app.inject({
        method: 'POST',
        url: '/v1/search/replay',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: 'Opus One 2018', decision_snapshot: mismatchedSnapshot }),
      }),
    ]);

    expect(matchingRes.statusCode).toBe(200);
    expect(mismatchedRes.statusCode).toBe(409);

    // Ensure results don't bleed between requests
    const matchingBody = JSON.parse(matchingRes.body) as Record<string, unknown>;
    const mismatchedBody = JSON.parse(mismatchedRes.body) as Record<string, unknown>;

    expect(matchingBody).toHaveProperty('engineDecision');
    expect(mismatchedBody).toHaveProperty('error');
    const error = mismatchedBody['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SNAPSHOT_MISMATCH');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Header and protocol edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 6: Header and protocol edge cases', () => {
  it('X-Request-Id is always present in response regardless of caller header', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'client-provided-id-12345',
      },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });

    expect(response.statusCode).toBe(200);
    const xRequestId = response.headers['x-request-id'];
    const idValue = Array.isArray(xRequestId) ? (xRequestId[0] ?? '') : (xRequestId ?? '');
    expect(idValue).toBeTruthy();
  });

  it('Accept: application/json is accepted', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });

    expect(response.statusCode).toBe(200);
  });

  it('Accept: */* is accepted', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        'content-type': 'application/json',
        'accept': '*/*',
      },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });

    expect(response.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7: Interpret endpoint edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 7: Interpret endpoint edge cases', () => {
  it('/v1/search/interpret with Korean mixed query — rawQuery preserved exactly', async () => {
    const query = '오푸스원 같은 가성비 와인';
    const res = await post('/v1/search/interpret', { query });

    expect(res.statusCode).toBe(200);
    const plan = res.json() as Record<string, unknown>;
    expect(plan['rawQuery']).toBe(query);
    expect(plan['normalizedQuery']).toBeTruthy();
    expect(['entity', 'hybrid', 'mixed']).toContain(plan['route']);
  });

  it('plannerVersion is semver-like string (starts with X.Y)', async () => {
    const res = await post('/v1/search/interpret', { query: 'Opus One' });

    expect(res.statusCode).toBe(200);
    const plan = res.json() as Record<string, unknown>;
    expect(typeof plan['plannerVersion']).toBe('string');
    expect(plan['plannerVersion'] as string).toMatch(/^\d+\.\d+/);
  });

  it('constraints is always an object (not null/undefined)', async () => {
    const res = await post('/v1/search/interpret', {
      query: '풀바디 레드 와인 10만원 이하',
    });

    expect(res.statusCode).toBe(200);
    const plan = res.json() as Record<string, unknown>;
    expect(typeof plan['constraints']).toBe('object');
    expect(plan['constraints']).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 8: Resolve endpoint edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 8: Resolve endpoint edge cases', () => {
  it('/v1/entity/resolve returns correct shape for known entity', async () => {
    const res = await post('/v1/entity/resolve', { query: 'Opus One 2018' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(['resolved', 'ambiguous', 'failed']).toContain(body['status']);
    expect(Array.isArray(body['candidates'])).toBe(true);
    expect(typeof body['decision_trace_ref']).toBe('string');
  });

  it('/v1/entity/resolve for ambiguous query returns candidates array', async () => {
    const res = await post('/v1/entity/resolve', { query: '마고' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Array.isArray(body['candidates'])).toBe(true);
  });

  it('/v1/entity/resolve for completely unknown query has ambiguous or failed status', async () => {
    const res = await post('/v1/entity/resolve', {
      query: 'zzz_extremely_unknown_wine_xyz_9999',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Unknown entity should not resolve
    expect(['ambiguous', 'failed']).toContain(body['status']);
  });
});
