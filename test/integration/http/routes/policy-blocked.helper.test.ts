import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import {
  buildPolicyBlockedErrorResponse,
  sendPolicyBlockedResponse,
} from '../../../../src/interface/http/errors/policy-blocked.js';

describe('policy-blocked HTTP helper', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
    registerRequestContext(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('builds the canonical machine-readable error body', () => {
    expect(buildPolicyBlockedErrorResponse('req-123')).toEqual({
      error: {
        request_id: 'req-123',
        code: 'POLICY_BLOCKED',
        message: 'Query blocked by security policy.',
        failure_reason: 'POLICY_BLOCKED',
        retryable: false,
      },
    });
  });

  it('sends the canonical 403 contract response', async () => {
    app.post('/test', async (request, reply) => {
      sendPolicyBlockedResponse(request, reply);
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: 'POLICY_BLOCKED',
        failure_reason: 'POLICY_BLOCKED',
      },
    });
  });

  it('uses an explicit requestId override when provided', async () => {
    app.post('/test-override', async (request, reply) => {
      sendPolicyBlockedResponse(request, reply, 'req-explicit');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-override',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(buildPolicyBlockedErrorResponse('req-explicit'));
  });

  it('uses the request context id by default', async () => {
    app.post('/test-default', async (request, reply) => {
      sendPolicyBlockedResponse(request, reply);
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-default',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    const body = response.json();
    expect(body.error.request_id).toBeTruthy();
  });
});
