import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerResolveRoute } from '../../../../src/interface/http/routes/resolve.route.js';
import type { ResolveRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';

describe('POST /v1/entity/resolve', () => {
  let app: FastifyInstance;
  let mockDeps: ResolveRouteDeps;

  beforeAll(async () => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);

    mockDeps = {
      resolveUseCase: {
        execute: vi.fn().mockResolvedValue({
          status: 'resolved',
          candidates: [],
          topEntity: {
            entityId: 'wine-opus-one-2018',
            canonicalLabel: 'Opus One 2018',
            calibratedScore: 0.99,
          },
          decision_trace_ref: 'resolve:test-request:entity_lookup',
          request_id: 'test-request',
        }),
      },
    };

    registerResolveRoute(app, mockDeps);
  });

  beforeEach(() => {
    mockDeps.resolveUseCase.execute = vi.fn().mockResolvedValue({
      status: 'resolved',
      candidates: [],
      topEntity: {
        entityId: 'wine-opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        calibratedScore: 0.99,
      },
      decision_trace_ref: 'resolve:test-request:entity_lookup',
      request_id: 'test-request',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('passes requestId through to the resolve use case', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/entity/resolve',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One 2018',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      request_id: expect.any(String),
    }));
    expect(mockDeps.resolveUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Opus One 2018',
        requestId: expect.any(String),
      }),
    );
  });

  it('passes queryBudget through to the resolve use case', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/entity/resolve',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One 2018',
        queryBudget: {
          maxLatencyMs: 750,
          maxCandidates: 16,
          rerankLimit: 8,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockDeps.resolveUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Opus One 2018',
        queryBudget: {
          maxLatencyMs: 750,
          maxCandidates: 16,
          rerankLimit: 8,
        },
      }),
    );
  });
});
