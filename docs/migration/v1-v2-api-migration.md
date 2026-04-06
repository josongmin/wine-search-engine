# V1 → V2 API Migration Guide

**Status:** Wave 3 — V2 routes are publicly available; V1 is in adapter-compatible maintenance  
**Last updated:** 2026-04-07  
**Canonical code reference:** `src/interface/http/routes/route-contracts.ts` (JSDoc on `SEARCH_V2_ROUTES`)

---

## 1. Route Strategy Matrix

The table below covers every registered route from `http-route-contract-catalog.ts`.

| Method | URL | Version | Response Type | operationId | Migration Path |
|--------|-----|---------|---------------|-------------|----------------|
| GET | `/health` | system | — | `system.health` | No change planned |
| GET | `/ready` | system | — | `system.ready` | No change planned |
| GET | `/v1/claude-tools` | V1 machine | tool list | `tools.list` | Machine seam — stays on V1 path; V2 machine format opt-in via executor option |
| POST | `/v1/claude-tools` | V1 machine | tool result | `tools.execute` | Machine seam — stays on V1 path; V2 machine format opt-in via executor option |
| POST | `/v1/search` | V1 | `SearchResponse` / `ComparisonSearchResponse` | `search.execute` | Adapter-compatible; deprecated post-Wave-3 |
| POST | `/v1/search/hybrid` | V1 | `SearchResponse` / `ComparisonSearchResponse` | `search.hybrid` | Adapter-compatible; deprecated post-Wave-3 |
| POST | `/v1/search/interpret` | V1 | `InterpretResponse` | `search.interpret` | Adapter-compatible; deprecated post-Wave-3 |
| POST | `/v1/entity/resolve` | V1 | `ResolveResponse` | `entity.resolve` | No V2 equivalent yet; maintained in V1 |
| POST | `/v1/search/replay` | V1 | `SearchResponse` | `search.replay` | No V2 equivalent yet; maintained in V1 |
| POST | `/v1/batch-search` | V1 | `BatchSearchResponse` | `search.batch` | No V2 equivalent yet; maintained in V1 |
| GET | `/v1/watchlist` | V1 | `ListWatchlistResponse` | `watchlist.list` | No V2 equivalent planned in current wave |
| POST | `/v1/watchlist` | V1 | `CreateWatchlistResponse` | `watchlist.create` | No V2 equivalent planned in current wave |
| GET | `/v1/watchlist/:id` | V1 | `GetWatchlistResponse` | `watchlist.get` | No V2 equivalent planned in current wave |
| DELETE | `/v1/watchlist/:id` | V1 | — | `watchlist.delete` | No V2 equivalent planned in current wave |
| GET | `/v1/watchlist/:id/deliveries` | V1 | `ListDeliveriesResponse` | `watchlist.listDeliveries` | No V2 equivalent planned in current wave |
| POST | `/v1/feedback` | V1 | `PostFeedbackResponse` | `learning.submitFeedback` | No V2 equivalent planned in current wave |
| POST | `/v2/search` | **V2 human** | `SearchResponseV2Human` | `search.v2.execute` | **Available now** — target for human consumers |
| POST | `/v2/search/hybrid` | **V2 human** | `SearchResponseV2Human` | `search.v2.hybrid` | **Available now** — target for human consumers |
| POST | `/v2/search/interpret` | **V2 interpret** | `InterpretResponseV2` | `search.v2.interpret` | **Available now** — target for explain/debug flows |

**Response type tags** (`x-response-type` extension in route contracts):

- `human` — UX-oriented summary card format (`SearchResponseV2Human`)
- `interpret` — Planner explain / debug format (`InterpretResponseV2`)
- machine V2 — No new public route; delivered through `x-response-type: machine` inside the `/v1/claude-tools` seam

---

## 2. V1 Maintenance Policy

V1 routes are **adapter-compatible**: their request and response shapes (field names, status codes, error envelope) will not change until a formal deprecation event.

Rules for V1:

1. No breaking changes to V1 field names or response shapes during Wave 3.
2. `SearchResponse`, `ComparisonSearchResponse`, `InterpretResponse`, and all V1 error schemas remain intact.
3. New capabilities (e.g. drinking-window confidence, improved ranking) may be surfaced on V1 routes as additive fields only (never removing or renaming existing fields).
4. `/v1/entity/resolve`, `/v1/search/replay`, `/v1/batch-search`, and all `/v1/watchlist/*` routes have no planned V2 equivalents in the current wave. They will remain on V1 until a follow-on epic explicitly deprecates them.
5. When V1 routes are formally deprecated (post-Wave-3), they will emit a `Deprecation` response header (RFC 8594) with the sunset date.

---

## 3. V2 Route Adoption Rules

**When adding a new search-related route, follow this matrix:**

| Consumer type | Intent | Surface to use |
|---------------|--------|----------------|
| Human / browser / mobile client | Full search result cards | `POST /v2/search` or `POST /v2/search/hybrid` (`SearchResponseV2Human`) |
| Human / debug / explain | Query interpretation, planner trace | `POST /v2/search/interpret` (`InterpretResponseV2`) |
| Machine / LLM / tool call | Structured retrieval envelope | `POST /v1/claude-tools` with `useV2MachineFormat: true` in tool executor options |
| Human + machine (comparison) | A/B or counterfactual comparison | Keep on V1 family until a V2 comparison family is defined (follow-on epic) |
| Replay / batch / resolve | Deterministic re-run or entity ops | Keep on V1 family; no V2 surface yet |

**New routes that are purely human-facing search results must use `/v2/search*`.**  
**New routes that serve tool/LLM consumers must route through the `/v1/claude-tools` seam, not via a new `/v2/search/*` path.**

### How to register a new V2 route

1. Add a `defineRouteContract({...})` entry in `route-contracts.ts` with `apiVersion: '2'` and the appropriate `responseType`.
2. Add the URL constant to `SEARCH_V2_ROUTES` in `route-contracts.ts`.
3. Register the route in `http-route-contract-catalog.ts` (`DeclaredHttpRouteContractCatalog`).
4. Wire the Fastify handler. Keep handler logic in its own route file under `src/interface/http/routes/`.
5. Run `npm run verify:http-contracts` before merging — this is the migration smoke test.

---

## 4. Machine/LLM Consumer Migration

Machine and LLM consumers (Claude tool use, internal agent callers) do **not** get a new `/v2/search/*` endpoint.

**How to opt into V2 machine format:**

- Set `useV2MachineFormat: true` in the tool execution options passed to `WineToolExecutor`.
- The executor projects `SearchResponseV2Machine` into `tool_result` when this flag is present.
- The `/v1/claude-tools` route URL and request envelope (`tool_name`, `tool_input`, `request_id`) remain unchanged.

**Why keep machine traffic on `/v1/claude-tools`?**

Routing machine consumers through the dedicated tools seam allows:

- Tool-specific validation and fallback logic independent of the public search surface.
- `tool_result` typing that can evolve without touching the human search contract.
- A single place to gate V2 machine format rollout via the `useV2MachineFormat` flag without a URL-level migration.

**Migration steps for a tool/LLM caller:**

1. Continue calling `POST /v1/claude-tools` with the same request body.
2. Add `"useV2MachineFormat": true` inside `tool_input` (or the executor options, depending on the call site).
3. Expect `tool_result` to contain `SearchResponseV2Machine` fields instead of V1 fields.
4. Validate against the `SearchResponseV2Machine` schema exported from `src/interface/http/schemas/search-response-v2.schema.ts`.

---

## 5. Deprecation Schedule

| Phase | Route family | Action |
|-------|--------------|--------|
| Wave 3 (current) | `/v1/search`, `/v1/search/hybrid`, `/v1/search/interpret` | Adapter-compatible maintenance; no deprecation yet |
| Post-Wave-3 (timeline TBD) | `/v1/search`, `/v1/search/hybrid`, `/v1/search/interpret` | Formal deprecation announced; `Deprecation` header emitted |
| Post-deprecation sunset (date TBD) | `/v1/search` family | Routes removed after sunset period |
| Indefinite (until follow-on epic) | `/v1/entity/resolve`, `/v1/search/replay`, `/v1/batch-search`, `/v1/watchlist/*`, `/v1/feedback` | No deprecation planned; remain on V1 |

**V1 routes will emit a `Deprecation` response header (RFC 8594 format) when formally deprecated.** Implementers should monitor for this header and treat its presence as a signal to migrate.

The specific deprecation date is TBD and will be announced in a dedicated deprecation RFC. No code-level deprecation (removal or breaking change) will happen within Wave 3.

---

## 6. Code Decision Tree

Use this when adding a new endpoint to the wine search engine:

```
START: I need to add a new search endpoint.
│
├─ Who is the primary consumer?
│   │
│   ├─ Human / browser / mobile client
│   │   │
│   │   ├─ Does it return search result cards?
│   │   │   ├─ YES → Use POST /v2/search or POST /v2/search/hybrid
│   │   │   │         Response: SearchResponseV2Human
│   │   │   │
│   │   │   └─ Does it explain / interpret the query?
│   │   │       └─ YES → Use POST /v2/search/interpret
│   │   │                 Response: InterpretResponseV2
│   │   │
│   │   └─ Is it comparison / counterfactual?
│   │       └─ YES → Keep on V1 family until V2 comparison epic
│   │                 Response: ComparisonSearchResponse (V1)
│   │
│   ├─ Machine / LLM / tool call
│   │   │
│   │   └─ Route through POST /v1/claude-tools
│   │       Set useV2MachineFormat: true for V2 machine envelope
│   │       Response: SearchResponseV2Machine (inside tool_result)
│   │       DO NOT create a new /v2/search/* route for machine traffic.
│   │
│   └─ Replay / batch / entity ops
│       └─ Keep on V1 family (/v1/search/replay, /v1/batch-search, /v1/entity/resolve)
│           No V2 equivalent yet.
│
REGISTER:
  1. defineRouteContract() in route-contracts.ts (set apiVersion + responseType)
  2. Add URL to SEARCH_V2_ROUTES if it is a V2 route
  3. Add to DeclaredHttpRouteContractCatalog in http-route-contract-catalog.ts
  4. Wire Fastify handler in src/interface/http/routes/
  5. Run: npm run verify:http-contracts
```

---

## References

- Route contracts: `src/interface/http/routes/route-contracts.ts`
- Route catalog: `src/interface/http/routes/http-route-contract-catalog.ts`
- V2 schemas: `src/interface/http/schemas/search-response-v2.schema.ts`
- V1 schemas: `src/interface/http/schemas/search-response.schema.ts`
- Epic plan: `docs/plans/apr-6-engine-v2/epic-6-api-result-contract-redesign.md`
- HTTP surface overview: `docs/http-contract-surface.md`
