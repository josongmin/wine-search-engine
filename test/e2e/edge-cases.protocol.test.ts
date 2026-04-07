/**
 * E2E protocol and endpoint edge cases for the Wine Search Engine.
 *
 * Covers routing/method handling, response-body JSON integrity,
 * Accept-header behavior, and interpret/resolve endpoint edge cases.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  parseInterpretResponse,
  postJson,
} from './helpers/http-transport.js';
import { makeReplaySnapshot } from './helpers/replay-snapshot.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

async function post(path: string, body: unknown) {
  return postJson(server.app, path, body);
}

function expectValidJsonBody(response: { body: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error('Response is not valid JSON');
  }
  expect(parsed).toBeDefined();
  return parsed;
}

describe('HTTP method and routing', () => {
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
});

describe('Response body integrity', () => {
  const MATCHING_SNAPSHOT = makeReplaySnapshot();

  it.each([
    ['search', () => post('/v1/search', { query: 'Opus One 2018' })],
    ['hybrid', () => post('/v1/search/hybrid', { query: '풀바디 레드 와인' })],
    ['interpret', () => post('/v1/search/interpret', { query: 'Opus One' })],
    ['resolve', () => post('/v1/entity/resolve', { query: 'Opus One 2018' })],
    [
      'replay',
      () => post('/v1/search/replay', {
        query: 'Opus One 2018',
        decision_snapshot: MATCHING_SNAPSHOT,
      }),
    ],
  ])('POST /v1/%s response body is always valid JSON', async (_label, runRequest) => {
    const res = await runRequest();
    expectValidJsonBody(res);
  });

  it('error response body is always valid JSON for bad requests', async () => {
    const res = await post('/v1/search', {});
    expect(res.statusCode).toBe(400);

    const body = expectValidJsonBody(res) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(typeof error['code']).toBe('string');
    expect(typeof error['message']).toBe('string');
  });
});

describe('Header and protocol edge cases', () => {
  it('Accept: application/json is accepted', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
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
        accept: '*/*',
      },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('Interpret endpoint edge cases', () => {
  it('/v1/search/interpret with Korean mixed query — rawQuery preserved exactly', async () => {
    const query = '오푸스원 같은 가성비 와인';
    const res = await post('/v1/search/interpret', { query });

    expect(res.statusCode).toBe(200);
    const plan = parseInterpretResponse(res);
    expect(plan.raw_query).toBe(query);
    expect(plan.normalized_query).toBeTruthy();
    expect(['entity', 'hybrid', 'mixed']).toContain(plan.route);
  });

  it('plannerVersion is semver-like string (starts with X.Y)', async () => {
    const res = await post('/v1/search/interpret', { query: 'Opus One' });

    expect(res.statusCode).toBe(200);
    const plan = parseInterpretResponse(res);
    expect(typeof plan.planner_version).toBe('string');
    expect(plan.planner_version).toMatch(/^\d+\.\d+/);
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

describe('Resolve endpoint edge cases', () => {
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
    expect(['ambiguous', 'failed']).toContain(body['status']);
  });
});
