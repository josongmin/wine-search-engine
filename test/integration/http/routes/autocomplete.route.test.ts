import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAutocompleteRoute } from '../../../../src/interface/http/routes/autocomplete.route.js';
import type { AutocompleteRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';

describe('POST /v1/entity/autocomplete', () => {
  let app: FastifyInstance;
  let mockDeps: AutocompleteRouteDeps;

  beforeAll(async () => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);

    mockDeps = {
      autocompleteUseCase: {
        execute: vi.fn().mockResolvedValue({
          status: 'resolved',
          suggestions: [
            {
              entity: {
                entity_id: 'wine-opus-one-2018',
                canonical_label: 'Opus One 2018',
                entity_type: 'wine',
                producer: 'Opus One',
                region: 'Napa Valley',
              },
              rank: 1,
              calibrated_score: 0.99,
              source: 'alias',
            },
          ],
          decision_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          authority_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          request_id: 'test-request',
        }),
      },
    };

    registerAutocompleteRoute(app, mockDeps);
  });

  beforeEach(() => {
    mockDeps.autocompleteUseCase.execute = vi.fn().mockResolvedValue({
      status: 'resolved',
      suggestions: [
        {
          entity: {
            entity_id: 'wine-opus-one-2018',
            canonical_label: 'Opus One 2018',
            entity_type: 'wine',
          },
          rank: 1,
          calibrated_score: 0.99,
          source: 'alias',
        },
      ],
      decision_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      authority_trace_ref: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      request_id: 'test-request',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('passes requestId through to the autocomplete use case', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/entity/autocomplete',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'opu',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      request_id: expect.any(String),
    }));
    expect(mockDeps.autocompleteUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'opu',
        requestId: expect.any(String),
      }),
      expect.any(Object),
    );
  });

  it('accepts snake_case request aliases on autocomplete', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/entity/autocomplete',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'Opus One',
        session_context: {
          session_id: 'sess-autocomplete',
          previous_entities: ['wine:opus-one-2018'],
        },
        query_budget: {
          max_latency_ms: 1000,
          max_candidates: 12,
          rerank_limit: 6,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockDeps.autocompleteUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Opus One',
        sessionContext: {
          sessionId: 'sess-autocomplete',
          previousEntities: ['wine:opus-one-2018'],
        },
        queryBudget: {
          maxLatencyMs: 1000,
          maxCandidates: 12,
          rerankLimit: 6,
        },
      }),
      expect.any(Object),
    );
  });
});
