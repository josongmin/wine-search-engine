import { describe, expect, it } from 'vitest';
import { buildDeclaredHttpRouteContractManifest } from '../http-route-contract-catalog.js';
import { buildHttpRouteContractOpenApiBridge } from '../http-route-contract-openapi.js';

function toOpenApiPath(url: string): string {
  return url.replaceAll(/:([A-Za-z0-9_]+)/g, '{$1}');
}

describe('HTTP contract OpenAPI parity', () => {
  it('keeps manifest and OpenAPI-lite bridge aligned for every declared route', () => {
    const manifest = buildDeclaredHttpRouteContractManifest();
    const bridge = buildHttpRouteContractOpenApiBridge();

    for (const route of manifest.routes) {
      const pathItem = bridge.paths[toOpenApiPath(route.url)];
      const operation = pathItem?.[route.method.toLowerCase() as 'get' | 'post' | 'delete' | 'put' | 'patch'];

      expect(operation, `${route.method} ${route.url}`).toBeDefined();
      expect(operation).toEqual(expect.objectContaining({
        operationId: route.operationId,
        'x-contract-has-body': route.hasBody,
        'x-contract-has-params': route.hasParams,
        'x-contract-success-status-codes': route.successStatusCodes,
        'x-contract-error-status-codes': route.errorStatusCodes,
      }));

      expect(Object.keys(operation?.responses ?? {})).toEqual(
        route.responseStatusCodes.map(String),
      );
    }
  });
});
