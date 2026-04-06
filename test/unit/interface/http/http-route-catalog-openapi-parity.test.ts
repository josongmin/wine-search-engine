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

  it('all operationId values are unique across the catalog (duplicate operationId breaks codegen)', () => {
    const seen = new Map<string, string>();
    for (const entry of DeclaredHttpRouteContractCatalog) {
      const { operationId } = entry.contract;
      const prev = seen.get(operationId);
      expect(
        prev,
        `duplicate operationId "${operationId}" on ${entry.method} ${entry.url} (first seen on ${prev ?? '?'})`,
      ).toBeUndefined();
      seen.set(operationId, `${entry.method} ${entry.url}`);
    }
  });

  it('every catalog entry has a non-empty operationId', () => {
    for (const entry of DeclaredHttpRouteContractCatalog) {
      expect(
        entry.contract.operationId.length,
        `empty operationId on ${entry.method} ${entry.url}`,
      ).toBeGreaterThan(0);
    }
  });

  it('no duplicate {method, url} pairs in the catalog (collision overwrites OpenAPI operation)', () => {
    const seen = new Map<string, string>();
    for (const entry of DeclaredHttpRouteContractCatalog) {
      const key = `${entry.method} ${entry.url}`;
      const prev = seen.get(key);
      expect(
        prev,
        `duplicate catalog entry "${key}" (operationId ${entry.contract.operationId}) already seen`,
      ).toBeUndefined();
      seen.set(key, entry.contract.operationId);
    }
  });
});
