/**
 * E2E tests for mixed queries routed through the in-memory harness.
 *
 * The purpose of this suite is narrow: prove that mixed queries no longer
 * crash the server and that the seeded harness produces a non-empty result set.
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

function assertMixedResponse(body: unknown): void {
  const payload = body as Record<string, unknown>;
  const decision = payload['engine_decision'] as Record<string, unknown>;
  const results = payload['results'] as unknown[];
  const meta = payload['meta'] as Record<string, unknown>;

  expect(payload['query_type']).toBe('search');
  expect(Array.isArray(results)).toBe(true);
  expect(results.length).toBeGreaterThan(0);
  expect(meta['route']).toMatch(/^(mixed|hybrid)$/);
  expect(decision['decision_status']).not.toBe('failed');
}

describe('Mixed search E2E', () => {
  it('handles "오푸스원 같은 와인" without crashing and returns results', async () => {
    const res = await post('/v1/search', {
      query: '오푸스원 같은 와인',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    assertMixedResponse(res.json());
  });

  it('handles "클라우디베이 말고 다른 화이트" without crashing and returns results', async () => {
    const res = await post('/v1/search', {
      query: '클라우디베이 말고 다른 화이트',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    assertMixedResponse(res.json());
  });

  it('handles "마고 비슷한 레드" without crashing and returns results', async () => {
    const res = await post('/v1/search', {
      query: '마고 비슷한 레드',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    assertMixedResponse(res.json());
  });
});
