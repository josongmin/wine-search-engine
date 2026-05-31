# HTTP Contract Surface

The repo's current HTTP contract source of truth is the route contract catalog.
The OpenAPI bridge and replay-specific public contract docs were retired with the
non-core HTTP surface cleanup.

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

## Validation

- Runtime registry check:
  [`test/integration/http/routes/route-contract-registry.test.ts`](/Users/songmin/wine-search-engine/test/integration/http/routes/route-contract-registry.test.ts)
- Catalog-to-server parity:
  [`test/regression/http-route-catalog-server-parity.regression.test.ts`](/Users/songmin/wine-search-engine/test/regression/http-route-catalog-server-parity.regression.test.ts)
- Declared manifest export check:
  [`src/interface/http/routes/__tests__/http-contract-manifest-script.test.ts`](/Users/songmin/wine-search-engine/src/interface/http/routes/__tests__/http-contract-manifest-script.test.ts)
- Public query 403 contract check:
  [`test/integration/http/routes/public-query-contracts.test.ts`](/Users/songmin/wine-search-engine/test/integration/http/routes/public-query-contracts.test.ts)

## Current Limitation

The committed manifest is intentionally small: methods, URLs, operation IDs,
and status-code envelopes. It is a drift-detection artifact, not a full
hand-authored API reference.

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
