/**
 * E2E hard/edge-case scenarios for the Wine Search Engine.
 *
 * Covers Korean entity resolution, semantic/hybrid modes, mixed-intent queries,
 * parser/content-type edge behavior, and fine-grained snapshot-mismatch scenarios per RFC-015.
 *
 * Does NOT duplicate tests already owned by search-api.search/search-api.secondary,
 * search-api.ops, or infrastructure invariants/contracts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  parseInterpretResponse,
  parseSearchResponse,
  postJson,
  getSearchDecisionStatus,
} from './helpers/http-transport.js';
import { fetchReplaySnapshot, makeReplaySnapshot } from './helpers/replay-snapshot.js';

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
  it('POST with content-type: application/json; charset=utf-8 → 200', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });

    expect(response.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot field mismatch (RFC-015)
// ─────────────────────────────────────────────────────────────────────────────

describe('Snapshot field mismatch (RFC-015)', () => {
  const MATCHING_SNAPSHOT = makeReplaySnapshot();

  it.each([
    ['policy_rule_version mismatch', { ...MATCHING_SNAPSHOT, policy_rule_version: '9.9.9' }],
    ['threshold_profile_id mismatch', { ...MATCHING_SNAPSHOT, threshold_profile_id: 'custom-profile' }],
    ['planner_version mismatch', { ...MATCHING_SNAPSHOT, planner_version: '2.0.0' }],
    ['model_versions mismatch', { ...MATCHING_SNAPSHOT, model_versions: { embedding: 'text-embedding-3-small-v2' } }],
    ['feature_flags mismatch (extra flag)', { ...MATCHING_SNAPSHOT, feature_flags: { experimental: true } }],
  ])('%s → 409 SNAPSHOT_MISMATCH', async (_label, decision_snapshot) => {
    const res = await post('/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot,
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SNAPSHOT_MISMATCH');
  });

  it('exact matching snapshot → 200 (control case)', async () => {
    const matchingSnapshot = await fetchReplaySnapshot(server.app, {
      query: 'Opus One 2018',
    });
    const res = await post('/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: matchingSnapshot,
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
