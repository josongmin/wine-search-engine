/**
 * E2E tests for POST/GET /v1/claude-tools.
 *
 * Covers the full server path, request-id correlation, and response shape
 * for both the manifest and tool execution endpoints.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getHeader,
  getSearchRequestId,
  postJson,
} from './helpers/http-transport.js';
import { SearchResponseSchema } from '../../src/interface/http/schemas/search-response.schema.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

describe('GET /v1/claude-tools', () => {
  it('returns the tools manifest with request-id correlation', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/v1/claude-tools',
    });

    expect(res.statusCode).toBe(200);

    const headerRequestId = getHeader(
      {
        statusCode: res.statusCode,
        headers: res.headers as Record<string, string | string[]>,
        body: res.body,
        json: () => JSON.parse(res.body) as unknown,
      },
      'x-request-id',
    );
    expect(headerRequestId).toBeTruthy();

    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools).toHaveLength(4);
    expect(body.request_id).toBe(headerRequestId);

    const toolNames = (body.tools as Array<Record<string, unknown>>).map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'search_wines',
        'get_food_pairings',
        'check_drinking_window',
        'compare_wines',
      ]),
    );
  });
});

describe('POST /v1/claude-tools', () => {
  it('executes search_wines and returns a schema-valid search result', async () => {
    const res = await postJson(server.app, '/v1/claude-tools', {
      tool_name: 'search_wines',
      tool_input: {
        query: 'Opus One 2018',
        retrieval_mode: 'entity',
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    const headerRequestId = getHeader(res, 'x-request-id');
    expect(headerRequestId).toBeTruthy();
    expect(body.request_id).toBe(headerRequestId);
    expect(body.tool_name).toBe('search_wines');

    const toolResult = body.tool_result;
    const parsed = SearchResponseSchema.safeParse(toolResult);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    expect(parsed.data.query_type).toBe('search');
    expect(Array.isArray(parsed.data.results)).toBe(true);
    expect(parsed.data.engine_decision.decision_status).toMatch(/^(resolved|ambiguous|failed)$/);
    expect(getSearchRequestId(parsed.data)).toBeTruthy();
  });

  it('rejects invalid payloads with a 400 error envelope', async () => {
    const res = await postJson(server.app, '/v1/claude-tools', {
      tool_input: {
        query: 'Opus One 2018',
      },
    });

    expect(res.statusCode).toBe(400);

    const headerRequestId = getHeader(res, 'x-request-id');
    expect(headerRequestId).toBeTruthy();

    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe('TOOL_EXECUTION_FAILED');
    expect(typeof body.message).toBe('string');
    expect((body.message as string).length).toBeGreaterThan(0);
    expect(body.request_id).toBe(headerRequestId);
  });
});
