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
pnpm run contracts:http -- data/http-contract-manifest.json
pnpm run contracts:http:openapi-bridge -- data/http-openapi-bridge.json
```

The script writes a stable JSON manifest of declared methods, URLs,
operation IDs, and response status codes.

Recommended committed artifact path:

```bash
pnpm run contracts:http -- data/http-contract-manifest.json
```

That file is lightweight enough to diff in PRs when the public route surface changes.

Implementation:
- [`scripts/export-http-contract-manifest.ts`](/Users/songmin/wine-search-engine/scripts/export-http-contract-manifest.ts)
- [`scripts/export-http-openapi-bridge.ts`](/Users/songmin/wine-search-engine/scripts/export-http-openapi-bridge.ts)
- [`src/interface/http/routes/http-route-contract-openapi.ts`](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts)

## Validation

- Runtime registry check:
  [`test/integration/http/routes/route-contract-registry.test.ts`](/Users/songmin/wine-search-engine/test/integration/http/routes/route-contract-registry.test.ts)
- Declared manifest export check:
  [`test/integration/http/routes/http-contract-manifest-script.test.ts`](/Users/songmin/wine-search-engine/test/integration/http/routes/http-contract-manifest-script.test.ts)
- OpenAPI bridge export check:
  [`test/integration/http/routes/http-contract-openapi-bridge.test.ts`](/Users/songmin/wine-search-engine/test/integration/http/routes/http-contract-openapi-bridge.test.ts)
- Public query 403 contract check:
  [`test/integration/http/routes/public-query-contracts.test.ts`](/Users/songmin/wine-search-engine/test/integration/http/routes/public-query-contracts.test.ts)

## Current Limitation

The OpenAPI bridge is generated from route contracts and projects Zod schemas
into a conservative JSON-schema-like form. It is useful for contract drift
detection and tooling bootstrap, but it is not yet a full Swagger UI stack or
a richly annotated hand-authored API spec.

## Replay Contract Note

`POST /v1/search/replay` now accepts an optional
`preflight_honesty_contract` request field. This is a replay-only extension
used by live-snapshot fixture lanes so replay cannot surface a more optimistic
`execution_mode` / `degradation_reasons` contract than the preflight
`/v1/search` response that produced the snapshot.

## `GET /ready` Snapshot Health Block

`GET /ready` now serializes an optional `snapshot_health` block when the
server is wired with a Postgres pool. The block reflects runtime plane
composite-PK migration (016) observability:

```jsonc
{
  "ready": true,
  "timestamp": "2026-04-14T00:00:00.000Z",
  "checks": { "postgres": { "status": "up", "required": true } },
  "snapshot_health": {
    "active_snapshot_id": "search-snapshot:v1:abcdef",
    "previous_snapshot_id": "search-snapshot:v1:012345",  // nullable on first publish
    "stale_row_count": 42,             // rows waiting for the reaper, capped at 100M
    "pointer_age_seconds": 3600        // seconds since active_search_snapshot.promoted_at
  }
}
```

- The field is declared optional on `ReadyResponseSchema`, so clients that
  do not know about it pass validation unchanged. Contract is backwards
  compatible.
- When `PG` is down or the reader throws, the handler omits the block and
  logs a warning at `debug` level — `/ready` never 503s over the auxiliary
  observability gauge.
- Feeds the snapshot reaper alerting loop; see
  [docs/runbook-etl-operator-acks.md](runbook-etl-operator-acks.md) for
  operator procedures.
