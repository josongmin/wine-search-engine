# Test Reinforcement Parallel Board

## Goal

Run the `P0` reinforcement work in parallel without merge-conflict chaos and without mixing contract cleanup, route-surface coverage, and quality migration in the same PRs.

Use this with:

- [docs/test-reinforcement-roadmap.md](/Users/songmin/wine-search-engine/docs/test-reinforcement-roadmap.md)
- [docs/test-reinforcement-p0-tickets.md](/Users/songmin/wine-search-engine/docs/test-reinforcement-p0-tickets.md)

## SOTA++ Operating Rules

- one PR should solve one failure class
- do not mix transport renames with ranking expectation changes
- do not mix in-memory harness work with Vespa quality migration
- fast E2E should optimize for determinism and signal density
- Vespa E2E should optimize for product-quality regression detection

## Squad Layout

### Squad A: Contract Cleanup

Mission:

- make fast E2E transport-accurate

Own:

- `P0-1`
- `P0-2`

Files:

- `test/e2e/helpers/`
- `test/e2e/infrastructure.test.ts`
- `test/e2e/response-invariants.test.ts`
- `test/e2e/edge-cases.test.ts`
- `test/e2e/search-api.test.ts`
- `test/e2e/schema-contract.test.ts`

Do not touch:

- `test/e2e/vespa/`
- watchlist and claude-tools route E2E additions
- mixed-query harness seeding unless blocked on helper shape

PR slices:

- PR A1: shared transport helper
- PR A2: infrastructure and invariant cleanup
- PR A3: edge-cases and search/interpret transport cleanup

Success signal:

- transport drift failures disappear from the fast suite

### Squad B: Route Surface Coverage

Mission:

- give every server route at least one true end-to-end path

Own:

- `P0-3`
- `P0-4`
- `P0-5`

Files:

- `test/e2e/batch-search-api.test.ts`
- `test/e2e/claude-tools-api.test.ts`
- `test/e2e/watchlist-api.test.ts`
- `test/e2e/server-protocol.test.ts`

Do not touch:

- Vespa suites
- ranking/golden assertions
- mixed-query quality expectations

PR slices:

- PR B1: batch-search E2E
- PR B2: claude-tools plus watchlist E2E
- PR B3: protocol and CORS E2E

Success signal:

- route catalog coverage is complete for the server-registered HTTP surface

### Squad C: Harness and Quality Separation

Mission:

- stop harness bugs from looking like product bugs
- move quality ownership to Vespa

Own:

- `P0-6`
- `P0-7`

Files:

- `test/e2e/helpers/test-server.ts`
- `test/integration/helpers/test-container.ts`
- `test/e2e/mixed-search.test.ts`
- `test/e2e/user-journeys.test.ts`
- `test/e2e/realistic-scenarios.test.ts`
- `test/e2e/golden-set.test.ts`
- `test/e2e/hard-scenarios.test.ts`
- `test/e2e/vespa/`

Do not touch:

- transport helper internals unless rebased on Squad A
- route-surface-only tests

PR slices:

- PR C1: mixed-query no-500 harness fix
- PR C2: reduce in-memory quality scope
- PR C3: Vespa ownership handoff scaffolding

Success signal:

- fast E2E stops failing on unrealistic in-memory relevance expectations

## Recommended Sequence

### Batch 1

Run in parallel:

- Squad A / PR A1
- Squad B / PR B1
- Squad C / PR C1

Why:

- these have the smallest overlap
- they unblock the rest of the stream work

### Batch 2

After A1 lands or stabilizes:

- Squad A / PR A2
- Squad B / PR B2
- Squad B / PR B3
- Squad C / PR C2

Why:

- all of these can consume the helper shape from A1

### Batch 3

After A2 and C2 land:

- Squad A / PR A3
- Squad C / PR C3
- repo-wide stabilization run for `P0-8`

Why:

- the suite shape is mostly fixed by then
- remaining failures should be high-signal

## Critical Path

The true critical path is:

1. transport helper exists
2. mixed-query 500 is eliminated or intentionally downgraded
3. unrealistic in-memory quality suites are reduced or moved
4. missing route-surface E2E lands
5. full `npm run test:e2e` goes green

## Merge-Conflict Risk Map

Low conflict:

- `test/e2e/batch-search-api.test.ts`
- `test/e2e/claude-tools-api.test.ts`
- `test/e2e/watchlist-api.test.ts`
- `test/e2e/server-protocol.test.ts`
- `test/e2e/mixed-search.test.ts`

Medium conflict:

- `test/e2e/helpers/`
- `test/e2e/edge-cases.test.ts`
- `test/e2e/infrastructure.test.ts`

High conflict:

- `test/e2e/user-journeys.test.ts`
- `test/e2e/realistic-scenarios.test.ts`
- `test/e2e/golden-set.test.ts`
- `test/e2e/hard-scenarios.test.ts`
- `test/e2e/helpers/test-server.ts`

Rule:

- only one active PR should own each high-conflict file group at a time

## Verification Matrix

### PR A1

Run:

- targeted helper-adopting tests
- `npm run test:e2e -- test/e2e/schema-contract.test.ts`

Expected:

- helper compiles
- no schema regressions introduced

### PR A2 and A3

Run:

- `npm run test:e2e`

Expected:

- camelCase drift failure count drops sharply

### PR B1 to B3

Run:

- targeted new E2E files
- one broad `npm run test:e2e` smoke after rebasing

Expected:

- new route-surface tests pass independently

### PR C1

Run:

- targeted mixed-query tests
- reproduce `"오푸스원 같은 와인"` through E2E

Expected:

- no unexpected `500`

### PR C2 and C3

Run:

- affected in-memory suites
- affected Vespa suite selection if touched

Expected:

- in-memory suite stops pretending to be a full quality benchmark

## Daily Checkpoint Format

Each squad should report:

- what landed
- what is blocked
- current fast E2E fail count
- whether failures are:
  - transport drift
  - harness bug
  - real product bug
  - moved-to-Vespa work

## Definition of P0 Success

- `npm run test:e2e` is green
- all routes registered in the server have true E2E coverage
- mixed-query fast E2E is fallback-safe and non-500
- in-memory E2E is contract-first, not quality-heavy
- Vespa is the explicit owner of golden and semantic quality regression
