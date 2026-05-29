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
    // T-IR-01/02: path-authoritative primitive surface is now declared in the
    // catalog alongside the legacy mode-monolith routes. These must be present
    // as `post` operations (additive — legacy `/v1/search`, `/v1/search/lookup`,
    // `/v1/agent` stay until T-IR-07 removes them).
    expect(document.paths['/v1/search/hybrid']?.post).toEqual(expect.objectContaining({
      operationId: 'search.hybrid',
      tags: ['search'],
    }));
    expect(document.paths['/v1/search/semantic']?.post).toEqual(expect.objectContaining({
      operationId: 'search.semantic',
      tags: ['search'],
    }));
    expect(document.paths['/v1/search/lexical']?.post).toEqual(expect.objectContaining({
      operationId: 'search.lexical',
      tags: ['search'],
    }));
    expect(document.paths['/v1/lookup/wine']?.post).toEqual(expect.objectContaining({
      operationId: 'lookup.wine',
      tags: ['lookup'],
    }));
    expect(document.paths['/v1/agent/run']?.post).toEqual(expect.objectContaining({
      operationId: expect.any(String),
      tags: ['agent'],
    }));
    expect(document.paths['/v1/search/interpret']).toBeUndefined();
    expect(document.paths['/v1/entity/resolve']).toBeUndefined();
    expect(document.paths['/v1/entity/autocomplete']).toBeUndefined();
    expect(document.paths['/v1/search/replay']).toBeUndefined();
    expect(document.paths['/v1/claude-tools']).toBeUndefined();
    expect(document.paths['/v1/batch-search']).toBeUndefined();
    expect(document.paths['/v1/agent/benchmark-scenarios']).toBeUndefined();
  });
});
