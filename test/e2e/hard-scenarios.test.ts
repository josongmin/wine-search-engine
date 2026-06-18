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
  parseEntityLookupResponse,
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

async function lookup(query: string) {
  const response = await post('/v2/entity-lookup', { query });
  expect(response.statusCode).toBe(200);
  return parseEntityLookupResponse(response);
}

// ─────────────────────────────────────────────────────────────────────────────
// Korean entity resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('Korean entity resolution', () => {
  it("'오푸스원' lookup → resolved or ambiguous (pre-registered alias, not failed)", async () => {
    const body = await lookup('오푸스원');
    // '오푸스원' is a pre-registered alias for opus-one-2018 — must resolve or be ambiguous
    expect(body.status).toMatch(/^(resolved|ambiguous)$/);
  });

  it("'샤토 마고' lookup → 200", async () => {
    const body = await lookup('샤토 마고');
    expect(body.meta.request_id).toBeTruthy();
  });

  it("'마고' lookup → ambiguity-safe 4-state outcome", async () => {
    const body = await lookup('마고');
    expect(['ambiguous', 'failed', 'redirect_discovery']).toContain(body.status);
  });

  it("'Chateau Margaux' (no accent) lookup → does not fail", async () => {
    const body = await lookup('Chateau Margaux');
    expect(body.status).not.toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Semantic / hybrid mode queries
// ─────────────────────────────────────────────────────────────────────────────

describe('Semantic / hybrid mode queries', () => {
  it("'풀바디 레드 와인' hybrid → results array is non-empty", async () => {
    const res = await post('/v1/search/hybrid', {
      query: '풀바디 레드 와인',
      options: { explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const results = body['results'] as unknown[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("'스파클링 와인' hybrid → results non-empty", async () => {
    const res = await post('/v1/search/hybrid', {
      query: '스파클링 와인',
      options: { explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const results = body['results'] as unknown[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("'달달한 와인' hybrid → results non-empty", async () => {
    const res = await post('/v1/search/hybrid', {
      query: '달달한 와인',
      options: { explain: false, clarification: false },
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
  it("'오푸스원 같은 와인' query → 200", async () => {
    const res = await post('/v1/search/hybrid', {
      query: '오푸스원 같은 와인',
      options: { explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it("'클라우디베이 말고 다른 화이트' query → 200", async () => {
    const res = await post('/v1/search/hybrid', {
      query: '클라우디베이 말고 다른 화이트',
      options: { explain: false, clarification: false },
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
      url: '/v1/search/hybrid',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ query: 'Opus One' }),
    });

    expect(response.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed input
// ─────────────────────────────────────────────────────────────────────────────

describe('Malformed input', () => {
  it('query=null body → 400', async () => {
    const res = await post('/v1/search/hybrid', { query: null });

    expect(res.statusCode).toBe(400);
  });

  it('array body [] → 400', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search/hybrid',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify([]),
    });

    expect(response.statusCode).toBe(400);
  });

  it('integer body 42 → 400', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search/hybrid',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(42),
    });

    expect(response.statusCode).toBe(400);
  });

  it('query with 500 chars → 200 (no max-length in schema)', async () => {
    const res = await post('/v1/search/hybrid', { query: 'a'.repeat(500) });

    // Schema only has min(1), no max — long queries should pass validation
    expect(res.statusCode).toBe(200);
  });
});
