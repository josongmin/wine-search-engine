/**
 * E2E tests for server protocol behavior.
 *
 * Covers OPTIONS preflight, CORS behavior in test/development modes,
 * and basic health/readiness smoke through the real Fastify server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/interface/http/server.js';
import { createTestContainer } from '../integration/helpers/test-container.js';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import type { HealthRouteOptions } from '../../src/interface/http/routes/health.route.js';
import {
  getHeader,
  getJson,
  optionsRequest,
} from './helpers/http-transport.js';

let testServer: TestServer;

beforeAll(async () => {
  testServer = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(testServer);
});

async function createProtocolServer(options?: {
  readonly nodeEnv?: 'development' | 'production' | 'test';
  readonly health?: HealthRouteOptions;
}) {
  const parts = createTestContainer();
  const app = await createServer(parts.container, {
    logLevel: 'silent',
    nodeEnv: options?.nodeEnv ?? 'test',
    health: options?.health,
  });
  await app.ready();
  return app;
}

describe('OPTIONS preflight', () => {
  it('responds with 204 and CORS headers for preflight requests', async () => {
    const res = await optionsRequest(testServer.app, '/v1/search', {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    });

    expect(res.statusCode).toBe(204);
    expect(getHeader(res, 'access-control-allow-origin')).toBe('http://localhost:3000');
    expect(getHeader(res, 'access-control-allow-methods')).toContain('GET');
    expect(getHeader(res, 'access-control-allow-methods')).toContain('POST');
    expect(getHeader(res, 'access-control-allow-methods')).toContain('OPTIONS');
    expect(getHeader(res, 'access-control-allow-headers')).toContain('Content-Type');
    expect(getHeader(res, 'access-control-allow-headers')).toContain('Authorization');
    expect(getHeader(res, 'access-control-max-age')).toBe('86400');
  });
});

describe.each([
  { nodeEnv: 'test' as const, origin: 'http://localhost:3000' },
  { nodeEnv: 'development' as const, origin: 'http://example.com' },
])('CORS in %s mode', ({ nodeEnv, origin }) => {
  it(`echoes the request origin in ${nodeEnv} mode`, async () => {
    const app = await createProtocolServer({ nodeEnv });
    try {
      const res = await getJson(app, '/health', { origin });
      expect(res.statusCode).toBe(200);
      expect(getHeader(res, 'access-control-allow-origin')).toBe(origin);
      expect(getHeader(res, 'access-control-allow-methods')).toContain('GET');
      expect(getHeader(res, 'access-control-allow-headers')).toContain('Content-Type');
    } finally {
      await app.close();
    }
  });
});

describe('Health and readiness', () => {
  it('returns healthy health and ready responses through the real server', async () => {
    const resHealth = await getJson(testServer.app, '/health', {
      origin: 'http://localhost:3000',
    });
    expect(resHealth.statusCode).toBe(200);
    expect(resHealth.json()).toMatchObject({
      status: 'ok',
    });
    expect(getHeader(resHealth, 'x-request-id')).toBeTruthy();
    expect(getHeader(resHealth, 'access-control-allow-origin')).toBe('http://localhost:3000');

    const resReady = await getJson(testServer.app, '/ready', {
      origin: 'http://localhost:3000',
    });
    expect(resReady.statusCode).toBe(200);
    expect(resReady.json()).toMatchObject({
      ready: true,
      checks: {
        postgres: { status: 'skipped', required: false },
        redis: { status: 'skipped', required: false },
      },
    });
    expect(getHeader(resReady, 'x-request-id')).toBeTruthy();
  });

  it('returns 503 when a required readiness check is down', async () => {
    const app = await createProtocolServer({
      health: {
        readiness: {
          vespa: {
            required: true,
            check: async () => 'down',
          },
        },
      },
    });

    try {
      const res = await getJson(app, '/ready');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        ready: false,
        checks: {
          postgres: { status: 'skipped', required: false },
          redis: { status: 'skipped', required: false },
          vespa: { status: 'down', required: true },
        },
      });
      expect(getHeader(res, 'x-request-id')).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
