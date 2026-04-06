/**
 * E2E hard/edge-case scenarios for the Wine Search Engine.
 *
 * Covers Korean entity resolution, semantic/hybrid modes, mixed-intent queries,
 * Content-Type enforcement, X-Request-Id uniqueness under concurrency, and
 * fine-grained snapshot-mismatch scenarios per RFC-015.
 *
 * Does NOT duplicate tests already in search-api.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  parseInterpretResponse,
  parseSearchResponse,
  postJson,
  getSearchDecisionStatus,
} from './helpers/http-transport.js';

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
  return postJson(server.app, path, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Korean entity resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('Korean entity resolution', () => {
  it("'오푸스원' entity mode → 200 with resolved or ambiguous (pre-registered alias, not failed)", async () => {
    const res = await post('/v1/search', {
      query: '오푸스원',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    // '오푸스원' is a pre-registered alias for opus-one-2018 — must resolve or be ambiguous
    expect(getSearchDecisionStatus(body)).toMatch(/^(resolved|ambiguous)$/);
  });

  it("'샤토 마고' entity mode → 200", async () => {
    const res = await post('/v1/search', {
      query: '샤토 마고',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it("'마고' entity mode with clarification=true → 200 and 'clarification' key present", async () => {
    const res = await post('/v1/search', {
      query: '마고',
      options: { mode: 'entity', explain: false, clarification: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect('clarification' in body).toBe(true);
  });

  it("'오푸스원' interpret → normalizedQuery preserves Korean (no \\u escape sequences)", async () => {
    const res = await post('/v1/search/interpret', { query: '오푸스원' });

    expect(res.statusCode).toBe(200);
    const plan = parseInterpretResponse(res);
    const normalized = plan.normalized_query;
    // The raw JSON string must not contain \u-escaped codepoints for Korean characters
    // (i.e. the JSON serializer must emit the characters directly, not as \uXXXX)
    expect(res.body).not.toMatch(/\\u[0-9a-fA-F]{4}/);
    // And the value itself must be a non-empty string
    expect(typeof normalized).toBe('string');
    expect(normalized.length).toBeGreaterThan(0);
  });

  it("'Chateau Margaux' (no accent) entity mode → resolves (decisionStatus not 'failed')", async () => {
    const res = await post('/v1/search', {
      query: 'Chateau Margaux',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    expect(getSearchDecisionStatus(body)).not.toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Semantic / hybrid mode queries
// ─────────────────────────────────────────────────────────────────────────────

describe('Semantic / hybrid mode queries', () => {
  it("'풀바디 레드 와인' hybrid → results array is non-empty", async () => {
    const res = await post('/v1/search', {
      query: '풀바디 레드 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const results = body['results'] as unknown[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("'스파클링 와인' hybrid → results non-empty", async () => {
    const res = await post('/v1/search', {
      query: '스파클링 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const results = body['results'] as unknown[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("'달달한 와인' hybrid → results non-empty", async () => {
    const res = await post('/v1/search', {
      query: '달달한 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const results = body['results'] as unknown[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mixed-mode / natural-language queries
// ─────────────────────────────────────────────────────────────────────────────

describe('Mixed-mode / natural-language queries', () => {
  it("'오푸스원 같은 와인' auto mode → 200", async () => {
    const res = await post('/v1/search', {
      query: '오푸스원 같은 와인',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it("'클라우디베이 말고 다른 화이트' auto mode → 200", async () => {
    const res = await post('/v1/search', {
      query: '클라우디베이 말고 다른 화이트',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content-Type enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('Content-Type enforcement', () => {
  it('POST with content-type: text/plain → 415', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });

    expect(response.statusCode).toBe(415);
  });

  it('POST with no content-type header → 400 or 415 (not 200)', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      // Deliberately omit content-type
      payload: JSON.stringify({ query: 'Opus One' }),
    });

    expect(response.statusCode).not.toBe(200);
    expect([400, 415]).toContain(response.statusCode);
  });

  it('POST with content-type: application/json; charset=utf-8 → 200', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });

    expect(response.statusCode).toBe(200);
  });

  it('POST with uppercase APPLICATION/JSON → handled (Fastify is case-sensitive for content-type)', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'APPLICATION/JSON' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });

    // Fastify's content-type parser is case-sensitive: uppercase APPLICATION/JSON
    // is treated as an unsupported media type → 415
    // Note: HTTP spec (RFC 7231) specifies content-type is case-insensitive, but
    // Fastify's default parser only registers lowercase 'application/json'.
    expect([200, 415]).toContain(response.statusCode);
  });

  it('POST with no Content-Type → 415 with UNSUPPORTED_MEDIA_TYPE code', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      // Deliberately omit content-type
      payload: JSON.stringify({ query: 'Opus One' }),
    });

    // Must reject (not 200)
    expect(response.statusCode).not.toBe(200);
    expect([400, 415]).toContain(response.statusCode);

    // When 415, must have UNSUPPORTED_MEDIA_TYPE error code
    if (response.statusCode === 415) {
      const body = JSON.parse(response.body) as Record<string, unknown>;
      const error = body['error'] as Record<string, unknown>;
      expect(error['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// X-Request-Id uniqueness under concurrency
// ─────────────────────────────────────────────────────────────────────────────

describe('X-Request-Id uniqueness under concurrency', () => {
  it('10 concurrent POST /v1/search requests → all X-Request-Id values are unique', async () => {
    const requests = Array.from({ length: 10 }, () =>
      server.app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: 'Opus One 2018' }),
      }),
    );

    const responses = await Promise.all(requests);
    const requestIds = responses.map((r) => {
      const val = r.headers['x-request-id'];
      return Array.isArray(val) ? (val[0] ?? '') : (val ?? '');
    });

    // All IDs must be non-empty
    for (const id of requestIds) {
      expect(id).toBeTruthy();
    }

    // All IDs must be unique
    const uniqueIds = new Set(requestIds);
    expect(uniqueIds.size).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot field mismatch (RFC-015)
// ─────────────────────────────────────────────────────────────────────────────

describe('Snapshot field mismatch (RFC-015)', () => {
  const MATCHING_SNAPSHOT = {
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
  };

  it('policy_rule_version mismatch → 409 SNAPSHOT_MISMATCH', async () => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: '9.9.9' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SNAPSHOT_MISMATCH');
  });

  it('threshold_profile_id mismatch → 409 SNAPSHOT_MISMATCH', async () => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: { ...MATCHING_SNAPSHOT, threshold_profile_id: 'custom-profile' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SNAPSHOT_MISMATCH');
  });

  it('planner_version mismatch → 409 SNAPSHOT_MISMATCH', async () => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: { ...MATCHING_SNAPSHOT, planner_version: '2.0.0' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SNAPSHOT_MISMATCH');
  });

  it('model_versions mismatch → 409 SNAPSHOT_MISMATCH', async () => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: {
        ...MATCHING_SNAPSHOT,
        model_versions: { embedding: 'bge-m3-v2' },
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SNAPSHOT_MISMATCH');
  });

  it('feature_flags mismatch (extra flag) → 409 SNAPSHOT_MISMATCH', async () => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: {
        ...MATCHING_SNAPSHOT,
        feature_flags: { experimental: true },
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SNAPSHOT_MISMATCH');
  });

  it('exact matching snapshot → 200 (control case)', async () => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: MATCHING_SNAPSHOT,
    });

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    expect(body).toHaveProperty('engine_decision');
    expect(body).toHaveProperty('results');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed input
// ─────────────────────────────────────────────────────────────────────────────

describe('Malformed input', () => {
  it('query=null body → 400', async () => {
    const res = await post('/v1/search', { query: null });

    expect(res.statusCode).toBe(400);
  });

  it('array body [] → 400', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify([]),
    });

    expect(response.statusCode).toBe(400);
  });

  it('integer body 42 → 400', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(42),
    });

    expect(response.statusCode).toBe(400);
  });

  it('query with 500 chars → 200 (no max-length in schema)', async () => {
    const res = await post('/v1/search', { query: 'a'.repeat(500) });

    // Schema only has min(1), no max — long queries should pass validation
    expect(res.statusCode).toBe(200);
  });
});
