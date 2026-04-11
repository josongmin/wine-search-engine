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
          decision_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          authority_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
      decision_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      authority_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
      expect.any(Object),
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
      expect.any(Object),
    );
  });

  it('accepts resolver provenance fields on candidate responses', async () => {
    mockDeps.resolveUseCase.execute = vi.fn().mockResolvedValue({
      status: 'ambiguous',
      candidates: [
        {
          entityId: 'wine-opus-one-2018',
          canonicalLabel: 'Opus One 2018',
          rank: 1,
          calibratedScore: 0.77,
          evidenceRefs: ['opus one'],
          source: 'blocker_seed',
          sources: ['alias', 'blocker_seed'],
          blockerSeed: true,
        },
      ],
      topEntity: undefined,
      decision_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      authority_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      request_id: 'test-request',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/entity/resolve',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'Opus One 2018' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      candidates: [
        {
          source: 'blocker_seed',
          sources: ['alias', 'blocker_seed'],
          blocker_seed: true,
        },
      ],
    });
  });
});
