# Test Reinforcement P0 Tickets

## Goal

Turn the roadmap into immediately executable work for the current repo.

Execution board:

- see [docs/test-reinforcement-parallel-board.md](/Users/songmin/wine-search-engine/docs/test-reinforcement-parallel-board.md) for squad ownership, PR slicing, and merge order

This document focuses only on `P0`:

- make fast in-memory E2E green
- close missing route-surface E2E gaps
- stop mixed-query 500s from polluting the suite
- remove in-memory quality assertions that belong in Vespa

## Baseline

- Date: 2026-04-06
- Current result: `npm run test:e2e` => `117 failed / 178 passed / 71 skipped`
- Main failure buckets:
  - snake_case transport drift in in-memory E2E
  - missing mixed-query harness data causing 500
  - aspirational ranking/quality assertions in in-memory suites
  - missing E2E coverage for registered routes

## Parallel Streams

### Stream 1: Fast E2E Contracts

Own:

- transport helper
- snake_case normalization
- duplicate invariant cleanup

Suggested branch:

- `codex/fast-e2e-contracts`

### Stream 2: Route Surface E2E

Own:

- batch search
- claude tools
- watchlist
- server protocol/CORS

Suggested branch:

- `codex/route-surface-e2e`

### Stream 3: Quality Separation

Own:

- mixed-query harness
- in-memory quality suite pruning
- handoff of quality expectations to Vespa

Suggested branch:

- `codex/quality-separation`

## Ticket P0-1

Title:

- Add a shared snake_case E2E response helper

Why:

- the same transport drift is repeated across multiple test files
- direct object indexing is causing brittle camelCase assumptions

Files:

- `test/e2e/helpers/`
- `test/e2e/search-api.test.ts`
- `test/e2e/schema-contract.test.ts`
- `src/interface/http/schemas/search-response.schema.ts`

Tasks:

- add a helper that parses `/v1/search` responses using the public HTTP schema
- expose small accessors for:
  - `engine_decision`
  - `decision_status`
  - `decision_snapshot`
  - `request_id`
  - `query_time_ms`
  - `entity_id`
  - `relevance_score`
  - `evidence_items`
- add equivalent helpers for interpret and resolve responses if reuse is meaningful
- make helper names transport-accurate, not domain-accurate

Definition of done:

- no new in-memory E2E test reads `engineDecision`, `requestId`, `queryTimeMs`, `entityId`, `relevanceScore`, `evidenceItems`, `rawQuery`, or `plannerVersion` directly from HTTP payloads

## Ticket P0-2

Title:

- Normalize the fast in-memory E2E suites to the public transport contract

Why:

- most current failures are not product regressions
- they are stale expectations against the serialized shape

Files:

- `test/e2e/infrastructure.test.ts`
- `test/e2e/response-invariants.test.ts`
- `test/e2e/edge-cases.test.ts`
- `test/e2e/user-journeys.test.ts`
- `test/e2e/realistic-scenarios.test.ts`
- `test/e2e/golden-set.test.ts`
- `test/e2e/hard-scenarios.test.ts`

Tasks:

- replace camelCase response field access with helper-based snake_case access
- update policy/security expectations where intended behavior is now `403`
- remove redundant envelope/invariant assertions already covered by `schema-contract` and `search-api`
- keep only protocol-safe assertions in in-memory suites

Definition of done:

- no failing assertion is caused by camelCase vs snake_case drift
- `test/e2e/search-api.test.ts`
- `test/e2e/schema-contract.test.ts`
- `test/e2e/infrastructure.test.ts`
- `test/e2e/edge-cases.test.ts`
  are transport-correct and stable

Depends on:

- `P0-1`

## Ticket P0-3

Title:

- Add missing full-server E2E for batch search

Why:

- `/v1/batch-search` is registered in the server but has no true E2E coverage

Files:

- `test/e2e/batch-search-api.test.ts`
- `src/interface/http/routes/batch-search.route.ts`
- `test/e2e/helpers/`

Tasks:

- cover `207 Multi-Status` happy path
- cover mixed success/failure result payload
- cover validation error `400`
- cover unsupported media type `415`
- cover `x-request-id` presence and correlation rules
- verify response body is serialized in snake_case

Definition of done:

- `/v1/batch-search` has at least one success-path E2E and one failure-path E2E through the full server

## Ticket P0-4

Title:

- Add missing full-server E2E for Claude tools and watchlist

Why:

- these routes exist in the server surface but are not protected by a proper end-to-end gate

Files:

- `test/e2e/claude-tools-api.test.ts`
- `test/e2e/watchlist-api.test.ts`
- `src/interface/http/routes/claude-tools.route.ts`
- `src/interface/http/routes/watchlist.route.ts`

Tasks:

- for Claude tools:
  - cover `GET /v1/claude-tools`
  - cover `POST /v1/claude-tools`
  - cover bad payload rejection
  - cover request-id/header expectations
- for watchlist:
  - cover create/get/delete/deliveries
  - cover not-found and validation paths
  - cover snake_case response shape
  - cover request-id/header expectations

Definition of done:

- every route under `/v1/claude-tools` and `/v1/watchlist*` has at least one success-path and one failure-path E2E

## Ticket P0-5

Title:

- Add server protocol E2E for CORS and OPTIONS

Why:

- protocol behavior is currently tested only indirectly
- preflight and origin handling are cross-cutting and easy to regress

Files:

- `test/e2e/server-protocol.test.ts`
- `src/interface/http/server.ts`
- `src/interface/http/routes/health.route.ts`

Tasks:

- cover `OPTIONS *` preflight
- cover `Access-Control-Allow-Origin` behavior in test/dev mode
- cover one health/readiness smoke through the real server

Definition of done:

- protocol behavior around `OPTIONS`, CORS, and basic health routes is protected by a small stable E2E suite

## Ticket P0-6

Title:

- Fix or isolate mixed-query failures in the in-memory harness

Why:

- `"오푸스원 같은 와인"` currently returns `500 INTERNAL_ERROR`
- this is a harness/data problem contaminating the fast suite

Files:

- `test/e2e/helpers/test-server.ts`
- `test/integration/helpers/test-container.ts`
- `src/domain/mixed/service/mixed-solver.ts`
- `test/e2e/mixed-search.test.ts`

Tasks:

- choose one of two paths:
  - seed `anchorResolver`, `similarRetrieval`, `candidateAttributes` in the in-memory test harness
  - or keep the harness minimal and assert graceful fallback instead of full mixed quality
- add a dedicated `mixed-search` suite with:
  - known anchor smoke case
  - unresolved anchor behavior
  - empty similar candidate behavior
  - no-500 guarantee

Definition of done:

- mixed queries no longer produce an unexpected `500` in fast E2E
- the suite clearly encodes whether in-memory mixed behavior is quality-accurate or only fallback-safe

## Ticket P0-7

Title:

- Remove in-memory quality assertions that belong in Vespa

Why:

- in-memory fixtures are too small and too synthetic for SOTA++ relevance claims
- golden and realistic ranking expectations should not block routine backend changes

Files:

- `test/e2e/golden-set.test.ts`
- `test/e2e/realistic-scenarios.test.ts`
- `test/e2e/user-journeys.test.ts`
- `test/e2e/hard-scenarios.test.ts`
- `test/e2e/vespa/`

Tasks:

- move golden-set intent to Vespa-backed suites
- reduce `user-journeys` to a small smoke suite or replace it with `inmemory-smoke-journeys`
- split `hard-scenarios` into:
  - fast failure-mode checks
  - Vespa quality checks
- leave clear migration comments or follow-up references where tests are moved

Definition of done:

- in-memory E2E no longer claims production-quality ranking beyond simple smoke expectations
- quality-sensitive assertions are either removed or explicitly handed off to Vespa suites

Depends on:

- `P0-2`
- `P0-6`

## Ticket P0-8

Title:

- Make `npm run test:e2e` green and stable

Why:

- this is the actual integration milestone for the whole P0 batch

Files:

- all files touched by `P0-1` through `P0-7`

Tasks:

- run `npm run test:e2e`
- fix remaining fast-suite failures
- keep fixes inside the intended scope and avoid drive-by refactors
- summarize any intentionally deferred failures that belong to Vespa or P1

Definition of done:

- `npm run test:e2e` passes locally

## Recommended Order

1. `P0-1`
2. `P0-2`
3. `P0-3`, `P0-4`, `P0-5` in parallel
4. `P0-6`
5. `P0-7`
6. `P0-8`

## Merge Strategy

- Merge Stream 1 first because all other streams benefit from shared helpers and transport consistency.
- Merge Stream 2 second because new route-surface tests should use the stabilized helper layer.
- Merge Stream 3 after rebasing on Stream 1 to avoid rewriting helper logic twice.

## P0 Exit Criteria

- `npm run test:e2e` passes
- every route in `src/interface/http/server.ts` has at least one end-to-end test
- mixed queries do not unexpectedly 500 in fast E2E
- in-memory E2E is focused on contract, protocol, and smoke behavior
- golden and semantic quality ownership is explicitly moved toward Vespa
