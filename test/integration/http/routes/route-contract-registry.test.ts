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
        method: 'POST',
        url: '/v1/search',
        operationId: 'search.execute',
        responseStatusCodes: [200, 400, 403, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/batch-search',
        operationId: 'search.batch',
        responseStatusCodes: [207, 400, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/search/replay',
        operationId: 'search.replay',
        responseStatusCodes: [200, 400, 409, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/search/interpret',
        operationId: 'search.interpret',
        responseStatusCodes: [200, 400, 403, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/entity/resolve',
        operationId: 'entity.resolve',
        responseStatusCodes: [200, 400, 403, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/search/hybrid',
        operationId: 'search.hybrid',
        responseStatusCodes: [200, 400, 403, 429, 500],
      },
      {
        method: 'POST',
        url: '/v1/watchlist',
        operationId: 'watchlist.create',
        responseStatusCodes: [201, 400, 500],
      },
      {
        method: 'GET',
        url: '/v1/watchlist/:id',
        operationId: 'watchlist.get',
        responseStatusCodes: [200, 400, 404, 500],
      },
      {
        method: 'DELETE',
        url: '/v1/watchlist/:id',
        operationId: 'watchlist.delete',
        responseStatusCodes: [204, 400, 404, 500],
      },
      {
        method: 'GET',
        url: '/v1/watchlist/:id/deliveries',
        operationId: 'watchlist.listDeliveries',
        responseStatusCodes: [200, 400, 404, 500],
      },
    ]));
  });
});
