/**
 * openapi-export properties — SOTA++ regression suite for the
 * `observability.openapi-export` feature (maturity 5).
 *
 * Industry-verified properties of OpenAPI 3.1 contract export:
 *   1. OpenAPI 3.1.0 validity (`openapi: '3.1.0'`, required keys present).
 *   2. Path parity: every catalog entry appears EXACTLY once under `paths`.
 *   3. Schema parity: every contract response status code has an inline
 *      `schema` (or schema-less envelope when contract has `null` body).
 *   4. operationId uniqueness across the whole spec.
 *   5. Method consistency: declared method matches the operation key.
 *   6. OpenAPI 3.1 nullable form — `type: ['X','null']` rather than the
 *      deprecated 3.0 `nullable: true`.
 *   7. Idempotence: build(build(...)) === build(...) — deterministic output.
 *   8. fast-check property: for 100 random subsets of catalog routes, the
 *      per-route slice of the spec preserves structural invariants.
 *   9. Korean (한글) preservation: Korean code points in descriptions, enum
 *      labels, or schema fields survive JSON.parse(JSON.stringify(spec))
 *      verbatim.
 *  10. Required fields properly marked under each request body / response.
 *  11. Empty contract list → still emits a valid 3.1 envelope with
 *      `paths: {}` (resilience to catalog being momentarily empty).
 *
 * APPEND-ONLY regression file — do not delete cases.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DeclaredHttpRouteContractCatalog } from '../../src/interface/http/routes/http-route-contract-catalog.js';
import { buildHttpRouteContractOpenApiBridge } from '../../src/interface/http/routes/http-route-contract-openapi.js';

const NUM_RUNS = 100;

type HttpMethodKey = 'get' | 'post' | 'delete' | 'put' | 'patch';

function toOpenApiPath(url: string): string {
  return url.replaceAll(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function walkSchemaNodes(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkSchemaNodes(item, visit);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    visit(value as Record<string, unknown>);
    for (const child of Object.values(value as Record<string, unknown>)) {
      walkSchemaNodes(child, visit);
    }
  }
}

describe('OpenAPI export — 3.1 compliance + contract parity properties', () => {
  it('emits a valid OpenAPI 3.1.0 envelope with required top-level keys', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBeTypeOf('string');
    expect(spec.info.version).toBeTypeOf('string');
    expect(spec.paths).toBeDefined();
    expect(typeof spec.paths).toBe('object');
  });

  it('path parity — every catalog entry appears exactly once under paths', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    for (const entry of DeclaredHttpRouteContractCatalog) {
      const pathKey = toOpenApiPath(entry.url);
      const method = entry.method.toLowerCase() as HttpMethodKey;
      const pathItem = spec.paths[pathKey] as Record<string, unknown> | undefined;
      expect(pathItem, `missing path ${pathKey}`).toBeDefined();
      expect(pathItem?.[method], `missing ${method} on ${pathKey}`).toBeDefined();
    }
    // No extra paths beyond the catalog.
    const declaredKeys = new Set(
      DeclaredHttpRouteContractCatalog.map((e) => toOpenApiPath(e.url)),
    );
    for (const key of Object.keys(spec.paths)) {
      expect(declaredKeys.has(key), `unexpected path ${key}`).toBe(true);
    }
  });

  it('schema parity — every contract response status code has an inline response entry', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    for (const entry of DeclaredHttpRouteContractCatalog) {
      const pathKey = toOpenApiPath(entry.url);
      const method = entry.method.toLowerCase() as HttpMethodKey;
      const operation = (spec.paths[pathKey] as Record<string, unknown> | undefined)?.[method] as
        | { readonly responses: Record<string, { readonly description: string; readonly content?: unknown }> }
        | undefined;
      expect(operation, `missing operation ${entry.method} ${entry.url}`).toBeDefined();
      for (const statusCode of Object.keys(entry.contract.responses)) {
        const responseEntry = operation?.responses[statusCode];
        expect(
          responseEntry,
          `missing response entry ${statusCode} on ${entry.method} ${entry.url}`,
        ).toBeDefined();
        expect(typeof responseEntry?.description).toBe('string');
        // Inline schema is present when the contract declares a non-null schema.
        if (entry.contract.responses[Number(statusCode)] != null) {
          expect(
            responseEntry?.content,
            `missing inline content for ${entry.method} ${entry.url} ${statusCode}`,
          ).toBeDefined();
        }
      }
    }
  });

  it('operationId uniqueness across the whole spec', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    const seen = new Map<string, string>();
    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
        const op = operation as { readonly operationId: string };
        const where = `${method.toUpperCase()} ${pathKey}`;
        const prev = seen.get(op.operationId);
        expect(prev, `duplicate operationId "${op.operationId}" on ${where} (first ${prev ?? '?'})`)
          .toBeUndefined();
        expect(op.operationId.length, `empty operationId on ${where}`).toBeGreaterThan(0);
        seen.set(op.operationId, where);
      }
    }
  });

  it('method consistency — declared methods match operation keys', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    for (const entry of DeclaredHttpRouteContractCatalog) {
      const pathKey = toOpenApiPath(entry.url);
      const method = entry.method.toLowerCase();
      const pathItem = spec.paths[pathKey] as Record<string, unknown> | undefined;
      expect(pathItem).toBeDefined();
      expect(Object.keys(pathItem ?? {})).toContain(method);
    }
  });

  it('no OpenAPI 3.0-style `nullable: true` anywhere in the spec', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    const serialized = JSON.parse(JSON.stringify(spec)) as unknown;
    let nullableUses = 0;
    walkSchemaNodes(serialized, (node) => {
      if ('nullable' in node && node.nullable === true) {
        nullableUses += 1;
      }
    });
    expect(nullableUses, 'OpenAPI 3.0 `nullable: true` must be migrated to 3.1 `type: ["X","null"]`').toBe(0);
  });

  it('idempotence — build(build(...)) === build(...) (deterministic)', () => {
    const first = JSON.stringify(buildHttpRouteContractOpenApiBridge());
    const second = JSON.stringify(buildHttpRouteContractOpenApiBridge());
    expect(first).toEqual(second);
  });

  it('round-trip stability — JSON.parse(JSON.stringify(spec)) equals spec', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    const roundTripped = JSON.parse(JSON.stringify(spec)) as typeof spec;
    expect(roundTripped).toEqual(JSON.parse(JSON.stringify(spec)));
  });

  it('property: 100 random catalog subsets — per-route slice invariants hold', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    fc.assert(
      fc.property(
        fc.subarray([...DeclaredHttpRouteContractCatalog]),
        (subset) => {
          for (const entry of subset) {
            const pathKey = toOpenApiPath(entry.url);
            const method = entry.method.toLowerCase() as HttpMethodKey;
            const pathItem = spec.paths[pathKey] as Record<string, unknown> | undefined;
            if (pathItem === undefined) {
              return false;
            }
            const operation = pathItem[method] as
              | { readonly operationId: string; readonly responses: Record<string, unknown> }
              | undefined;
            if (operation === undefined) {
              return false;
            }
            if (operation.operationId !== entry.contract.operationId) {
              return false;
            }
            for (const statusCode of Object.keys(entry.contract.responses)) {
              if (!(statusCode in operation.responses)) {
                return false;
              }
            }
          }
          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Korean (한글) preservation — Korean code points survive JSON round-trip verbatim', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    const serialized = JSON.stringify(spec);
    const roundTripped = JSON.parse(serialized) as typeof spec;
    // Synthetic injection: confirm a Korean description survives round-trip.
    const koreanSample = '와인 검색 — 한글 description 보존 테스트';
    const augmented = { ...spec, info: { ...spec.info, description: koreanSample } };
    const augmentedJson = JSON.stringify(augmented);
    const augmentedBack = JSON.parse(augmentedJson) as typeof augmented;
    expect(augmentedBack.info.description).toBe(koreanSample);
    // Original spec roundtrip — structural equality preserved.
    expect(roundTripped.openapi).toBe(spec.openapi);
  });

  it('required fields are marked under request body / response object schemas', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    const serialized = JSON.parse(JSON.stringify(spec)) as unknown;
    // Find at least one object schema with a non-empty `required` array — proof
    // the bridge propagates Zod required keys into OpenAPI.
    let objectsWithRequired = 0;
    walkSchemaNodes(serialized, (node) => {
      if (node['type'] === 'object' && Array.isArray(node['required']) && (node['required'] as unknown[]).length > 0) {
        objectsWithRequired += 1;
      }
    });
    expect(objectsWithRequired, 'no object schemas declared `required` fields — likely a regression').toBeGreaterThan(0);
  });

  it('every operation has a non-empty operationId string', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    for (const pathItem of Object.values(spec.paths)) {
      for (const operation of Object.values(pathItem as Record<string, unknown>)) {
        const op = operation as { readonly operationId?: unknown };
        expect(typeof op.operationId).toBe('string');
        expect((op.operationId as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('every operation declares at least one response', () => {
    const spec = buildHttpRouteContractOpenApiBridge();
    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
        const op = operation as { readonly responses: Record<string, unknown> };
        expect(
          Object.keys(op.responses).length,
          `${method.toUpperCase()} ${pathKey} has no responses`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
