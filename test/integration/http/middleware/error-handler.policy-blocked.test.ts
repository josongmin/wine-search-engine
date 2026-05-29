import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UnexpectedDecomposedResponseError } from '../../../../src/application/search/decomposed-search.usecase.js';
import { BlockingMissError, DomainError } from '../../../../src/domain/shared/error/domain-error.js';
import {
  POLICY_BLOCKED_CODE,
  POLICY_BLOCKED_MESSAGE,
  PolicyBlockedError,
} from '../../../../src/domain/shared/error/policy-blocked.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';

class SnapshotMismatchError extends DomainError {
  constructor() {
    super('SNAPSHOT_MISMATCH', 'Decision snapshot mismatch.');
  }
}

class DeterminismViolationError extends DomainError {
  constructor() {
    super('DETERMINISM_VIOLATION', 'Determinism fingerprint mismatch.');
  }
}

class UnexpectedReplayResponseError extends DomainError {
  constructor() {
    super('UNEXPECTED_REPLAY_RESPONSE', 'Unexpected replay response shape.');
  }
}

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

    app.get('/validation-error-many', async () => {
      // 8 required fields, all missing → 8 issues (exceeds the message cap of 5).
      z.object({
        a: z.string(),
        b: z.string(),
        c: z.string(),
        d: z.string(),
        e: z.string(),
        f: z.string(),
        g: z.string(),
        h: z.string(),
      }).parse({});
    });

    app.get('/snapshot-mismatch', async () => {
      throw new SnapshotMismatchError();
    });

    app.get('/determinism-violation', async () => {
      throw new DeterminismViolationError();
    });

    app.get('/blocking-miss', async () => {
      throw new BlockingMissError('Candidate dropped before final decision.');
    });

    app.get('/unexpected-replay', async () => {
      throw new UnexpectedReplayResponseError();
    });

    app.get('/unexpected-decomposed', async () => {
      throw new UnexpectedDecomposedResponseError();
    });

    app.get('/unknown-error', async () => {
      throw new Error('boom');
    });

    app.get('/abort-error', async () => {
      const error = new Error('cooperative abort');
      error.name = 'AbortError';
      throw error;
    });

    app.get('/abort-dom-error', async () => {
      throw new DOMException('aborted', 'AbortError');
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

  it('truncates the VALIDATION_ERROR message to the first N issues with an overflow suffix (R6 H6)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/validation-error-many',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // 8 issues, cap 5 → 3 truncated, surfaced as a count not the raw issues.
    expect(body.error.message).toContain('... (3 more)');
    // The 6th+ issue paths (f/g/h) must NOT be echoed into the client message.
    expect(body.error.message).not.toContain('h:');
    expect(body.error.message).not.toContain('g:');
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

  it('maps DeterminismViolationError to a validated 409 error contract', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/determinism-violation',
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: 'DETERMINISM_VIOLATION',
        retryable: false,
      },
    });
  });

  it('maps BLOCKING_MISS to 503 (retryable) — transient pipeline constraint, not generic 500', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/blocking-miss',
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: 'BLOCKING_MISS',
        retryable: true,
      },
    });
  });

  it.each([
    ['/unexpected-replay', 'UNEXPECTED_REPLAY_RESPONSE'],
    ['/unexpected-decomposed', 'UNEXPECTED_DECOMPOSED_RESPONSE'],
  ])('maps %s to an exact validated 500 contract', async (url, code) => {
    const response = await app.inject({
      method: 'GET',
      url,
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      error: {
        code,
        retryable: false,
      },
    });
  });

  it('maps AbortError to 408 REQUEST_ABORTED (not generic 500)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/abort-error',
    });

    expect(response.statusCode).toBe(408);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: 'REQUEST_ABORTED',
        message: 'The request was cancelled.',
        retryable: false,
      },
    });
  });

  it('maps DOMException AbortError to 408 REQUEST_ABORTED (not generic 500)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/abort-dom-error',
    });

    expect(response.statusCode).toBe(408);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: 'REQUEST_ABORTED',
        message: 'The request was cancelled.',
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
