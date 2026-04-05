import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../../../src/config/container.js';
import { registerClaudeToolsRoute } from '../../../../src/interface/http/routes/claude-tools.route.js';

describe('Claude tools HTTP route', () => {
  let app: FastifyInstance | undefined;
  const executeWithFallback = vi.fn();

  beforeEach(async () => {
    app = Fastify();
    executeWithFallback.mockReset();

    const container = {
      adaptiveToolExecutor: {
        executeWithFallback,
      },
    } as unknown as Container;

    registerClaudeToolsRoute(app, container);
    await app.ready();
  });

  afterEach(async () => {
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
});
