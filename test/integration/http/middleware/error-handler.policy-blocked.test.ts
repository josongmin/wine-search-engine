import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  POLICY_BLOCKED_CODE,
  POLICY_BLOCKED_MESSAGE,
  PolicyBlockedError,
} from '../../../../src/domain/shared/error/policy-blocked.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';

describe('errorHandler policy-blocked contract', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);

    app.get('/policy-blocked', async () => {
      throw new PolicyBlockedError();
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('maps POLICY_BLOCKED DomainError to a 403 machine-readable response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/policy-blocked',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        request_id: expect.any(String),
        code: POLICY_BLOCKED_CODE,
        message: POLICY_BLOCKED_MESSAGE,
        failure_reason: POLICY_BLOCKED_CODE,
        retryable: false,
      },
    });
  });
});
