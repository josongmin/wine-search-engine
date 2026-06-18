/**
 * E2E protocol and endpoint edge cases for the Wine Search Engine.
 *
 * Covers routing/method handling, response-body JSON integrity,
 * Accept-header behavior, and canonical search/lookup edge cases.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  postJson,
} from './helpers/http-transport.js';

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
  it('GET /v1/search/hybrid returns 404 (only POST supported)', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/search/hybrid',
    });
    expect(response.statusCode).toBe(404);
  });

  it('PUT /v1/search/hybrid returns 404', async () => {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/v1/search/hybrid',
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
  it.each([
    ['/v1/search/hybrid', () => post('/v1/search/hybrid', { query: 'Opus One 2018' })],
    ['/v2/entity-lookup', () => post('/v2/entity-lookup', { query: 'Opus One 2018' })],
  ])('POST %s response body is always valid JSON', async (_label, runRequest) => {
    const res = await runRequest();
    expectValidJsonBody(res);
  });

  it('error response body is always valid JSON for bad requests', async () => {
    const res = await post('/v1/search/hybrid', {});
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
      url: '/v1/search/hybrid',
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
      url: '/v1/search/hybrid',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
      },
      payload: JSON.stringify({ query: 'Opus One 2018' }),
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('Lookup endpoint edge cases (V2)', () => {
  it('/v2/entity-lookup returns a valid V2 4-state envelope for a known entity', async () => {
    const res = await post('/v2/entity-lookup', { query: 'Opus One 2018' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // V2-native 4-state contract.
    expect(['resolved', 'ambiguous', 'failed', 'redirect_discovery']).toContain(body['status']);
    expect(Array.isArray(body['candidates'])).toBe(true);
    expect(typeof body['meta']).toBe('object');
  });

  it('/v2/entity-lookup admits a comparison-style query and returns a valid JSON 4-state body (no 400)', async () => {
    // V2-only cutover: unlike the removed /v1/lookup/wine (which 400'd comparison
    // queries), the EntityLookupV2 concept gate admits the query and returns a
    // 4-state result (typically failed/redirect_discovery for a vs-query) rather
    // than an error envelope.
    const res = await post('/v2/entity-lookup', { query: 'Opus One vs Sassicaia' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(['resolved', 'ambiguous', 'failed', 'redirect_discovery']).toContain(body['status']);
  });
});
