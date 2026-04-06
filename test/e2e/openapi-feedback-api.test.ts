/**
 * E2E smoke for GET /openapi.json and POST /v1/feedback (declared surface not covered elsewhere).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import { getJson, postJson } from './helpers/http-transport.js';

let testServer: TestServer;

beforeAll(async () => {
  testServer = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(testServer);
});

const OpenApiDocumentSchema = z.object({
  openapi: z.string(),
  info: z.object({
    title: z.string(),
    version: z.string(),
  }),
  paths: z.record(z.unknown()),
});

describe('GET /openapi.json', () => {
  it('returns 200 JSON with OpenAPI shape and contract-derived paths', async () => {
    const res = await getJson(testServer.app, '/openapi.json');
    expect(res.statusCode).toBe(200);
    const doc = OpenApiDocumentSchema.parse(res.json());
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.paths['/health']?.get).toBeDefined();
    expect(doc.paths['/v1/search']?.post).toBeDefined();
    expect(doc.paths['/v1/feedback']?.post).toBeDefined();
  });

  it('sets JSON content-type and cache headers', async () => {
    const raw = await testServer.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(raw.statusCode).toBe(200);
    expect(String(raw.headers['content-type'])).toContain('application/json');
    expect(String(raw.headers['cache-control'])).toContain('max-age');
  });
});

describe('POST /v1/feedback', () => {
  it('returns 503 FEEDBACK_UNAVAILABLE when ingest is disabled (in-memory test server)', async () => {
    const res = await postJson(testServer.app, '/v1/feedback', {
      query: 'Opus One',
      entity_id: 'wine-opus-one',
      signal_type: 'click',
      session_id: 'sess-e2e-1',
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error?: { code?: string; retryable?: boolean } };
    expect(body.error?.code).toBe('FEEDBACK_UNAVAILABLE');
    expect(body.error?.retryable).toBe(true);
  });

  it('returns 415 when Content-Type is not application/json (global POST policy)', async () => {
    const raw = await testServer.app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(raw.statusCode).toBe(415);
    const body = JSON.parse(raw.body) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});
