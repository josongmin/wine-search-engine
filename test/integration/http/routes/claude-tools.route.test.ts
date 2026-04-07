import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerClaudeToolsRoute } from '../../../../src/interface/http/routes/claude-tools.route.js';
import type { ClaudeToolsRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';

describe('Claude tools HTTP route', () => {
  let app: FastifyInstance | undefined;
  const executeWithFallback = vi.fn();

  beforeAll(async () => {
    app = Fastify();

    const deps: ClaudeToolsRouteDeps = {
      adaptiveToolExecutor: {
        executeWithFallback,
      },
    };

    registerClaudeToolsRoute(app, deps);
    await app.ready();
  });

  beforeEach(() => {
    executeWithFallback.mockReset();
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  it('GET /v1/claude-tools returns the tool manifest', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/claude-tools',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      tools: readonly unknown[];
      request_id: string;
    };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.request_id).toEqual(expect.any(String));
  });

  it('POST /v1/claude-tools delegates to the adaptive executor', async () => {
    executeWithFallback.mockResolvedValueOnce({
      result: { ok: true },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/claude-tools',
      payload: {
        tool_name: 'search_wines',
        tool_input: { query: 'Opus One 2018' },
        request_id: 'req-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(executeWithFallback).toHaveBeenCalledWith(
      'search_wines',
      { query: 'Opus One 2018' },
      'req-123',
    );

    const body = JSON.parse(response.body) as {
      tool_name: string;
      tool_result: { ok: boolean };
      request_id: string;
    };
    expect(body.tool_name).toBe('search_wines');
    expect(body.tool_result.ok).toBe(true);
    expect(body.request_id).toBe('req-123');
  });

  it('POST /v1/claude-tools preserves client request_id on execution failure', async () => {
    executeWithFallback.mockRejectedValueOnce(new Error('boom'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/claude-tools',
      payload: {
        tool_name: 'search_wines',
        tool_input: { query: 'Opus One 2018' },
        request_id: 'req-failed-123',
      },
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body) as {
      error: string;
      message: string;
      request_id: string;
    };
    expect(body.error).toBe('TOOL_EXECUTION_FAILED');
    expect(body.message).toBe('An unexpected error occurred while executing the tool.');
    expect(body.request_id).toBe('req-failed-123');
  });
});
