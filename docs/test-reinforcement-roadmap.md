# Test Reinforcement Roadmap

## Goal

Build a reliable test pyramid for the HTTP/API surface and search quality stack without mixing transport-contract regressions, fixture limitations, and true relevance failures in the same suite.

Execution companion:

- see [docs/test-reinforcement-p0-tickets.md](/Users/songmin/wine-search-engine/docs/test-reinforcement-p0-tickets.md) for the immediate ticketized `P0` workset

## Baseline

- Date: 2026-04-06
- `npm run test:e2e` currently fails with `117 failed / 178 passed / 71 skipped`.
- The main fast-suite failure mode is response-shape drift: the server serializes response bodies to `snake_case`, but several in-memory E2E files still assert `camelCase`.
- The current in-memory E2E server loads aliases, retrieval docs, and blocking IDs, but it does not seed mixed-route dependencies such as `anchorResolver`, `similarRetrieval`, and `candidateAttributes`. Mixed queries therefore cannot be treated as production-faithful quality signals in the current harness.

## Current HTTP Surface

Routes registered by the server:

- `GET /health`
- `GET /ready`
- `GET /v1/claude-tools`
- `POST /v1/claude-tools`
- `POST /v1/search`
- `POST /v1/batch-search`
- `POST /v1/search/replay`
- `POST /v1/search/interpret`
- `POST /v1/entity/resolve`
- `POST /v1/search/hybrid`
- `POST /v1/watchlist`
- `GET /v1/watchlist/:id`
- `DELETE /v1/watchlist/:id`
- `GET /v1/watchlist/:id/deliveries`

## Coverage Snapshot

| Endpoint / concern | Current coverage | Notes | Priority |
| --- | --- | --- | --- |
| `POST /v1/search` | Strong E2E + integration | Fast suite currently noisy due contract drift and aspirational ranking assertions | P0 |
| `POST /v1/search/replay` | Strong E2E | Determinism/error contract already covered; normalize to snake_case | P0 |
| `POST /v1/search/interpret` | Strong E2E + schema integration | Some E2E assertions still use camelCase transport names | P0 |
| `POST /v1/entity/resolve` | Strong E2E + integration | Mostly transport cleanup | P1 |
| `POST /v1/search/hybrid` | Moderate E2E | Good target for fast semantic smoke only, not full quality regression | P1 |
| `GET /health` | Present in E2E + server integration | Keep small and stable | P2 |
| `GET /ready` | Present in E2E + server integration | Add one E2E for degraded readiness via configured checks if needed | P2 |
| `POST /v1/batch-search` | Integration only | Missing full-server E2E path including request context, serialization, headers | P0 |
| `GET/POST /v1/claude-tools` | Integration only | Missing E2E coverage through actual server hooks and headers | P0 |
| `POST/GET/DELETE /v1/watchlist*` | Route/unit-ish tests in `src/__tests__` | Missing full-server E2E coverage and cross-cutting behavior checks | P0 |
| CORS / `OPTIONS *` | Server integration only | Missing explicit E2E coverage for preflight and env-specific origin behavior | P1 |
| Rate limit / content-type / request-id | E2E present | Good candidates to keep in fast suite after cleanup | P1 |
| Mixed queries (`similar_items`) | Failing E2E | Current harness is incomplete; either seed mixed adapters or move most checks to integration/Vespa | P0 |
| Search quality / golden relevance | In-memory E2E + Vespa E2E | In-memory quality expectations should move to Vespa | P0 |

## Parallel Workstreams

### Track A: Stabilize the fast in-memory E2E suite

Purpose:
Make `npm run test:e2e` a trustworthy PR gate.

Actions:

- Normalize transport assertions to `snake_case` in:
  - `test/e2e/infrastructure.test.ts`
  - `test/e2e/response-invariants.test.ts`
  - `test/e2e/edge-cases.test.ts`
  - `test/e2e/user-journeys.test.ts`
  - `test/e2e/realistic-scenarios.test.ts`
  - `test/e2e/golden-set.test.ts`
  - `test/e2e/hard-scenarios.test.ts`
- Introduce a shared E2E response helper in `test/e2e/helpers/` that parses search responses with the HTTP schema and exposes transport-accurate field accessors.
- Collapse overlapping “contract” assertions into one transport-focused layer instead of repeating the same checks across `search-api`, `schema-contract`, `response-invariants`, and `infrastructure`.

Keep in fast suite:

- contract validation
- protocol invariants
- error envelope
- request-id correlation
- content-type enforcement
- concurrency isolation
- replay snapshot behavior

Reduce or remove from fast suite:

- top-k relevance quality
- multilingual ranking expectations beyond exact alias retrieval
- dense/hybrid semantic quality claims that depend on non-trivial retrieval quality

Suggested owner:

- one person focuses only on transport cleanup and shared helpers
- one person focuses only on collapsing duplicate invariant checks
- do not mix this track with Vespa quality migration in the same PR

### Track B: Cover missing HTTP/API surface end-to-end

Purpose:
Ensure every route registered in the server has at least one full-server E2E exercising middleware, request context, serialization, and error handling.

Add new E2E files:

- `test/e2e/batch-search-api.test.ts`
  - happy-path 207 multi-status
  - mixed success/failure payload
  - request-id/header correlation
  - unsupported media type and validation errors
- `test/e2e/claude-tools-api.test.ts`
  - `GET /v1/claude-tools` manifest shape
  - `POST /v1/claude-tools` success path
  - bad payload rejection
  - request-id/header coverage
- `test/e2e/watchlist-api.test.ts`
  - create/get/delete/deliveries
  - 404 and validation paths
  - snake_case response body assertions
  - request-id/header coverage
- `test/e2e/server-protocol.test.ts`
  - `OPTIONS` preflight
  - CORS behavior in test/dev mode
  - readiness degraded path via configured health checks if a dedicated harness is added

After these land, every route in `src/interface/http/server.ts` will have true end-to-end coverage.

Suggested owner:

- one person owns all new route-surface E2E additions
- prefer one helper layer for request-id/header assertions so route suites stay small

### Track C: Fix mixed-query harness and separate quality from harness bugs

Purpose:
Stop conflating missing in-memory test data with product behavior.

Actions:

- Seed mixed-route dependencies in the test server or create a dedicated mixed-query E2E harness:
  - `anchorResolver`
  - `similarRetrieval`
  - `candidateAttributes`
- Add a targeted suite such as `test/e2e/mixed-search.test.ts` for:
  - known anchor query
  - missing anchor fallback
  - unresolved anchor safety behavior
  - empty similar-candidate behavior
- If full mixed behavior cannot be modeled faithfully in-memory, keep only “no 500 / graceful fallback” checks in fast E2E and move quality assertions to integration or Vespa.

Suggested owner:

- one person owns the harness/data side only
- do not couple this with unrelated route-surface work

### Track D: Move SOTA++ search quality assertions to Vespa

Purpose:
Put ranking, multilingual quality, semantic retrieval, and golden sets on the backend that actually represents production behavior.

Actions:

- Re-scope these in-memory files into Vespa-backed suites or retire them after migration:
  - `test/e2e/golden-set.test.ts`
  - `test/e2e/user-journeys.test.ts`
  - `test/e2e/realistic-scenarios.test.ts`
  - most of `test/e2e/hard-scenarios.test.ts`
- Keep Vespa suites focused by responsibility:
  - `test/e2e/vespa/infrastructure-pipeline.test.ts`: feed/update/delete/index pipeline
  - `test/e2e/vespa/search-correctness.test.ts`: lexical/filter correctness
  - `test/e2e/vespa/search-quality.test.ts`: semantic quality, multilingual equivalence, ambiguity, response completeness
- Add one more Vespa suite if needed:
  - `test/e2e/vespa/golden-regression.test.ts`
  - source queries from a curated gold set file under `data/` or `test/e2e/vespa/fixtures/`

Guideline:

- In-memory E2E proves the server contract.
- Vespa E2E proves retrieval and ranking quality.

Suggested owner:

- one person owns the Vespa suite split, gold set extraction, and nightly strategy
- this track can progress in parallel with Track A because the assertions should stop sharing helpers beyond transport parsing

## P0 / P1 / P2 Execution Order

### P0: Make the roadmap actionable this week

- fix snake_case drift in the fast in-memory suites
- add a shared transport-accurate E2E helper under `test/e2e/helpers/`
- add missing route-surface E2E for:
  - `/v1/batch-search`
  - `/v1/claude-tools`
  - `/v1/watchlist*`
- stop mixed queries from returning 500 in the in-memory harness, or explicitly downgrade them to graceful fallback checks
- move in-memory-only golden/relevance expectations out of the PR fast suite

Exit:

- `npm run test:e2e` is green
- no failing fast E2E depends on camelCase transport assumptions
- no registered HTTP route is missing E2E coverage

### P1: Make the PR gate trustworthy

- shrink in-memory E2E to contract/protocol/smoke responsibilities only
- merge or retire duplicate invariant suites
- add `test:e2e` to PR CI
- keep PR gate deterministic and free from Vespa setup requirements

Exit:

- CI runs fast E2E on pull requests
- fast E2E failures are mostly actionable app regressions, not fixture noise

### P2: Reach SOTA++ quality regression

- extract a versioned Vespa gold set
- split Vespa into smoke vs nightly quality regression
- add multilingual/entity/semantic quality metrics such as top-1, top-k, MRR, recall@k
- add corpus/version preflight checks before quality assertions

Exit:

- PR path stays fast
- nightly path catches real ranking regressions
- quality failures are attributable to relevance drift rather than setup drift

## Recommended Parallel Delivery Shape

Use three concurrent PR streams:

- Stream 1: `fast-e2e-contracts`
  - transport helper
  - snake_case cleanup
  - duplicate invariant collapse
- Stream 2: `route-surface-e2e`
  - batch search
  - claude tools
  - watchlist
  - protocol/CORS coverage
- Stream 3: `quality-separation`
  - mixed-query harness fix
  - move golden/realistic/user-journey quality cases toward Vespa
  - define smoke vs nightly Vespa split

Merge order:

- Stream 1 first
- Stream 2 second
- Stream 3 can branch early but should rebase after Stream 1 lands

## Recommended File-Level Restructure

Keep and tighten:

- `test/e2e/search-api.test.ts`
- `test/e2e/schema-contract.test.ts`
- `test/e2e/infrastructure.test.ts`
- `test/e2e/edge-cases.test.ts`

Rewrite/split:

- `test/e2e/response-invariants.test.ts`
  - keep only invariant checks not already covered elsewhere
- `test/e2e/user-journeys.test.ts`
  - either convert to snake_case + mixed fallback only, or migrate most scenarios to Vespa
- `test/e2e/realistic-scenarios.test.ts`
  - migrate to Vespa quality regression
- `test/e2e/golden-set.test.ts`
  - migrate to Vespa golden regression
- `test/e2e/hard-scenarios.test.ts`
  - split into fast failure-mode checks vs Vespa quality checks

Add:

- `test/e2e/batch-search-api.test.ts`
- `test/e2e/claude-tools-api.test.ts`
- `test/e2e/watchlist-api.test.ts`
- `test/e2e/server-protocol.test.ts`
- `test/e2e/mixed-search.test.ts`
- optionally `test/e2e/vespa/golden-regression.test.ts`

## CI Test Pyramid

### PR required gates

Run on every pull request:

- `npm run lint`
- `npm run typecheck`
- unit/domain/application tests
- integration HTTP route tests
- fast in-memory E2E only

Target:

- total PR gate should stay fast and deterministic
- no Docker/Vespa dependency in the default PR path

### Merge-to-main or protected optional gate

Run on `main` or as an optional required workflow if infra permits:

- `npm run test:e2e`
- focused DB/Redis integration suites

### Nightly / scheduled / manual deep regression

Run separately:

- `npm run test:e2e:vespa`
- full golden regression
- quality benchmarks and larger multilingual sets

## CI Workflow Recommendation

Current CI runs `lint`, `typecheck`, broad `test`, integration, and build. It does not run fast E2E or Vespa E2E.

Recommended split in `.github/workflows/ci.yml`:

- `test-unit`: keep
- `test-integration-http`: keep or rename from current integration job
- `test-e2e-fast`: add `npm run test:e2e`
- `build`: depend on `lint`, `typecheck`, `test-unit`, `test-integration-http`, `test-e2e-fast`
- `test-e2e-vespa`: separate workflow, scheduled and manual dispatch

## Exit Criteria

Phase 1 complete when:

- `npm run test:e2e` is green
- every server-registered route has at least one full-server E2E
- fast E2E no longer encodes unrealistic quality expectations for in-memory backends

Phase 2 complete when:

- semantic/golden quality regression lives under Vespa-backed suites
- PR gate is stable
- nightly quality gate catches ranking regressions without blocking all routine app changes
