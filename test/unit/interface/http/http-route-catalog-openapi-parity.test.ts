import { describe, expect, it } from 'vitest';
import { DeclaredHttpRouteContractCatalog } from '../../../../src/interface/http/routes/http-route-contract-catalog.js';
import { buildHttpRouteContractOpenApiBridge } from '../../../../src/interface/http/routes/http-route-contract-openapi.js';

/**
 * Mirrors `toOpenApiPath` in http-route-contract-openapi.ts — must stay in sync.
 */
function toOpenApiPath(url: string): string {
  return url.replaceAll(/:([A-Za-z0-9_]+)/g, '{$1}');
}

describe('DeclaredHttpRouteContractCatalog ↔ OpenAPI bridge', () => {
  it('exposes every declared contract route in the generated OpenAPI paths', () => {
    const doc = buildHttpRouteContractOpenApiBridge();

    for (const entry of DeclaredHttpRouteContractCatalog) {
      const pathKey = toOpenApiPath(entry.url);
      const method = entry.method.toLowerCase() as 'get' | 'post' | 'delete' | 'put' | 'patch';
      const pathItem = doc.paths[pathKey];
      expect(pathItem, `missing path ${pathKey} for catalog entry ${entry.method} ${entry.url}`).toBeDefined();
      expect(
        pathItem?.[method],
        `missing ${method} on ${pathKey} (operationId ${entry.contract.operationId})`,
      ).toBeDefined();
    }
  });

  it('has no stray path keys beyond declared routes (strict parity)', () => {
    const doc = buildHttpRouteContractOpenApiBridge();
    const declaredKeys = new Set(
      DeclaredHttpRouteContractCatalog.map((e) => toOpenApiPath(e.url)),
    );
    const keys = Object.keys(doc.paths);
    const extra = keys.filter((k) => !declaredKeys.has(k));
    expect(extra.length, `unexpected OpenAPI paths: ${extra.join(', ')}`).toBe(0);
  });
});
