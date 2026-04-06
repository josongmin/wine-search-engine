import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH } from '../../../../domain/shared/constants.js';
import { buildHttpRouteContractOpenApiBridge } from '../http-route-contract-openapi.js';

describe('HTTP contract OpenAPI bridge', () => {
  it('projects declared route contracts into an OpenAPI bridge document', () => {
    const document = buildHttpRouteContractOpenApiBridge();

    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/v1/search']?.post).toEqual(expect.objectContaining({
      operationId: 'search.execute',
      tags: ['search'],
      'x-contract-has-body': true,
      'x-contract-has-params': false,
      'x-contract-success-status-codes': [200],
      'x-contract-error-status-codes': [400, 403, 429, 500],
    }));
    expect(document.paths['/v1/search']?.post?.requestBody?.content['application/json'].schema).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          query: expect.objectContaining({
            type: 'string',
            maxLength: MAX_QUERY_LENGTH,
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
      ],
    }));
  });
});
