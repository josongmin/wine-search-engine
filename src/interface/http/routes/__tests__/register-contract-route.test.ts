import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHttpRouteContractManifest,
  getRegisteredHttpRouteContracts,
  registerContractRoute,
} from '../register-contract-route.js';
import { HybridSearchRouteContract } from '../route-contracts.js';

describe('registerContractRoute', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.map(async (app): Promise<void> => { await app.close(); }));
    apps.length = 0;
  });

  it(
    'keeps contract registries isolated per Fastify instance',
    { timeout: 15_000 },
    () => {
      const appA = Fastify();
      const appB = Fastify();
      apps.push(appA, appB);

      registerContractRoute(appA, {
        method: 'POST',
        url: '/v1/search/hybrid',
        contract: HybridSearchRouteContract,
        handler: async () => ({ ok: true }),
      });

      expect(getRegisteredHttpRouteContracts(appA)).toHaveLength(1);
      expect(getRegisteredHttpRouteContracts(appB)).toEqual([]);
    },
  );

  it('returns a defensive copy of the stored contracts', () => {
    const app = Fastify();
    apps.push(app);

    registerContractRoute(app, {
      method: 'POST',
      url: '/v1/search/hybrid',
      contract: HybridSearchRouteContract,
      handler: async () => ({ ok: true }),
    });

    const firstRead = getRegisteredHttpRouteContracts(app);
    const secondRead = getRegisteredHttpRouteContracts(app);

    expect(firstRead).toHaveLength(1);
    expect(secondRead).toHaveLength(1);
    expect(firstRead).not.toBe(secondRead);
  });

  it('builds a sorted manifest for downstream tooling', () => {
    const app = Fastify();
    apps.push(app);

    registerContractRoute(app, {
      method: 'POST',
      url: '/v1/search/hybrid',
      contract: HybridSearchRouteContract,
      handler: async () => ({ ok: true }),
    });
    registerContractRoute(app, {
      method: 'GET',
      url: '/health',
      contract: {
        operationId: 'system.health',
        responses: { 200: null },
      },
      handler: async () => ({ ok: true }),
    });

    const manifest = buildHttpRouteContractManifest(app);

    expect(manifest.version).toBe(1);
    expect(manifest.routes.map((route) => route.operationId)).toEqual([
      'system.health',
      'search.hybrid',
    ]);
    expect(manifest.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationId: 'system.health',
        hasBody: false,
        hasParams: false,
        successStatusCodes: [200],
        errorStatusCodes: [],
      }),
      expect.objectContaining({
        operationId: 'search.hybrid',
        hasBody: true,
        hasParams: false,
        successStatusCodes: [200],
        errorStatusCodes: [400, 403, 408, 429, 500, 503],
      }),
    ]));
  });
});
