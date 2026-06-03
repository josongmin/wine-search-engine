import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestServer, createTestServer, type TestServer } from '../../../e2e/helpers/test-server.js';
import { getRegisteredHttpRouteContracts } from '../../../../src/interface/http/routes/register-contract-route.js';

describe('HTTP route contract registry', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('registers only the canonical public/product route contracts plus retained system routes', () => {
    const contracts = getRegisteredHttpRouteContracts(server.app);

    expect(contracts).toEqual(expect.arrayContaining([
      {
        method: 'GET',
        url: '/health',
        operationId: 'system.health',
        hasBody: false,
        hasParams: false,
        responseStatusCodes: [200, 503],
        successStatusCodes: [200],
        errorStatusCodes: [503],
      },
      {
        method: 'GET',
        url: '/ready',
        operationId: 'system.ready',
        hasBody: false,
        hasParams: false,
        responseStatusCodes: [200, 503],
        successStatusCodes: [200],
        errorStatusCodes: [503],
      },
      {
        method: 'POST',
        url: '/v1/search/hybrid',
        operationId: 'search.hybrid',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 403, 408, 429, 500, 503],
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 408, 429, 500, 503],
      },
      {
        method: 'POST',
        url: '/v1/search/semantic',
        operationId: 'search.semantic',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 403, 408, 429, 500, 503],
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 408, 429, 500, 503],
      },
      {
        method: 'POST',
        url: '/v1/search/lexical',
        operationId: 'search.lexical',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 403, 408, 429, 500, 503],
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 408, 429, 500, 503],
      },
    ]));

    // V2-only cutover: /v1/lookup/wine is removed; the sole public lookup
    // surface is /v2/entity-lookup.
    expect(contracts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/v1/lookup/wine' }),
      expect.objectContaining({ url: '/metrics/agent' }),
      expect.objectContaining({ url: '/metrics/retrieval-degradation' }),
      expect.objectContaining({ url: '/v1/claude-tools' }),
      expect.objectContaining({ url: '/v1/batch-search' }),
      expect.objectContaining({ url: '/v1/search/replay' }),
      expect.objectContaining({ url: '/v1/search/interpret' }),
      expect.objectContaining({ url: '/v1/entity/resolve' }),
      expect.objectContaining({ url: '/v1/entity/autocomplete' }),
      expect.objectContaining({ url: '/v1/search' }),
      expect.objectContaining({ url: '/v1/search/lookup' }),
    ]));
  });
});
