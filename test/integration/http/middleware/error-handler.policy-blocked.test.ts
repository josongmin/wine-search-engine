import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SnapshotMismatchError } from '../../../../src/application/search/replay.usecase.js';
import {
  POLICY_BLOCKED_CODE,
  POLICY_BLOCKED_MESSAGE,
  PolicyBlockedError,
} from '../../../../src/domain/shared/error/policy-blocked.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';

describe('errorHandler policy-blocked contract', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);

    app.get('/policy-blocked', async () => {
      throw new PolicyBlockedError();
    });

    app.get('/validation-error', async () => {
      z.object({ query: z.string().min(1) }).parse({});
    });

    app.get('/snapshot-mismatch', async () => {
      throw new SnapshotMismatchError(
        {
          model_versions: {},
          index_versions: {},
          policy_rule_version: 'expected',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
        {
          model_versions: {},
          index_versions: {},
          policy_rule_version: 'actual',
          threshold_profile_id: 'default',
          planner_version: '1.0.0',
          feature_flags: {},
        },
      );
    });

    app.get('/unknown-error', async () => {
      throw new Error('boom');
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
    expect(ErrorResponseSchema.safeParse(response.json()).success).toBe(true);
  });

  it('maps ZodError to the validated RFC-014 error contract', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/validation-error',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        retryable: false,
      },
    });
  });

  it('maps SnapshotMismatchError to a validated 409 error contract', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/snapshot-mismatch',
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: 'SNAPSHOT_MISMATCH',
        retryable: false,
      },
    });
  });

  it('maps unknown errors to a validated 500 error contract', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/unknown-error',
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
        retryable: false,
      },
    });
  });
});
