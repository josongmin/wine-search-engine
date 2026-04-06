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

  it('registers contract-backed routes with stable operation ids and status maps', () => {
    const contracts = getRegisteredHttpRouteContracts(server.app);

    expect(contracts).toEqual(expect.arrayContaining([
      {
        method: 'GET',
        url: '/health',
        operationId: 'system.health',
        hasBody: false,
        hasParams: false,
        responseStatusCodes: [200],
        successStatusCodes: [200],
        errorStatusCodes: [],
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
        url: '/v1/claude-tools',
        operationId: 'tools.list',
        hasBody: false,
        hasParams: false,
        responseStatusCodes: [200],
        successStatusCodes: [200],
        errorStatusCodes: [],
      },
      {
        method: 'POST',
        url: '/v1/claude-tools',
        operationId: 'tools.execute',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 500],
      },
      {
        method: 'POST',
        url: '/v1/search',
        operationId: 'search.execute',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 403, 429, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/batch-search',
        operationId: 'search.batch',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 429, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/search/replay',
        operationId: 'search.replay',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 409, 429, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 409, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/search/interpret',
        operationId: 'search.interpret',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 403, 429, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/entity/resolve',
        operationId: 'entity.resolve',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 403, 429, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/search/hybrid',
        operationId: 'search.hybrid',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [200, 400, 403, 429, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/watchlist',
        operationId: 'watchlist.create',
        hasBody: true,
        hasParams: false,
        responseStatusCodes: [201, 400, 500],
        successStatusCodes: [201],
        errorStatusCodes: [400, 500],
      },
      {
        method: 'GET',
        url: '/v1/watchlist/:id',
        operationId: 'watchlist.get',
        hasBody: false,
        hasParams: true,
        responseStatusCodes: [200, 400, 404, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 404, 500],
      },
      {
        method: 'DELETE',
        url: '/v1/watchlist/:id',
        operationId: 'watchlist.delete',
        hasBody: false,
        hasParams: true,
        responseStatusCodes: [204, 400, 404, 500],
        successStatusCodes: [204],
        errorStatusCodes: [400, 404, 500],
      },
      {
        method: 'GET',
        url: '/v1/watchlist/:id/deliveries',
        operationId: 'watchlist.listDeliveries',
        hasBody: false,
        hasParams: true,
        responseStatusCodes: [200, 400, 404, 500],
        successStatusCodes: [200],
        errorStatusCodes: [400, 404, 500],
      },
    ]));
  });
});
