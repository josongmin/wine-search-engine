/**
 * Ops endpoint coverage for the search API.
 *
 * Keeps /health and /ready ownership here, while request-id/content-type
 * cross-cutting concerns live with infrastructure contracts/invariants.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getJson,
  getHeader,
} from './helpers/http-transport.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

describe('GET /health', () => {
  it('returns 200 with status ok and timestamp field', async () => {
    const res = await getJson(server.app, '/health');

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['timestamp']).toBeTruthy();
    expect(typeof body['timestamp']).toBe('string');
  });

  it('returns JSON content-type and request id headers', async () => {
    const res = await getJson(server.app, '/health');

    expect(getHeader(res, 'content-type')).toContain('application/json');
    expect(getHeader(res, 'x-request-id')).toBeTruthy();
  });
});

describe('GET /ready', () => {
  it('returns 200 when healthy', async () => {
    const res = await getJson(server.app, '/ready');

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['ready']).toBe(true);
    expect(body['checks']).toEqual({
      postgres: { status: 'skipped', required: true },
      redis: { status: 'skipped', required: true },
    });
  });

  it('returns JSON content-type and request id headers', async () => {
    const res = await getJson(server.app, '/ready');

    expect(getHeader(res, 'content-type')).toContain('application/json');
    expect(getHeader(res, 'x-request-id')).toBeTruthy();
  });
});
