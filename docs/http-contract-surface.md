# HTTP Contract Surface

The repo's current HTTP contract source of truth is the route contract catalog.
The OpenAPI bridge and replay-specific public contract docs were retired with the
non-core HTTP surface cleanup.

## Sources of Truth

- Declared catalog:
  [`src/interface/http/routes/http-route-contract-catalog.ts`](src/interface/http/routes/http-route-contract-catalog.ts)
- Contract definitions:
  [`src/interface/http/routes/route-contracts.ts`](src/interface/http/routes/route-contracts.ts)
- Runtime registration:
  [`src/interface/http/routes/register-contract-route.ts`](src/interface/http/routes/register-contract-route.ts)

Public entity lookup is **`POST /v2/entity-lookup`** (`entity.lookup.v2`). Legacy
`/v1/lookup/wine`, `/v1/entity/resolve`, and `/v1/entity/autocomplete` were removed
in the 2026-06 V2 cutover.

## Exporting the Manifest

Use:

```bash
pnpm run contracts:http -- data/http-contract-manifest.json
```

The script writes a stable JSON manifest of declared methods, URLs,
operation IDs, and response status codes.

One-shot verification:

```bash
pnpm run verify:http-contracts
```

Recommended committed artifact path:

```bash
pnpm run contracts:http -- data/http-contract-manifest.json
```

That file is lightweight enough to diff in PRs when the public route surface changes.

Implementation:
- [`scripts/export-http-contract-manifest.ts`](scripts/export-http-contract-manifest.ts)

## Validation

- Runtime registry check:
  [`test/integration/http/routes/route-contract-registry.test.ts`](test/integration/http/routes/route-contract-registry.test.ts)
- Catalog-to-server parity:
  [`test/regression/http-route-catalog-server-parity.regression.test.ts`](test/regression/http-route-catalog-server-parity.regression.test.ts)
- Declared manifest export check:
  [`src/interface/http/routes/__tests__/http-contract-manifest-script.test.ts`](src/interface/http/routes/__tests__/http-contract-manifest-script.test.ts)
- Public query + entity lookup error envelopes:
  [`test/integration/http/routes/public-query-contracts.test.ts`](test/integration/http/routes/public-query-contracts.test.ts)
- Entity lookup V2 route integration:
  [`test/integration/http/routes/entity-lookup-v2.route.test.ts`](test/integration/http/routes/entity-lookup-v2.route.test.ts)

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

## Entity Lookup V2 Ops — `POST /v2/entity-lookup/ops/coverage-health`

Debug-key gated read (`X-Debug-Key`). Response includes curation queue counts
plus materialization backlog:

| Field | Meaning |
|-------|---------|
| `queue_by_status` | Proposal counts by `pending` / `approved` / `rejected` / `published` |
| `queue_by_kind` | Counts by `alias` / `ambiguity` / `suppression` |
| `total_proposals` | Sum across staging tables |
| `published_awaiting_materialization` | `published` rows without `materialized_snapshot_id` (migration 033); when 033 columns are absent, all `published` rows count as awaiting |
| `legacy_approved_abbreviation_backlog` | `approved` + `abbreviation` rows still on the transitional ETL overlay path (ops publish required for materialization tracking) |
| `lookup_runtime` | Active snapshot id, `family_graph_edge_count`, LTR unsupported reason, unwired substrate ids (from lookup authority bootstrap) |

Schema: [`entity-lookup-v2-ops.schema.ts`](../src/interface/http/schemas/entity-lookup-v2-ops.schema.ts).
Operator runbook: [docs/runbook-curation-materialization.md](runbook-curation-materialization.md).

## Entity Lookup V2 Ops — write plane (X-Ops-Write-Key)

All routes below require `X-Ops-Write-Key` (see
[`http-ops-write-mode.ts`](../src/interface/http/middleware/http-ops-write-mode.ts)).

| Route | Purpose |
|-------|---------|
| `POST /v2/entity-lookup/ops/proposals` | List/filter staging proposals (`status`, `kind`, `limit`) |
| `POST /v2/entity-lookup/ops/proposals/submit` | Create alias / ambiguity / suppression proposal (`kind` discriminant) |
| `POST /v2/entity-lookup/ops/proposals/review` | Transition `pending` → `approved` or `rejected` (`decision`) |
| `POST /v2/entity-lookup/ops/proposals/publish` | Transition `approved` → `published` (staging marker; snapshot ETL consumes) |

Read-only ops routes (X-Debug-Key):

| Route | Purpose |
|-------|---------|
| `POST /v2/entity-lookup/ops/inspect` | Live lookup playground for a query surface |
| `POST /v2/entity-lookup/ops/alias-audit` | Entity-bound alias + related proposal audit |
