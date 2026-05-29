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
        method: 'GET',
        url: '/metrics/agent',
        operationId: 'system.agentMetrics',
        hasBody: false,
        hasParams: false,
        responseStatusCodes: [200, 403],
        successStatusCodes: [200],
        errorStatusCodes: [403],
      },
      {
        method: 'GET',
        url: '/metrics/retrieval-degradation',
        operationId: 'system.retrievalDegradationMetrics',
        hasBody: false,
        hasParams: false,
        responseStatusCodes: [200, 403],
        successStatusCodes: [200],
        errorStatusCodes: [403],
      },
      {
        method: 'POST',
        url: '/v1/search',
        operationId: 'search.execute',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 403, 408, 429, 500, 503],
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 408, 429, 500, 503],
      },
      {
        method: 'POST',
        url: '/v1/search/lookup',
        operationId: 'search.lookup',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 403, 408, 429, 500, 503],
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 408, 429, 500, 503],
      },
      {
        method: 'GET',
        url: '/v1/watchlist',
        operationId: 'watchlist.list',
        hasBody: false,
        hasParams: false,
        responseStatusCodes: [200, 401, 429, 500],
        successStatusCodes: [200],
        errorStatusCodes: [401, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/watchlist',
        operationId: 'watchlist.create',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [201, 400, 401, 429, 500],
        successStatusCodes: [201],
        errorStatusCodes: [400, 401, 429, 500],
      },
      {
        method: 'GET',
        url: '/v1/watchlist/:id',
        operationId: 'watchlist.get',
        hasBody: false,
        hasParams: true,
        responseStatusCodes: [200, 400, 401, 404, 429, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 401, 404, 429, 500],
      },
      {
        method: 'DELETE',
        url: '/v1/watchlist/:id',
        operationId: 'watchlist.delete',
        hasBody: false,
        hasParams: true,
        responseStatusCodes: [204, 400, 401, 404, 429, 500],
        successStatusCodes: [204],
        errorStatusCodes: [400, 401, 404, 429, 500],
      },
      {
        method: 'GET',
        url: '/v1/watchlist/:id/deliveries',
        operationId: 'watchlist.listDeliveries',
        hasBody: false,
        hasParams: true,
        responseStatusCodes: [200, 400, 401, 404, 429, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 401, 404, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/feedback',
        operationId: 'learning.submitFeedback',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [201, 400, 429, 500, 503],
        successStatusCodes: [201],
        errorStatusCodes: [400, 429, 500, 503],
      },
    ]));

    expect(contracts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/v1/claude-tools' }),
      expect.objectContaining({ url: '/v1/batch-search' }),
      expect.objectContaining({ url: '/v1/search/replay' }),
      expect.objectContaining({ url: '/v1/search/interpret' }),
      expect.objectContaining({ url: '/v1/entity/resolve' }),
      expect.objectContaining({ url: '/v1/entity/autocomplete' }),
      expect.objectContaining({ url: '/v1/search/hybrid' }),
    ]));
  });
});
