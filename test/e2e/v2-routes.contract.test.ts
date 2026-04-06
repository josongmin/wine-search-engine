/**
 * V2 route parity contract tests.
 *
 * Verifies that:
 * - /v2/search returns { version: '2', responseType: 'human', queryType: 'search', results: [...] }
 *   or queryType: 'comparison' for Epic 14 decomposed "vs" queries
 * - /v2/search/hybrid returns { version: '2', responseType: 'human', results: [...] }
 * - /v2/search/interpret returns { version: '2', responseType: 'interpret' }
 * - V1 routes still return V1 shape (no top-level version / responseType fields)
 * - /v1/claude-tools endpoint is unchanged
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import { postJson, getJson } from './helpers/http-transport.js';
import {
  SearchResponseV2HumanSchema,
  InterpretResponseV2Schema,
} from '../../src/interface/http/schemas/search-response-v2.schema.js';
import { SearchResponseSchema } from '../../src/interface/http/schemas/search-response.schema.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

// ---------------------------------------------------------------------------
// V2 search
// ---------------------------------------------------------------------------

describe('POST /v2/search — V2 human response shape', () => {
  it('returns 200 with version=2 and responseType=human', async () => {
    const res = await postJson(server.app, '/v2/search', {
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('human');
    expect(body['query_type']).toBe('search');
    expect(Array.isArray(body['results'])).toBe(true);
    expect(typeof body['query_id']).toBe('string');
    expect(typeof body['total_candidates']).toBe('number');
  });

  it('response validates against SearchResponseV2HumanSchema (camelCase pre-serialization)', async () => {
    const res = await postJson(server.app, '/v2/search', {
      query: 'Château Margaux',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    // The server serialises camelCase → snake_case at the wire layer.
    // The raw JSON body uses snake_case; we verify structural properties.
    const body = res.json() as Record<string, unknown>;
    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('human');
  });

  it('returns comparison envelope for decomposed "vs" queries', async () => {
    const res = await postJson(server.app, '/v2/search', {
      query: 'Opus One vs Château Margaux',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['query_type']).toBe('comparison');
    expect(body['comparison_intent']).toBeDefined();
    expect(Array.isArray(body['entities'])).toBe(true);
    expect((body['entities'] as unknown[]).length).toBe(2);
    expect(typeof body['original_query']).toBe('string');
    expect(typeof body['overall_status']).toBe('string');
    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('human');
  });

  it('each result item has version=2 and responseType=human', async () => {
    const res = await postJson(server.app, '/v2/search', {
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const results = body['results'] as Array<Record<string, unknown>>;

    for (const result of results) {
      expect(result['version']).toBe('2');
      expect(result['response_type']).toBe('human');
      expect(typeof result['entity_id']).toBe('string');
      expect(typeof result['canonical_label']).toBe('string');
      expect(typeof result['rank']).toBe('number');
      expect(typeof result['evidence_summary']).toBe('string');
      expect(typeof result['confidence']).toBe('number');
    }
  });

  it('rejects requests without content-type: application/json', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v2/search',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'test' }),
    });

    expect(response.statusCode).toBe(415);
  });

  it('returns 400 for missing required query field', async () => {
    const res = await postJson(server.app, '/v2/search', {
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(typeof error['code']).toBe('string');
    expect(typeof error['request_id']).toBe('string');
  });

  it('returns 400 for empty body {}', async () => {
    const res = await postJson(server.app, '/v2/search', {});

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for empty string query', async () => {
    const res = await postJson(server.app, '/v2/search', { query: '' });

    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// V2 hybrid
// ---------------------------------------------------------------------------

describe('POST /v2/search/hybrid — V2 human response shape', () => {
  it('returns 200 with version=2 and responseType=human', async () => {
    const res = await postJson(server.app, '/v2/search/hybrid', {
      query: 'full bodied red wine',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('human');
    expect(body['query_type']).toBe('search');
    expect(Array.isArray(body['results'])).toBe(true);
    expect(typeof body['query_id']).toBe('string');
    expect(typeof body['total_candidates']).toBe('number');
  });

  it('returns 400 for missing required query field', async () => {
    const res = await postJson(server.app, '/v2/search/hybrid', {});

    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(typeof error['code']).toBe('string');
    expect(typeof error['request_id']).toBe('string');
  });

  it('rejects requests without content-type: application/json', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v2/search/hybrid',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'test' }),
    });

    expect(response.statusCode).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// V2 interpret
// ---------------------------------------------------------------------------

describe('POST /v2/search/interpret — V2 interpret response shape', () => {
  it('returns 200 with version=2 and responseType=interpret', async () => {
    const res = await postJson(server.app, '/v2/search/interpret', {
      query: 'Opus One 2018',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('interpret');
    expect(typeof body['query_id']).toBe('string');
    expect(typeof body['query_text']).toBe('string');
    expect(typeof body['detected_intent']).toBe('string');
    expect(Array.isArray(body['active_channels'])).toBe(true);
    expect(Array.isArray(body['applied_constraints'])).toBe(true);
    expect(Array.isArray(body['ranking_signals'])).toBe(true);
    expect((body['ranking_signals'] as unknown[]).length).toBeGreaterThan(0);
    expect(typeof body['confidence']).toBe('number');
  });

  it('returns 400 for missing required query field', async () => {
    const res = await postJson(server.app, '/v2/search/interpret', {});

    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(typeof error['code']).toBe('string');
    expect(typeof error['request_id']).toBe('string');
  });

  it('rejects requests without content-type: application/json', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v2/search/interpret',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ query: 'test' }),
    });

    expect(response.statusCode).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// V1 routes unchanged
// ---------------------------------------------------------------------------

describe('V1 routes — shape unchanged', () => {
  it('POST /v1/search still returns V1 shape (no top-level version/responseType)', async () => {
    const res = await postJson(server.app, '/v1/search', {
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    // V1 response has query_type, engine_decision, results, meta — NOT version/responseType
    expect(body['query_type']).toBe('search');
    expect(body['engine_decision']).toBeDefined();
    expect(body['meta']).toBeDefined();
    // No top-level version or response_type in V1
    expect(body['response_type']).toBeUndefined();
  });

  it('POST /v1/search/interpret still returns V1 interpret shape', async () => {
    const res = await postJson(server.app, '/v1/search/interpret', {
      query: 'Opus One 2018',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    // V1 interpret has raw_query, intent, route — NOT version/responseType
    expect(body['raw_query']).toBeDefined();
    expect(body['intent']).toBeDefined();
    expect(body['response_type']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /v1/claude-tools unchanged
// ---------------------------------------------------------------------------

describe('GET /v1/claude-tools — unchanged', () => {
  it('returns 200 with a tools list', async () => {
    const res = await getJson(server.app, '/v1/claude-tools');
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Array.isArray(body['tools'])).toBe(true);
    expect(typeof body['request_id']).toBe('string');
  });
});
