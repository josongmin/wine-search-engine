# Search pipeline — system overview

Code-oriented map of how HTTP search-related requests flow through Fastify into application use cases, domain, and infrastructure. **Canonical routes** are listed in `src/interface/http/routes/http-route-contract-catalog.ts`.

**Last updated:** 2026-04-06

---

## HTTP boundary

- **Registration:** `src/interface/http/server.ts` wires routes (`registerSearchRoute`, `registerBatchSearchRoute`, `registerReplayRoute`, `registerInterpretRoute`, `registerResolveRoute`, `registerHybridRoute`, …) and attaches the global **`errorHandler`**.
- **Serialization:** A `preSerialization` hook converts response payload keys from **camelCase → snake_case** (RFC-014 §4.2) so internal DTOs stay idiomatic TypeScript while clients receive snake_case.
- **Errors:** `src/interface/http/middleware/error-handler.ts` maps `DomainError`, `SnapshotMismatchError`, `ZodError`, rate-limit (`429`), and unknown errors to HTTP status + RFC-014-shaped bodies. Policy blocks (`POLICY_BLOCKED`) → **403**; replay snapshot mismatch → **409**; validation → **400**.

---

## Search-family endpoints (capability matrix)

| HTTP | Use case | What runs |
|------|----------|-----------|
| `POST /v1/search` | `SearchUseCase` | Full pipeline: shared pre-route → route resolution → `dispatchSearchRouteExecution` (entity / hybrid / mixed) → shared post-route |
| `POST /v1/search/hybrid` | `HybridUseCase` | Same **pre-route** and **post-route** as main search; middle stage is **hybrid-only** ranking (`executeHybridRouteRankingPipeline`). Request is converted to `SearchRequest` with `retrieval_mode: 'hybrid'` and `options.mode: 'hybrid'` (`src/application/search/hybrid.usecase.ts`). |
| `POST /v1/batch-search` | `BatchSearchUseCase` | Orchestrates many search-shaped requests; HTTP **200** means the batch transport succeeded — inspect per-item `status` in the payload (`src/interface/http/routes/batch-search.route.ts`). See also `docs/batch-search.md`. |
| `POST /v1/search/replay` | `ReplayUseCase` | Calls **`SearchUseCase.execute` once** (full pipeline), then validates **decision snapshot** (and optional **response hash** for determinism). Throws `SnapshotMismatchError` / `DeterminismViolationError` when checks fail (`src/application/search/replay.usecase.ts`). |
| `POST /v1/search/interpret` | `InterpretUseCase` | **Security gate** → **`QueryPlanner.plan` only** — no retrieval, ranking, or decision engine (`src/application/search/interpret.usecase.ts`). |
| `POST /v1/entity/resolve` | `ResolveUseCase` | **Security gate** → planner → **ConstraintSAT** (early exit on contradiction) → **entity resolution only** (`src/application/search/resolve.usecase.ts`). |

**Important:** `POST /v1/search` is not the only entry; hybrid, batch, replay, interpret, and resolve are **different** HTTP surfaces with different guarantees.

---

## Main search path (`SearchUseCase`)

Implementation: `src/application/search/search.usecase.ts`.

1. **`runSearchPreRoutePhase`** (`search-usecase-pre-route-phase.ts`):  
   - Security gate (`createSearchQuerySecurityGate` → `getSafeQueryOrThrow`)  
   - Optional Epic 14 **decomposition** (A vs B) — may return early with a full response  
   - **`QueryPlanner.plan`**  
   - **ConstraintSAT** — may build an early exit response via `ResponseBuilder`  
   - Optional **cache hit** — may return cached response  

2. **Route resolution:** `buildSearchRouteResolutionContext(plan, request)` — effective route considers top-level `retrieval_mode` vs planner suggestion.

3. **`dispatchSearchRouteExecution`** (`search-usecase-route-dispatch.ts`):  
   - **Entity:** `executeEntityRoute` → resolver  
   - **Hybrid:** `executeHybridRoute` → hybrid candidates + `runHybridRankingPipeline`  
   - **Mixed:** `mixedSolver.solve` → adapted to the same execution shape  

4. **`runSearchPostRoutePhase`** (`search-usecase-post-route-phase.ts`):  
   - Entropy abstain (RFC-013) → **DecisionEngine** → **ResponseBuilder** → optional cache write, snapshot/meta fields  

Hybrid and mixed details are split across `search-usecase-hybrid-*.ts`, `search-usecase-mixed-route.ts`, and related helpers.

---

## Security (query entry)

Pre-route and interpret/resolve share the same **security gate** pattern: `src/application/search/search-usecase-security-gate.ts` (sanitizer + optional injection judge + metrics). Blocked queries surface as policy/domain errors and map to **403** via the error handler when applicable.

---

## Related RFCs

- **RFC-014** — HTTP error contract, snake_case boundary  
- **RFC-015** — decision snapshots / version strings  
- **RFC-009** — determinism / replay hashing (see replay use case)  
- **RFC-013** — abstention / entropy  

Index: `docs/RFC-INDEX.md`.

---

## Quick file index

| Concern | Location |
|--------|----------|
| Route registration | `src/interface/http/server.ts` |
| Search contracts / URLs | `src/interface/http/routes/http-route-contract-catalog.ts` |
| Search routes | `src/interface/http/routes/search.route.ts`, `hybrid.route.ts`, `batch-search.route.ts`, `replay.route.ts`, `interpret.route.ts`, `resolve.route.ts` |
| Pre-route / post-route | `search-usecase-pre-route-phase.ts`, `search-usecase-post-route-phase.ts` |
| Route dispatch | `search-usecase-route-dispatch.js`, `search-usecase-route-resolution.ts` |
| Hybrid use case | `hybrid.usecase.ts`, `search-usecase-hybrid-ranking-pipeline.ts` |
| Replay | `replay.usecase.ts`, `search-usecase-decision-snapshot.ts` |
| Global errors | `src/interface/http/middleware/error-handler.ts` |
