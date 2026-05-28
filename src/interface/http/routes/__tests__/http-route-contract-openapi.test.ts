import { describe, expect, it } from 'vitest';
import { buildHttpRouteContractOpenApiBridge } from '../http-route-contract-openapi.js';

describe('HTTP contract OpenAPI bridge', () => {
  it('projects declared route contracts into an OpenAPI bridge document', () => {
    const document = buildHttpRouteContractOpenApiBridge();

    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/v1/search']?.post).toEqual(expect.objectContaining({
      operationId: 'search.execute',
      tags: ['search'],
      'x-search-capabilities': [
        'security',
        'decomposition',
        'planner',
        'SAT',
        'cache',
        'route_resolution',
        'ranked_post_route',
      ],
      'x-contract-has-body': true,
      'x-contract-has-params': false,
      'x-contract-success-status-codes': [200],
      'x-contract-error-status-codes': [400, 403, 408, 429, 500, 503],
    }));
    expect(document.paths['/v1/search']?.post?.requestBody?.content['application/json'].schema).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          query: expect.objectContaining({
            type: 'string',
          }),
          options: expect.objectContaining({
            type: 'object',
          }),
        }),
      }),
    );
    expect(document.paths['/v1/watchlist/{id}']?.get).toEqual(expect.objectContaining({
      operationId: 'watchlist.get',
      'x-contract-has-body': false,
      'x-contract-has-params': true,
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'x-authenticated-subject',
          in: 'header',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        },
      ],
    }));
    expect(document.paths['/v1/search/hybrid']?.post).toEqual(expect.objectContaining({
      operationId: 'search.hybrid',
      'x-search-capabilities': [
        'security',
        'decomposition',
        'planner',
        'SAT',
        'cache',
        'forced_hybrid_retrieval',
        'ranked_post_route',
      ],
    }));
    expect(document.paths['/v1/search/interpret']?.post).toEqual(expect.objectContaining({
      operationId: 'search.interpret',
      'x-search-capabilities': ['security', 'planner_only'],
    }));
    expect(document.paths['/v1/entity/resolve']?.post).toEqual(expect.objectContaining({
      operationId: 'entity.resolve',
      'x-search-capabilities': ['security', 'planner', 'SAT', 'resolver_only'],
    }));
    expect(document.paths['/v1/entity/autocomplete']?.post).toEqual(expect.objectContaining({
      operationId: 'entity.autocomplete',
      'x-search-capabilities': ['security', 'planner', 'SAT', 'resolver_only'],
    }));
    expect(
      document.paths['/v1/search/replay']?.post?.requestBody?.content['application/json'].schema,
    ).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          query: expect.objectContaining({ type: 'string' }),
          decision_snapshot: expect.objectContaining({ type: 'object' }),
          preflight_honesty_contract: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              execution_mode: expect.objectContaining({
                enum: ['authoritative', 'degraded', 'heuristic', 'advisory'],
              }),
              degradation_reasons: expect.objectContaining({ type: 'array' }),
            }),
          }),
        }),
      }),
    );
  });
});
