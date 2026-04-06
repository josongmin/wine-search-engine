# HTTP Contract Surface

The repo's current HTTP contract source of truth is the route contract catalog,
not OpenAPI.

## Sources of Truth

- Declared catalog:
  [`src/interface/http/routes/http-route-contract-catalog.ts`](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-catalog.ts)
- Contract definitions:
  [`src/interface/http/routes/route-contracts.ts`](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts)
- Runtime registration:
  [`src/interface/http/routes/register-contract-route.ts`](/Users/songmin/wine-search-engine/src/interface/http/routes/register-contract-route.ts)

## Exporting the Manifest

Use:

```bash
npm run contracts:http -- data/http-contract-manifest.json
```

The script writes a stable JSON manifest of declared methods, URLs,
operation IDs, and response status codes.

Recommended committed artifact path:

```bash
npm run contracts:http -- data/http-contract-manifest.json
```

That file is lightweight enough to diff in PRs when the public route surface changes.

Implementation:
- [`scripts/export-http-contract-manifest.ts`](/Users/songmin/wine-search-engine/scripts/export-http-contract-manifest.ts)

## Validation

- Runtime registry check:
  [`test/integration/http/routes/route-contract-registry.test.ts`](/Users/songmin/wine-search-engine/test/integration/http/routes/route-contract-registry.test.ts)
- Declared manifest export check:
  [`test/integration/http/routes/http-contract-manifest-script.test.ts`](/Users/songmin/wine-search-engine/test/integration/http/routes/http-contract-manifest-script.test.ts)
- Public query 403 contract check:
  [`test/integration/http/routes/public-query-contracts.test.ts`](/Users/songmin/wine-search-engine/test/integration/http/routes/public-query-contracts.test.ts)

## Current Limitation

OpenAPI/Swagger generation is still not implemented. The manifest is enough to
track the declared route surface and contract drift, but it is not a full API
description format.
